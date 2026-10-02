/**
 * Navigating a hierarchy in place: one editor, anchored to its root.
 *
 * Whatever view is shown -- a nested workflow, in any file -- the editor's
 * root is what runs, what a resume resumes, and what "Rerun from Here" reruns
 * in. A nested workflow can still be opened as a root of its own, on purpose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VscodeUi } from '../src/vscode-ui';
import { navigatesInPlace, rerunActorFor, rootOfStack } from '../src/navigation-ui';
import {
    WorkflowOpenInOwnEditorActionHandler,
    WorkflowRerunFromHereActionHandler
} from '../src/editing-action-handlers';

const TOP = 'file:///w/top.py';
const CHILD = 'file:///w/layers/block.py';
const stack = [
    { sourceUri: TOP, workflowName: 'top' },
    { sourceUri: CHILD, workflowName: 'block', workflowInstanceName: 'b2' },
    { sourceUri: CHILD, workflowName: 'leaf', workflowInstanceName: 'l1' }
];

afterEach(() => {
    (VscodeUi as any)._instance = undefined;
    delete (globalThis as any).diagramIdentifier;
    delete (globalThis as any).__calDiagramContext;
});

describe('whether the editor navigates in place', () => {
    it('is the product’s choice, off by default', () => {
        expect(navigatesInPlace()).toBe(false);
        (globalThis as any).diagramIdentifier = { clientBehavior: { nestedNavigation: 'in-place' } };
        expect(navigatesInPlace()).toBe(true);
    });
});

describe('the root of an editor’s hierarchy', () => {
    const shown = { sourceUri: CHILD, workflowName: 'leaf' };

    it('is the first crumb, navigating in place', () => {
        expect(rootOfStack(stack, TOP, true, shown)).toEqual({ sourceUri: TOP, workflowName: 'top' });
    });

    it('is the first crumb in the editor’s own file otherwise', () => {
        // An editor opened on block.py from top.py carries top.py's trail: its
        // own top is the first crumb in block.py.
        expect(rootOfStack(stack, CHILD, false, shown)).toEqual({ sourceUri: CHILD, workflowName: 'block' });
    });

    it('is the view when there is no stack', () => {
        expect(rootOfStack([], TOP, true, shown)).toEqual(shown);
    });
});

describe('what "Rerun from Here" reruns', () => {
    it('is the node itself at the root’s level', () => {
        expect(rerunActorFor('review', [{ sourceUri: TOP, workflowName: 'top' } as any])).toBe('review');
    });

    it('is the root-level instance a nested view is inside', () => {
        expect(rerunActorFor('leafNode', stack)).toBe('b2');
    });

    it('resumes the root’s run from a nested view', () => {
        const executeCommand = vi.fn(async () => undefined);
        (VscodeUi as any)._instance = { executeCommand };
        (globalThis as any).diagramIdentifier = {
            commandIds: { runWorkflow: 'product.runWorkflow' },
            clientBehavior: { resumeAtStep: true }
        };
        (globalThis as any).__calDiagramContext = {
            sourceUri: CHILD,
            workflowName: 'leaf',
            runDir: '/w/wf-out/r1',
            rootSourceUri: TOP,
            rootWorkflowName: 'top',
            trail: stack
        };

        new WorkflowRerunFromHereActionHandler().handle({ kind: 'dialogram.rerunFromHere', entityName: 'leafNode' } as any);

        expect(executeCommand).toHaveBeenCalledWith('product.runWorkflow', [{
            sourceUri: TOP,
            workflowName: 'top',
            resumeFrom: '/w/wf-out/r1',
            resumeAtActor: 'b2'
        }]);
    });
});

describe('Open in Its Own Editor', () => {
    it('opens the defining file as a root of its own: no trail goes with it', () => {
        const handler = new WorkflowOpenInOwnEditorActionHandler();
        const dispatch = vi.fn();
        (handler as any).actionDispatcher = { dispatch };

        handler.handle({ kind: 'dialogram.openInOwnEditor', uri: CHILD, workflowName: 'block' } as any);

        const navigate = dispatch.mock.calls[0][0];
        expect(navigate.uri).toBe(CHILD);
        expect(navigate.args).toEqual({ 'cal:openDiagram': true, 'cal:networkName': 'block' });
    });
});
