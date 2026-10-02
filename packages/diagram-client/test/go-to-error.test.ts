/**
 * "Go to Error" on the client: open the view where the run failed, then select
 * the node that failed once that view has loaded.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowGoToErrorActionHandler } from '../src/editing-action-handlers';
import { FocusAfterLoadService } from '../src/focus-after-load';

const trail = [
    { sourceUri: 'file:///w/top.py', workflowName: 'top' },
    { sourceUri: 'file:///w/mid.py', workflowName: 'middle', workflowInstanceName: 'm' }
];

describe('Go to Error', () => {
    it('opens the failure’s view at its trail and waits to select the node', () => {
        const handler: any = new WorkflowGoToErrorActionHandler();
        const dispatch = vi.fn();
        const focusWhenLoaded = vi.fn();
        handler.actionDispatcher = { dispatch };
        handler.editorContext = { diagramType: 'workflow-diagram' };
        handler.focusAfterLoad = { focusWhenLoaded };

        handler.handle({ kind: 'dialogram.goToError', trail, nodeName: 'x' });

        expect(focusWhenLoaded).toHaveBeenCalledWith('x');
        const request = dispatch.mock.calls[0][0];
        expect(request.options.sourceUri).toBe('file:///w/mid.py');
        expect(request.options.networkName).toBe('middle');
        expect(JSON.parse(request.options['wf:navTrail'])).toEqual(trail);
    });
});

describe('selecting a node once its view loads', () => {
    const view = (...names: string[]) => ({
        id: 'root',
        children: names.map(name => ({ id: `node-${name}`, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: name } }))
    });

    it('waits for the view that has it, then selects and centers it once', async () => {
        const service: any = new FocusAfterLoadService();
        const dispatch = vi.fn();
        service.dispatcher = { dispatch };

        service.focusWhenLoaded('x');
        service.modelRootChanged(view('a', 'b')); // the view being left
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(dispatch).not.toHaveBeenCalled();

        service.modelRootChanged(view('x', 'y'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(dispatch.mock.calls.map(c => c[0].kind)).toEqual(['elementSelected', 'center']);
        expect(dispatch.mock.calls[0][0].selectedElementsIDs).toEqual(['node-x']);

        dispatch.mockClear();
        service.modelRootChanged(view('x'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(dispatch).not.toHaveBeenCalled();
    });
});
