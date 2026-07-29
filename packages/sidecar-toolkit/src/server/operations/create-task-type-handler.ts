import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { CreateTaskTypeOperation } from '@dialogram/shared';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

/**
 * Neutral task kind passed to the sidecar `createTaskType` op. The op's Python signature is
 * `create_task_type(*, kind, name)` and the diagram-scope MCP tool that dispatches this operation
 * only names the new type — so we pin the plain `task` kind here (mirroring the `task` branch of
 * the create-node picker in create-node-handler). `create_task_type` accepts no other arguments,
 * so nothing else is forwarded.
 */
const TASK_TYPE_KIND = 'task';

/**
 * Reversible GLSP operation handler that scaffolds a new task type in the source via the language
 * sidecar. Clones the {@link UpdateDefinitionParameterOperationHandler} pattern: the edit runs as a
 * {@link ReversibleWorkspaceEditCommand} whose before/after source snapshots make the scaffold
 * user-undoable through the editor's document undo stack.
 */
@injectable()
export class CreateTaskTypeOperationHandler extends OperationHandler {
    readonly operationType = CreateTaskTypeOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!CreateTaskTypeOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        const name = operation.name?.trim();
        if (!name) {
            void vscode.window.showErrorMessage('Cannot create a task type without a name.');
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Create task type' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const ok = await this.sidecar.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('createTaskType'),
                    args: { kind: TASK_TYPE_KIND, name }
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = await readAuthoritativeSourceText(vscodeUri);
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            }
        });
        return command;
    }
}
