import { Action, OperationHandler, ModelState, GPort, Command } from '@eclipse-glsp/server';
import { ReconnectEdgeOperation } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import type { PortReference } from './create-edge-handler';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';

@injectable()
export class ReconnectEdgeOperationHandler extends OperationHandler {
    readonly operationType = ReconnectEdgeOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    constructor() {
        super();
    }

    createCommand(operation: Action): Command | undefined {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation as ReconnectEdgeOperation, sourceUri);
    }

    private createPythonCommand(operation: ReconnectEdgeOperation, sourceUri: string): Command | undefined {
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME] as string | undefined;

        return new ReversibleWorkspaceEditCommand({
            label: 'Reconnect Edge' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const sourcePort = this.modelState.index.get(operation.sourceElementId) as GPort;
                const targetPort = this.modelState.index.get(operation.targetElementId) as GPort;
                if (!sourcePort || !targetPort) return undefined;

                const sourceRef = this.getPythonPortReference(sourcePort);
                const targetRef = this.getPythonPortReference(targetPort);
                if (!sourceRef || !targetRef) return undefined;

                // Resolve current edge endpoints from GModel edge args
                const edgeElement = this.modelState.index.get(operation.edgeElementId) as any;
                if (!edgeElement) return undefined;

                const edgeArgs = edgeElement.args as Record<string, unknown> | undefined;
                const currentSourceEntity = edgeArgs?.['wf:from'] as string | undefined;
                const currentSourcePort = edgeArgs?.['wf:outPort'] as string | undefined ?? edgeArgs?.[WorkflowDiagramMetadata.SOURCE_PORT_NAME] as string | undefined;
                const currentTargetEntity = edgeArgs?.['wf:to'] as string | undefined;
                const currentTargetPort = edgeArgs?.['wf:inPort'] as string | undefined ?? edgeArgs?.[WorkflowDiagramMetadata.TARGET_PORT_NAME] as string | undefined;

                const fromPort = sourceRef.isBoundary
                    ? { type: 'workflow', name: sourceRef.portName }
                    : { type: 'actor', actor: sourceRef.entityName, port: sourceRef.portName };
                const toPort = targetRef.isBoundary
                    ? { type: 'workflow', name: targetRef.portName }
                    : { type: 'actor', actor: targetRef.entityName, port: targetRef.portName };

                if (!currentSourcePort || !currentTargetPort) {
                    return undefined;
                }

                const currentFromExpr = this.edgeEndpointExpr(currentSourceEntity, currentSourcePort);
                const currentToExpr = this.edgeEndpointExpr(currentTargetEntity, currentTargetPort);

                const okDelete = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('deleteEdge'),
                    args: {
                        workflow: workflowName,
                        from_expr: currentFromExpr,
                        to_expr: currentToExpr
                    }
                });
                if (!okDelete) return undefined;

                const okConnect = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('connect'),
                    args: { workflow: workflowName, from_port: fromPort, to_port: toPort }
                });
                if (!okConnect) return undefined;

                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
    }

    /**
     * Resolve a port reference from GModel args (Python path).
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

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
