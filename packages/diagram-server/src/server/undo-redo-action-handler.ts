import { Action, RedoAction, UndoAction } from '@eclipse-glsp/protocol';
import { ActionHandler, CommandStack, ModelSubmissionHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';

/**
 * Graceful undo/redo handler for the webview's glspUndo / glspRedo actions.
 *
 * Durable undo for dialogram is owned by the VS Code document stack (fed by
 * {@link ReversibleWorkspaceEditCommand}.applyEdit), which survives the source-model reloads
 * that reset the in-memory GLSP command stack. When the webview's Cmd+Z dispatches a glspUndo
 * (or glspRedo) to the server *after* such a reset, the server command stack is empty — or a
 * post-reset submit can reject. The stock {@link import('@eclipse-glsp/server').UndoRedoActionHandler}
 * lets that condition surface in the client as a "Could not process action: 'glspUndo'" error toast.
 *
 * This handler drives the server command stack when it *can* (single, un-reloaded edits) but never
 * lets an empty stack or a post-reset failure escape as a client-facing error: it swallows the
 * condition, logs at debug, and returns no actions.
 */
@injectable()
export class WorkflowUndoRedoActionHandler implements ActionHandler {
    readonly actionKinds = [UndoAction.KIND, RedoAction.KIND];

    @inject(CommandStack)
    protected commandStack!: CommandStack;

    @inject(ModelSubmissionHandler)
    protected submissionHandler!: ModelSubmissionHandler;

    async execute(action: Action): Promise<Action[]> {
        try {
            if (UndoAction.is(action)) {
                if (this.commandStack.canUndo()) {
                    await this.commandStack.undo();
                    return this.submissionHandler.submitModel('undo');
                }
                this.logNoop('undo');
                return [];
            }
            if (RedoAction.is(action)) {
                if (this.commandStack.canRedo()) {
                    await this.commandStack.redo();
                    return this.submissionHandler.submitModel('redo');
                }
                this.logNoop('redo');
                return [];
            }
            return [];
        } catch (error) {
            // The host document undo stack owns durable undo; a failure here (e.g. an in-memory
            // command stack reset by a concurrent source reload) must not surface as a
            // "Could not process action" error toast in the diagram client.
            console.debug(
                `[WorkflowUndoRedoActionHandler] ${action.kind} ignored after command-stack reset:`,
                error
            );
            return [];
        }
    }

    private logNoop(kind: 'undo' | 'redo'): void {
        console.debug(
            `[WorkflowUndoRedoActionHandler] ${kind} requested but the server command stack was empty ` +
                '(the host document stack owns durable undo).'
        );
    }
}
