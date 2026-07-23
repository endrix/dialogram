import { CreateEdgeOperation, TriggerEdgeCreationAction } from '@eclipse-glsp/protocol';
import { OperationHandler, MaybePromise, GPort, ModelState, Command } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

/**
 * Port reference resolved from GModel args (Python path).
 * Local replacement for the deleted `create-edge-handler.ts` export.
 */
export interface PortReference {
    entityName?: string;
    portName: string;
    isBoundary: boolean;
    boundaryDirection?: 'input' | 'output';
}

@injectable()
export class CreateEdgeOperationHandler extends OperationHandler {
    readonly operationType = CreateEdgeOperation.KIND;
    override readonly label = 'Create Connection';
    readonly elementTypeIds = [WorkflowDiagramTypes.EDGE_CONNECTION];

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    constructor() {
        super();
    }

    getTriggerActions(): TriggerEdgeCreationAction[] {
        return this.elementTypeIds.map(elementTypeId => ({
            kind: TriggerEdgeCreationAction.KIND,
            elementTypeId
        }));
    }

    createCommand(operation: CreateEdgeOperation): MaybePromise<Command | undefined> {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: CreateEdgeOperation, sourceUri: string): Command | undefined {
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME] as string | undefined;

        return new ReversibleWorkspaceEditCommand({
            label: 'Create Connection' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const sourcePort = this.modelState.index.get(operation.sourceElementId) as GPort;
                const targetPort = this.modelState.index.get(operation.targetElementId) as GPort;
                if (!sourcePort || !targetPort) {
                    return undefined;
                }
                const sourceRef = this.getPythonPortReference(sourcePort);
                const targetRef = this.getPythonPortReference(targetPort);
                if (!sourceRef || !targetRef) {
                    console.warn('[CreateEdgeOperationHandler] Could not resolve port reference for Python workflow', {
                        sourceId: operation.sourceElementId,
                        targetId: operation.targetElementId
                    });
                    return undefined;
                }
                const fromPort = sourceRef.isBoundary
                    ? { type: 'workflow', name: sourceRef.portName }
                    : { type: 'actor', actor: sourceRef.entityName, port: sourceRef.portName };
                const toPort = targetRef.isBoundary
                    ? { type: 'workflow', name: targetRef.portName }
                    : { type: 'actor', actor: targetRef.entityName, port: targetRef.portName };

                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('connect'),
                    args: { workflow: workflowName, from_port: fromPort, to_port: toPort }
                });
                if (!ok) {
                    return undefined;
                }
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
    }

    /**
     * Resolve a port reference for Python diagram ports.
     *
     * We read directly from the GPort args that `GraphGModelSource` populates.
     */
    private getPythonPortReference(port: GPort): PortReference | undefined {
        const args = (port as any).args as Record<string, unknown> | undefined;
        if (!args) {
            return undefined;
        }

        const portName = args[WorkflowDiagramMetadata.PORT_NAME] as string | undefined;
        if (!portName) {
            return undefined;
        }

        const parent = (port as any).parent as any;
        if (!parent) {
            return undefined;
        }

        const parentType = parent.type as string | undefined;
        const isBoundary =
            parentType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ||
            parentType === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;

        if (isBoundary) {
            return {
                portName,
                isBoundary: true,
                boundaryDirection: parentType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ? 'input' : 'output'
            };
        }

        const parentArgs = parent.args as Record<string, unknown> | undefined;
        const entityName = parentArgs?.[WorkflowDiagramMetadata.ENTITY_NAME] as string | undefined;
        if (!entityName) {
            return undefined;
        }

        return {
            entityName,
            portName,
            isBoundary: false
        };
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }
}
