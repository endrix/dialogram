import { describe, expect, it } from 'vitest';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

// The payload->doc and failure-doc transforms these pin now live on the toolkit model source;
// they used to be called directly on WorkflowSourceModelStorage before the stack moved here.
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
    acceptedOperationPrefixes: ['wfpy', 'calpy'],
    graphAcquisition: 'cli-plan',
    cliGraphArgs: (file: string) => ['plan', file, '--format', 'graph', '--best-effort']
};

describe('WorkflowSourceModelStorage graph payload root parameters', () => {
    it('preserves graph-level parameters when converting sidecar payloads', () => {
        const storage = new SidecarModelSource(CFG);

        const doc = storage.graphPayloadToDoc({
            network: 'decoder',
            factoryName: 'make_decoder',
            metadata: {
                profile: 'mpeg4'
            },
            parameters: [
                { name: 'ACCODED', value: '3' },
                { name: 'ACPRED', value: '1' }
            ],
            nodes: [],
            edges: []
        }) as any;

        expect(doc.graph.meta).toEqual({
            profile: 'mpeg4',
            factoryName: 'make_decoder',
            parameters: [
                { name: 'ACCODED', value: '3' },
                { name: 'ACPRED', value: '1' }
            ]
        });
    });

    it('ignores primitive parameter payloads', () => {
        const storage = new SidecarModelSource(CFG);

        const doc = storage.graphPayloadToDoc({
            network: 'decoder',
            parameters: 'not-valid',
            nodes: [],
            edges: []
        }) as any;

        expect(doc.graph.meta).toBeUndefined();
    });

    it('normalizes wfpy instance kwargs and nested workflow child parameters into node metadata', () => {
        const storage = new SidecarModelSource(CFG);

        const doc = storage.graphPayloadToDoc({
            workflow: 'Main',
            nodes: [
                {
                    id: 'worker',
                    kind: 'task',
                    kwargs: {
                        scale: '7',
                        mode: '"fast"'
                    },
                    ports: []
                },
                {
                    id: 'child_wf',
                    kind: 'task',
                    ref: 'Child',
                    ports: []
                }
            ],
            edges: [],
            children: [
                {
                    instance: 'child_wf',
                    workflow: 'Child',
                    graph: {
                        workflow: 'Child',
                        factoryName: 'make_child',
                        parameters: [
                            { name: 'width', value: '16', type: 'int' },
                            { name: 'height', value: '9', type: 'int' }
                        ],
                        nodes: [],
                        edges: []
                    }
                }
            ]
        }) as any;

        const worker = doc.graph.nodes.find((node: any) => node.id === 'worker');
        const childWorkflow = doc.graph.nodes.find((node: any) => node.id === 'child_wf');

        expect(worker.meta.parameters).toEqual([
            { name: 'scale', value: '7' },
            { name: 'mode', value: '"fast"' }
        ]);
        expect(worker.meta.definitionParams).toEqual([
            { name: 'scale', defaultValue: '7' },
            { name: 'mode', defaultValue: '"fast"' }
        ]);

        expect(childWorkflow.meta.parameters).toEqual([
            { name: 'width', value: '16', type: 'int' },
            { name: 'height', value: '9', type: 'int' }
        ]);
        expect(childWorkflow.meta.definitionParams).toEqual([
            { name: 'width', type: 'int', defaultValue: '16' },
            { name: 'height', type: 'int', defaultValue: '9' }
        ]);
        expect(childWorkflow.meta.factoryName).toBe('make_child');
        expect(childWorkflow.meta.referencedEntityName).toBe('Child');
    });

    it('builds a partial empty graph document when graph export fails', () => {
        const storage = new SidecarModelSource(CFG);
        const doc = storage.createGraphExportFailureDoc(
            '/tmp/broken.py',
            { networkName: 'BrokenFlow' },
            'CalPy sidecar graph export failed: syntax error'
        ) as any;

        expect(doc.partial).toBe(true);
        expect(doc.errors).toEqual([
            { message: 'CalPy sidecar graph export failed: syntax error', file: '/tmp/broken.py' }
        ]);
        expect(doc.graph).toEqual({
            id: 'wf:BrokenFlow',
            nodes: [
                {
                    id: '__graph_export_error__',
                    kind: 'task',
                    label: 'Graph export failed',
                    type: 'LoadError',
                    scope: '',
                    ports: [],
                    meta: {
                        isErrored: true,
                        errorMessage: 'CalPy sidecar graph export failed: syntax error'
                    }
                }
            ],
            edges: [],
            subgraphs: []
        });
    });

    it('preserves partial graph diagnostics from sidecar payloads', () => {
        const storage = new SidecarModelSource(CFG);

        const doc = storage.graphPayloadToDoc({
            network: 'broken',
            partial: true,
            errors: [
                { message: 'syntax error', file: '/tmp/broken.py', line: 4, column: 1 }
            ],
            nodes: [],
            edges: [],
            scopes: []
        }) as any;

        expect(doc.partial).toBe(true);
        expect(doc.errors).toEqual([
            { message: 'syntax error', file: '/tmp/broken.py', line: 4, column: 1 }
        ]);
        expect(doc.graph.id).toBe('wf:broken');
    });
});