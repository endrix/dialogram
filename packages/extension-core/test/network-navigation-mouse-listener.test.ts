import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { buildCrossFileNavigationTarget } from '../../diagram-client/src/network-navigation-target';
import {
    GRAPH_SOURCE_URI_ARG,
    INSTANCE_PATH_ARG,
    ROOT_WORKFLOW_ARG,
    NAV_TRAIL_ARG
} from '../../diagram-client/src/network-navigation-target';

vi.mock('@eclipse-glsp/client', () => ({
    EditorContextService: class {},
    Ranked: class {},
    TYPES: {
        IActionDispatcher: Symbol('IActionDispatcher')
    }
}));

vi.mock('../../diagram-client/src/navigation-ui', () => ({
    WorkflowNavigationUi: class {},
    navigatesInPlace: () => (globalThis as any).diagramIdentifier?.clientBehavior?.nestedNavigation === 'in-place'
}));

vi.mock('@eclipse-glsp/sprotty', () => ({
    MouseListener: class {},
    NavigateToExternalTargetAction: {
        create: (target: unknown) => ({ kind: 'navigateToExternalTarget', target })
    },
    RequestModelAction: {
        create: (payload: { requestId: string; options: Record<string, unknown> }) => ({ kind: 'requestModel', ...payload }),
        is: (action: unknown) => (action as any)?.kind === 'requestModel'
    }
}));

import { RequestModelAction } from '@eclipse-glsp/sprotty';
import { WorkflowNetworkNavigationMouseListener } from '../../diagram-client/src/network-navigation-mouse-listener';

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
    delete (globalThis as any).__calDiagramContext;
});

describe('buildCrossFileNavigationTarget', () => {
    it('keeps cross-file CalPy drill-down on the referenced file and passes graph fallback context', () => {
        const target = buildCrossFileNavigationTarget({
            referencedUri: 'file:///workspace/examples/python/qwen/layer.py',
            targetNetworkName: 'decoder_layer',
            serializedTrail: '[{"sourceUri":"file:///workspace/examples/python/qwen/model.py","workflowName":"qwen35_model"}]',
            useGraphSourceNavigation: true,
            currentSourceUri: 'file:///workspace/examples/python/qwen/model.py',
            rootWorkflowName: 'qwen35_model',
            instancePath: ['decoder_block']
        });

        expect(target.uri).toBe('file:///workspace/examples/python/qwen/layer.py');
        expect(target.args['cal:networkName']).toBe('decoder_layer');
        expect(target.args['cal:graphSourceUri']).toBe('file:///workspace/examples/python/qwen/model.py');
        expect(target.args['cal:rootWorkflow']).toBe('qwen35_model');
        expect(target.args['cal:instancePath']).toEqual(['decoder_block']);
    });
});

describe('WorkflowNetworkNavigationMouseListener', () => {
    it('same-file CalPy drill-down includes graph fallback args for nested instance navigation', () => {
        const listener = new WorkflowNetworkNavigationMouseListener();
        const sourceUri = 'file:///workspace/examples/python/qwen/model.py';
        const navTrail = [
            { sourceUri, workflowName: 'qwen35_model' },
            { sourceUri, workflowName: 'decoder_block', workflowInstanceName: 'decoder_block' }
        ];

        (listener as any).editorContext = {
            sourceUri,
            diagramType: 'workflow-diagram'
        };
        (listener as any).workflowNavUi = {
            buildNavigationTrail: () => navTrail,
            noteNavigate: () => {}
        };

        (globalThis as any).diagramIdentifier = {
            clientBehavior: { graphSourceNavigation: true }
        };
        (globalThis as any).__calDiagramContext = {
            workflowName: 'decoder_block'
        };

        const target = {
            type: WorkflowDiagramTypes.NODE_NETWORK,
            args: {
                [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
                [WorkflowDiagramMetadata.REFERENCED_URI]: sourceUri,
                [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'decoder_block',
                [WorkflowDiagramMetadata.ENTITY_TYPE]: 'decoder_block',
                'wf:entityInstanceName': 'decoder_block'
            }
        } as any;

        const actions = listener.doubleClick(target, {} as MouseEvent);

        expect(actions).toHaveLength(1);
        expect(RequestModelAction.is(actions[0] as any)).toBe(true);
        const request = actions[0] as any;
        expect(request.options.sourceUri).toBe(sourceUri);
        expect(request.options.networkName).toBe('decoder_block');
        expect(request.options[NAV_TRAIL_ARG]).toBe(JSON.stringify(navTrail));
        expect(request.options[GRAPH_SOURCE_URI_ARG]).toBe(sourceUri);
        expect(request.options[ROOT_WORKFLOW_ARG]).toBe('qwen35_model');
        expect(request.options[INSTANCE_PATH_ARG]).toEqual(['decoder_block']);
    });

    it('keeps same-file self-navigation as no-op when there is no CalPy instance target', () => {
        const listener = new WorkflowNetworkNavigationMouseListener();
        const sourceUri = 'file:///workspace/examples/python/qwen/decoder_block.py';
        const navTrail = [{ sourceUri, workflowName: 'decoder_block' }];

        (listener as any).editorContext = {
            sourceUri,
            diagramType: 'workflow-diagram'
        };
        (listener as any).workflowNavUi = {
            buildNavigationTrail: () => navTrail,
            noteNavigate: () => {}
        };

        (globalThis as any).diagramIdentifier = {
            clientBehavior: { graphSourceNavigation: true }
        };
        (globalThis as any).__calDiagramContext = {
            workflowName: 'decoder_block'
        };

        const target = {
            type: WorkflowDiagramTypes.NODE_NETWORK,
            args: {
                [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
                [WorkflowDiagramMetadata.REFERENCED_URI]: sourceUri,
                [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'decoder_block',
                [WorkflowDiagramMetadata.ENTITY_TYPE]: 'decoder_block'
            }
        } as any;

        const actions = listener.doubleClick(target, {} as MouseEvent);
        expect(actions).toEqual([]);
    });
});

/**
 * A nested workflow defined in another file: a new editor by default, a view in
 * this editor when the product navigates in place.
 */
describe('cross-file drill-down', () => {
    const root = 'file:///workspace/top.py';
    const child = 'file:///workspace/layers/block.py';
    const navTrail = [
        { sourceUri: root, workflowName: 'top' },
        { sourceUri: child, workflowName: 'block', workflowInstanceName: 'b2' }
    ];

    function drillDown(nestedNavigation?: string) {
        const listener = new WorkflowNetworkNavigationMouseListener();
        (listener as any).editorContext = { sourceUri: root, diagramType: 'workflow-diagram' };
        (listener as any).workflowNavUi = { buildNavigationTrail: () => navTrail, noteNavigate: () => {} };
        (globalThis as any).diagramIdentifier = {
            clientBehavior: nestedNavigation ? { nestedNavigation } : {}
        };
        (globalThis as any).__calDiagramContext = { workflowName: 'top' };
        return listener.doubleClick({
            type: WorkflowDiagramTypes.NODE_NETWORK,
            args: {
                [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
                [WorkflowDiagramMetadata.REFERENCED_URI]: child,
                [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'block',
                'wf:entityInstanceName': 'b2'
            }
        } as any, {} as MouseEvent);
    }

    it('opens a new editor by default', () => {
        const actions = drillDown();
        expect(actions).toHaveLength(1);
        expect((actions[0] as any).kind).toBe('navigateToExternalTarget');
    });

    it('shows the nested workflow in this editor when navigating in place', () => {
        const actions = drillDown('in-place');

        expect(actions).toHaveLength(1);
        expect(RequestModelAction.is(actions[0] as any)).toBe(true);
        const request = actions[0] as any;
        // The defining file is what is rendered; the trail keeps the root first.
        expect(request.options.sourceUri).toBe(child);
        expect(request.options.networkName).toBe('block');
        expect(JSON.parse(request.options[NAV_TRAIL_ARG])[0]).toEqual({ sourceUri: root, workflowName: 'top' });
    });
});
