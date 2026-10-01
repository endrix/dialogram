/**
 * "Rerun from Here" on a node: resume the run the diagram shows just before
 * the node's last firing, so it fires again. The handler hands the run driver
 * the run and the node; the driver finds the step in the run's trace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VscodeUi } from '../src/vscode-ui';
import { WorkflowRerunFromHereActionHandler } from '../src/editing-action-handlers';

function setUp(context: unknown, resumeAtStep: boolean) {
    const executeCommand = vi.fn(async () => undefined);
    (VscodeUi as any)._instance = { executeCommand };
    (globalThis as any).__calDiagramContext = context;
    (globalThis as any).diagramIdentifier = {
        commandIds: { runWorkflow: 'product.runWorkflow' },
        clientBehavior: { resumeAtStep }
    };
    return executeCommand;
}

afterEach(() => {
    (VscodeUi as any)._instance = undefined;
    delete (globalThis as any).__calDiagramContext;
    delete (globalThis as any).diagramIdentifier;
});

const shown = { sourceUri: 'file:///w/flow.py', workflowName: 'flow', runDir: '/w/wf-out/first' };

describe('Rerun from Here', () => {
    it('resumes the shown run before the node’s last firing', () => {
        const executeCommand = setUp(shown, true);

        new WorkflowRerunFromHereActionHandler().handle({ kind: 'dialogram.rerunFromHere', entityName: 'review' } as any);

        expect(executeCommand).toHaveBeenCalledWith('product.runWorkflow', [{
            sourceUri: 'file:///w/flow.py',
            workflowName: 'flow',
            resumeFrom: '/w/wf-out/first',
            resumeAtActor: 'review'
        }]);
    });

    it('does nothing without a resumable run, or a product that can resume', () => {
        const noRun = setUp({ ...shown, runDir: undefined }, true);
        new WorkflowRerunFromHereActionHandler().handle({ kind: 'dialogram.rerunFromHere', entityName: 'review' } as any);
        expect(noRun).not.toHaveBeenCalled();

        const noProduct = setUp(shown, false);
        new WorkflowRerunFromHereActionHandler().handle({ kind: 'dialogram.rerunFromHere', entityName: 'review' } as any);
        expect(noProduct).not.toHaveBeenCalled();
    });
});
