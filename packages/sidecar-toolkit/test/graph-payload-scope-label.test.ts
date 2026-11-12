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
});
