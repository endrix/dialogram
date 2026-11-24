/**
 * Stepping into a workflow instance answered by a past run keeps that run on
 * the crumb it adds (`recordedRun`): the server draws the view, and every view
 * under it, from that run (recorded-run.ts). The breadcrumb's stack keeps it,
 * so a step further down still says it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowNetworkNavigationMouseListener } from '../src/network-navigation-mouse-listener';
import { WorkflowNavigationUi } from '../src/navigation-ui';

const PARENT = 'file:///w/inst_parent.py';
const CHILD = 'file:///w/inst_child.py';

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
    delete (globalThis as any).__calDiagramContext;
});

function instanceNode(args: Record<string, unknown>): any {
    return {
        type: WorkflowDiagramTypes.NODE_NETWORK,
        args: {
            [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
            [WorkflowDiagramMetadata.REFERENCED_URI]: CHILD,
            [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'counted',
            'wf:entityInstanceName': 'c',
            ...args
        }
    };
}

/** Double-click `node` in the parent's view, navigating in place: the trail the request carries. */
function stepInto(node: any): { trail: any[]; navUi: WorkflowNavigationUi } {
    (globalThis as any).diagramIdentifier = { clientBehavior: { nestedNavigation: 'in-place' } };
    (globalThis as any).__calDiagramContext = { workflowName: 'parent' };
    const editorContext: any = { sourceUri: PARENT, diagramType: 'cal-network-diagram' };
    const navUi = new WorkflowNavigationUi({ dispatch: vi.fn() } as any, editorContext);
    const listener = new WorkflowNetworkNavigationMouseListener();
    (listener as any).editorContext = editorContext;
    (listener as any).workflowNavUi = navUi;
    const actions = listener.doubleClick(node, {} as MouseEvent) as any[];
    const request = actions.find(action => action?.kind === 'requestModel');
    return { trail: JSON.parse(request.options['wf:navTrail']), navUi };
}

describe('stepping into a workflow instance answered by a past run', () => {
    it('puts the run on the crumb it adds', () => {
        const { trail } = stepInto(instanceNode({ [WorkflowDiagramMetadata.RECORDED_RUN]: 'wf-out/r1' }));
        expect(trail).toEqual([
            { sourceUri: PARENT, workflowName: 'parent' },
            { sourceUri: CHILD, workflowName: 'counted', workflowInstanceName: 'c', recordedRun: 'wf-out/r1' }
        ]);
    });

    it('keeps it in the breadcrumb, for the views further down', () => {
        const { navUi } = stepInto(instanceNode({ [WorkflowDiagramMetadata.RECORDED_RUN]: 'wf-out/r1' }));
        const below = navUi.buildNavigationTrail(CHILD, CHILD, 'deeper', 'inner');
        expect(below[1]).toMatchObject({ workflowInstanceName: 'c', recordedRun: 'wf-out/r1' });
        expect(below[2]).toEqual({ sourceUri: CHILD, workflowName: 'deeper', workflowInstanceName: 'inner' });
    });

    it('puts it on the crumb of a view of the instance opened from the parent', () => {
        (globalThis as any).__calDiagramContext = { workflowName: 'parent' };
        const navUi = new WorkflowNavigationUi({ dispatch: vi.fn() } as any, { sourceUri: PARENT, diagramType: 'cal-network-diagram' } as any);
        const request: any = navUi.requestView(CHILD, 'counted', 'c', 'synth', 'Synthesis', 'instance', 'wf-out/r1');
        const trail = JSON.parse(request.options['wf:navTrail']);
        expect(trail[trail.length - 1]).toMatchObject({ workflowInstanceName: 'c', view: 'synth', recordedRun: 'wf-out/r1' });
    });

    it('adds nothing for a workflow that runs with its parent', () => {
        const { trail } = stepInto(instanceNode({}));
        expect(trail[1]).not.toHaveProperty('recordedRun');
    });
});
