import { RedoAction, UndoAction } from '@eclipse-glsp/protocol';
import {
    CommandStack,
    DefaultCommandStack,
    Logger,
    ModelSubmissionHandler,
    NullLogger,
    UndoRedoActionHandler
} from '@eclipse-glsp/server';
import { Container, injectable } from 'inversify';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowUndoRedoActionHandler } from '../src/server/undo-redo-action-handler';

/**
 * Regression characterization (issue: after the reversible-edit/undo fixes, webview Cmd+Z did
 * NOTHING — no undo, no warning). Root cause: the handler had been *reimplemented* instead of
 * reusing the stock dispatch, so a glspUndo no longer reached the topmost command's undo.
 *
 * This drives a glspUndo, resolved through inversify against the REAL DefaultCommandStack, and
 * asserts the pushed command's undo() runs — exactly the seam that invokes
 * ReversibleWorkspaceEditCommand.undo in production. It is RED against a reimplemented handler
 * that shadows the stock dispatch and GREEN once the handler extends the stock one.
 */
describe('WorkflowUndoRedoActionHandler dispatch (real command stack)', () => {
    function buildContainer() {
        const container = new Container();
        container.bind(Logger).to(NullLogger).inSingletonScope();
        container.bind(CommandStack).to(DefaultCommandStack).inSingletonScope();

        @injectable()
        class FakeSubmissionHandler {
            submitModel = vi.fn(async () => [{ kind: 'setModel' }]);
        }
        container.bind(ModelSubmissionHandler).to(FakeSubmissionHandler as any).inSingletonScope();
        container.bind(WorkflowUndoRedoActionHandler).toSelf().inSingletonScope();
        return container;
    }

    it('reuses the stock undo/redo dispatch (does not reimplement it)', () => {
        const handler = buildContainer().get(WorkflowUndoRedoActionHandler);
        expect(handler).toBeInstanceOf(UndoRedoActionHandler);
        expect(handler.actionKinds).toEqual([UndoAction.KIND, RedoAction.KIND]);
    });

    it('invokes the topmost command undo when a glspUndo is dispatched', async () => {
        const container = buildContainer();
        const stack = container.get<DefaultCommandStack>(CommandStack as any);

        const undo = vi.fn(async () => {});
        await stack.execute({ execute: async () => {}, undo, canUndo: () => true } as any);
        expect(stack.canUndo()).toBe(true);

        const handler = container.get(WorkflowUndoRedoActionHandler);
        const result = await handler.execute(UndoAction.create());

        expect(undo).toHaveBeenCalledOnce();
        expect(result).toEqual([{ kind: 'setModel' }]);
    });

    it('is a silent no-op (no throw, no actions) when the stack is genuinely empty', async () => {
        const handler = buildContainer().get(WorkflowUndoRedoActionHandler);
        await expect(handler.execute(UndoAction.create())).resolves.toEqual([]);
    });
});
