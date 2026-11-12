import { describe, expect, it } from 'vitest';
import { SidecarModelSource } from '../src/server/sidecar-model-source';
import { type SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const CFG: SidecarRuntimeConfig = {
    settingsNamespace: 'wfLang',
    sidecarOperationPrefix: 'wfpy',
    sidecarCommandSettingKey: 'wfpySidecarCommand',
    sidecarCommandDefault: 'wfpy-sidecar',
    cliCommandSettingKey: 'wfpyCommand',
    cliCommandDefault: 'wfpy',
    cliPythonModule: undefined,
    operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
    ...NEUTRAL_CREATE_NODE_CONFIG,
    acceptedOperationPrefixes: ['wfpy'],
    graphAcquisition: 'sidecar-export'
};

describe('graph payload scopes', () => {
    it('passes a scope\'s label through to the document, an empty one included', () => {
        const doc = new SidecarModelSource(CFG).graphPayloadToDoc({
            network: 'top',
            nodes: [],
            edges: [],
            scopes: [
                { id: 'scope:root', kind: 'network' },
                { id: 'scope:state:run', kind: 'group', label: 'run', nodes: ['n:a'] },
                { id: 'scope:state:', kind: 'group', label: '' },
                { id: 'scope:odd', kind: 'group', label: 42 }
            ]
        }) as any;
        const byId = new Map<string, any>(doc.graph.subgraphs.map((scope: any) => [scope.id, scope]));
        expect(byId.get('scope:state:run')).toMatchObject({ kind: 'group', label: 'run', nodes: ['n:a'] });
        // A frame with no title: the empty label is the producer's word, not a missing one.
        expect(byId.get('scope:state:').label).toBe('');
        expect(byId.get('scope:root').label).toBeUndefined();
        // A label of the wrong type is dropped, not passed along.
        expect(byId.get('scope:odd').label).toBeUndefined();
    });

    it('passes a scope\'s pin through to the document', () => {
        const doc = new SidecarModelSource(CFG).graphPayloadToDoc({
            network: 'top',
            nodes: [],
            edges: [],
            scopes: [
                { id: 'scope:variables', kind: 'group', label: 'state', pin: 'top' },
                { id: 'scope:state:run', kind: 'group', label: 'run' },
                { id: 'scope:odd', kind: 'group', pin: 1 }
            ]
        }) as any;
        const byId = new Map<string, any>(doc.graph.subgraphs.map((scope: any) => [scope.id, scope]));
        expect(byId.get('scope:variables').pin).toBe('top');
        expect(byId.get('scope:state:run').pin).toBeUndefined();
        expect(byId.get('scope:odd').pin).toBeUndefined();
    });
});

describe('graph payload links drawn on selection', () => {
    it('keeps an edge\'s mark and what it says, its ends naming nodes, and a node\'s `sameAs`', () => {
        const doc = new SidecarModelSource(CFG).graphPayloadToDoc({
            network: 'top',
            nodes: [
                { id: 'a:run:step', kind: 'action', label: 'step', scope: 'scope:root', ports: [], metadata: { sameAs: 'step' } },
                { id: 'v:count', kind: 'state', label: 'count', scope: 'scope:root', ports: [] }
            ],
            edges: [{
                id: 'l:write',
                // An end names a node: there is no port for it.
                from: { nodeId: 'a:run:step', portId: 'a:run:step' },
                to: { nodeId: 'v:count', portId: 'v:count' },
                scope: 'scope:root',
                metadata: { onSelection: true, role: 'write', label: '×1', bidirectional: true }
            }],
            scopes: [{ id: 'scope:root', kind: 'network' }]
        }) as any;
        expect(doc.graph.edges).toEqual([expect.objectContaining({
            id: 'l:write',
            from: 'a:run:step',
            to: 'v:count',
            meta: { onSelection: true, role: 'write', label: '×1', bidirectional: true }
        })]);
        const step = doc.graph.nodes.find((node: any) => node.id === 'a:run:step');
        expect(step.meta.sameAs).toBe('step');
    });
});
