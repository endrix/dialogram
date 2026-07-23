import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';

export namespace UpdateEdgeCapacityOperation {
    export const KIND = 'dialogram.updateEdgeCapacity';

    export interface Operation extends Action {
        kind: typeof KIND;
        elementId: string;
        /** New queue capacity, or null/empty to clear it (revert to the runtime default). */
        capacity: number | null;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

/**
 * Updates a connection's queue capacity by rewriting its `connect(...)` call in the
 * source. The edge endpoints are reconstructed from the edge's stored args
 * (`wf:from`/`wf:to` + port names), mirroring the delete/reconnect handlers.
 */
@injectable()
export class UpdateEdgeCapacityOperationHandler extends OperationHandler {
    readonly operationType = UpdateEdgeCapacityOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!UpdateEdgeCapacityOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Update Queue Capacity',
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const element: any = this.modelState.index.find(operation.elementId);
                const elementArgs = element?.args as Record<string, unknown> | undefined;
                if (!elementArgs) {
                    return undefined;
                }
                const fromName = elementArgs['wf:from'] as string | undefined;
                const toName = elementArgs['wf:to'] as string | undefined;
                const outPort = elementArgs['wf:outPort'] as string | undefined;
                const inPort = elementArgs['wf:inPort'] as string | undefined;
                if (!outPort || !inPort) {
                    return undefined;
                }
                const fromExpr = this.edgeEndpointExpr(fromName, outPort);
                const toExpr = this.edgeEndpointExpr(toName, inPort);
                const ok = await this.sidecar.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('updateEdgeCapacity'),
                    args: {
                        workflow: workflowName,
                        from_expr: fromExpr,
                        to_expr: toExpr,
                        capacity: operation.capacity
                    }
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        return command;
    }

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
