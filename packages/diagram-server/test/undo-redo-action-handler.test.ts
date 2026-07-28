import { UndoAction, RedoAction } from '@eclipse-glsp/protocol';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowUndoRedoActionHandler } from '../src/server/undo-redo-action-handler';

function makeHandler(commandStack: any, submissionHandler: any): WorkflowUndoRedoActionHandler {
    const handler = new WorkflowUndoRedoActionHandler();
    (handler as any).commandStack = commandStack;
    (handler as any).submissionHandler = submissionHandler;
    return handler;
}

describe('WorkflowUndoRedoActionHandler', () => {
    it('drives the server command stack for a normal undo', async () => {
        const undo = vi.fn(async () => {});
        const submit = vi.fn(async () => [{ kind: 'setModel' }]);
        const handler = makeHandler(
            { canUndo: () => true, undo, canRedo: () => false, redo: vi.fn() },
            { submitModel: submit }
        );

        const result = await handler.execute(UndoAction.create());

        expect(undo).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledWith('undo');
        expect(result).toEqual([{ kind: 'setModel' }]);
    });

    it('returns no actions (no error) when the server stack was reset and cannot undo', async () => {
        const submit = vi.fn(async () => [{ kind: 'setModel' }]);
        const handler = makeHandler(
            { canUndo: () => false, undo: vi.fn(), canRedo: () => false, redo: vi.fn() },
            { submitModel: submit }
        );

        const result = await handler.execute(UndoAction.create());

        expect(result).toEqual([]);
        expect(submit).not.toHaveBeenCalled();
    });

    it('swallows a post-reset failure instead of surfacing "Could not process action"', async () => {
        // A concurrent source reload can leave the in-memory stack in a state where
        // undo() rejects. The stock handler would let this propagate to the client as an
        // error toast; this handler must resolve with no actions.
        const undo = vi.fn(async () => {
            throw new Error('command stack was reset');
        });
        const handler = makeHandler(
            { canUndo: () => true, undo, canRedo: () => false, redo: vi.fn() },
            { submitModel: vi.fn(async () => []) }
        );

        await expect(handler.execute(UndoAction.create())).resolves.toEqual([]);
    });

    it('drives the server command stack for a normal redo', async () => {
        const redo = vi.fn(async () => {});
        const submit = vi.fn(async () => [{ kind: 'setModel' }]);
        const handler = makeHandler(
            { canUndo: () => false, undo: vi.fn(), canRedo: () => true, redo },
            { submitModel: submit }
        );

        const result = await handler.execute(RedoAction.create());

        expect(redo).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledWith('redo');
        expect(result).toEqual([{ kind: 'setModel' }]);
    });

    it('returns no actions (no error) when the server stack cannot redo', async () => {
        const submit = vi.fn(async () => []);
        const handler = makeHandler(
            { canUndo: () => false, undo: vi.fn(), canRedo: () => false, redo: vi.fn() },
            { submitModel: submit }
        );

        await expect(handler.execute(RedoAction.create())).resolves.toEqual([]);
        expect(submit).not.toHaveBeenCalled();
    });

    it('registers for the glspUndo and glspRedo action kinds', () => {
        const handler = makeHandler({}, {});
        expect(handler.actionKinds).toEqual([UndoAction.KIND, RedoAction.KIND]);
    });
});
