import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { CreateTaskTypeOperation } from '@dialogram/shared';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
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

        // Creating a class in a package also updates that package's
        // `__init__.py`, so one undo step has to cover BOTH files or it
        // restores half the change — the class gone and the export still
        // naming it. The language sidecar reports what else it wrote; this
        // snapshots every file it names, which is why the request opts in
        // explicitly: a host that could not do this must never ask for the
        // second write.
        let snapshots: Array<{ uri: vscode.Uri; beforeText: string; afterText: string }> = [];

        const command = new ReversibleMultiWorkspaceEditCommand({
            label: 'Create task type' + this.sidecar.undoLabelSuffix(),
            outOfBandSnapshots: () => snapshots,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                // Read the sibling package file BEFORE the op: which file gets
                // touched is only known afterwards, but what it looked like
                // beforehand can only be captured now.
                const packageUri = siblingPackageInit(vscodeUri);
                const packageBefore = packageUri ? await readTextIfPresent(packageUri) : undefined;

                const result = await this.sidecar.sendSidecarOpDetailed(sourceUri, {
                    op: this.sidecar.sidecarOp('createTaskType'),
                    args: { kind: TASK_TYPE_KIND, name, updatePackageExports: true }
                });
                if (!result.ok) {
                    return undefined;
                }

                snapshots = [
                    {
                        uri: vscodeUri,
                        beforeText,
                        afterText: await readAuthoritativeSourceText(vscodeUri)
                    }
                ];

                // Only what the op SAYS it changed. Snapshotting a file it left
                // alone would make undo rewrite it for no reason.
                const changed = (result.response as { changedFiles?: Array<{ file?: unknown }> })
                    ?.changedFiles;
                for (const entry of Array.isArray(changed) ? changed : []) {
                    const file = typeof entry?.file === 'string' ? entry.file : undefined;
                    if (!file || !packageUri || packageBefore === undefined) {
                        continue;
                    }
                    const uri = vscode.Uri.file(file);
                    if (uri.fsPath !== packageUri.fsPath) {
                        continue;
                    }
                    snapshots.push({
                        uri,
                        beforeText: packageBefore,
                        afterText: await readAuthoritativeSourceText(uri)
                    });
                }

                return snapshots.map(snapshot => ({
                    uri: snapshot.uri,
                    edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')]
                }));
            }
        });
        return command;
    }
}

/**
 * The `__init__.py` beside `file`, when there is one.
 *
 * Mirrors the language runtime's own rule — the IMMEDIATE package only —
 * because the host has to know what that file looked like BEFORE the op, and
 * by the time the op reports which file it touched, the old text is gone.
 */
function siblingPackageInit(file: vscode.Uri): vscode.Uri | undefined {
    const parts = file.fsPath.split(/[\\/]/);
    if (parts.pop() === '__init__.py') {
        return undefined;
    }
    return vscode.Uri.file([...parts, '__init__.py'].join('/'));
}

/** The file's text, or `undefined` when it does not exist. */
async function readTextIfPresent(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return await readAuthoritativeSourceText(uri);
    } catch {
        return undefined;
    }
}
