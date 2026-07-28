import { Operation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { buildPyClipboardPayload } from '@dialogram/diagram-server/clipboard/py-clipboard';
import { SidecarInvoker } from './sidecar-invoker';

export const WORKFLOW_DUPLICATE_OPERATION_KIND = 'dialogram.duplicate' as const;

export interface DuplicateOperation extends Operation {
    kind: typeof WORKFLOW_DUPLICATE_OPERATION_KIND;
    elementIds: string[];
}

@injectable()
export class DuplicateOperationHandler extends OperationHandler {
    static readonly KIND = WORKFLOW_DUPLICATE_OPERATION_KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    override operationType = WORKFLOW_DUPLICATE_OPERATION_KIND;

    override createCommand(operation: DuplicateOperation): MaybePromise<Command | undefined> {
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        const sourceUri = this.modelState.sourceUri ?? diagramModel?.documentUri;
        if (!diagramModel || !sourceUri) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Duplicate',
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const payload = await buildPyClipboardPayload(this.modelState, sourceUri, operation.elementIds ?? []);
                if (payload.items.length === 0) return undefined;
                const workflowName = this.modelState.root.args?.['wf:workflowName'] as string | undefined;
                const takenResp = await this.sendSidecarList(sourceUri, {
                    op: this.sidecar.sidecarOp('listInstanceNames'),
                    args: { workflow: workflowName }
                });
                const taken = new Set((takenResp?.diagnostic?.names as string[] | undefined) ?? []);
                for (const item of payload.items) {
                    if (item.kind === 'entity') {
                        const base = item.name;
                        let name = base;
                        let idx = 2;
                        while (taken.has(name)) {
                            name = `${base}${idx}`;
                            idx += 1;
                        }
                        taken.add(name);
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('createNode'),
                            args: { workflow: workflowName, type: item.typeName, name }
                        });
                    } else if (item.kind === 'boundaryPort') {
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('createPort'),
                            args: { workflow: workflowName, direction: item.direction, portName: item.portName, portType: item.portType ?? 'Any' }
                        });
                    } else if (item.kind === 'connection') {
                        if (!item.outPort || !item.inPort) continue;
                        const fromPort = item.from
                            ? { type: 'actor', actor: item.from, port: item.outPort }
                            : { type: 'workflow', name: item.outPort };
                        const toPort = item.to
                            ? { type: 'actor', actor: item.to, port: item.inPort }
                            : { type: 'workflow', name: item.inPort };
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('connect'),
                            args: { workflow: workflowName, from_port: fromPort, to_port: toPort }
                        });
                    }
                }
                const afterText = await readAuthoritativeSourceText(vscodeUri);
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        return command;
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }

    private async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        return this.sidecar.sendSidecarList(sourceUri, payload);
    }
}
