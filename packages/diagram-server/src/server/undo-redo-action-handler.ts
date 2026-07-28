import { Action } from '@eclipse-glsp/protocol';
import { UndoRedoActionHandler } from '@eclipse-glsp/server';
import { injectable } from 'inversify';

/**
 * Undo/redo handler for the webview's glspUndo / glspRedo actions.
 *
 * It extends the stock {@link UndoRedoActionHandler} so the proven dispatch is reused verbatim:
 * inherited `actionKinds` ([glspUndo, glspRedo]) and the inherited `commandStack` /
 * `modelSubmissionHandler` injections drive `super.execute`, which runs the topmost command's
 * undo (e.g. {@link ReversibleWorkspaceEditCommand}.undo, whose guard messages must still reach
 * the user) and submits the model. Reimplementing that dispatch is what regressed undo — do NOT.
 *
 * The ONLY added behavior is error suppression: dialogram's durable undo is owned by the VS Code
 * document stack, which survives the source-model reloads that reset the in-memory GLSP command
 * stack. When a glspUndo arrives after such a reset, the stock handler could let the resulting
 * failure surface in the client as a "Could not process action: 'glspUndo'" error toast. Here we
 * swallow that (debug log, no actions) while leaving the normal stack-has-entries path untouched.
 */
@injectable()
export class WorkflowUndoRedoActionHandler extends UndoRedoActionHandler {
    override async execute(action: Action): Promise<Action[]> {
        try {
            return await super.execute(action);
        } catch (error) {
            // The host document stack owns durable undo; a post-reset failure here must not
            // surface as a "Could not process action" error toast in the diagram client.
            console.debug(
                `[WorkflowUndoRedoActionHandler] ${action.kind} ignored after command-stack reset:`,
                error
            );
            return [];
        }
    }
}
