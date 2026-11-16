import { CreateEdgeOperation, TriggerEdgeCreationAction } from '@eclipse-glsp/protocol';
import { OperationHandler, MaybePromise, GPort, ModelState, Command } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { type SidecarEdgeRole } from '../../sidecar-capabilities';

/** Port reference resolved from GModel args. */
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
                const sourcePort = this.portOf(operation.sourceElementId);
                const targetPort = this.portOf(operation.targetElementId);
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

                const role = await this.pickEdgeRole(sourceUri, operation);
                if (role === null) {
                    return undefined;
                }
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('connect'),
                    args: { workflow: workflowName, from_port: fromPort, to_port: toPort, ...(role ? { role } : {}) }
                }, operation.args?.['headless'] !== true);
                if (!ok) {
                    return undefined;
                }
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
    }

    /**
     * The kind of edge to make, when the sidecar's `connect` can make more
     * than one (`getCapabilities.edgeRoles`).
     *
     * A role given on the operation wins. Otherwise the sidecar is asked what
     * it offers: nothing, and `connect` goes without a role, as it always
     * has; one, and that is it; several, and the person picks (`undefined`
     * when the pick is dismissed, which is the `null` here: no connection).
     * A headless caller, an agent with no one to ask, gets no pick either:
     * it names the role itself, or the sidecar's default applies.
     */
    protected async pickEdgeRole(sourceUri: string, operation: CreateEdgeOperation): Promise<string | undefined | null> {
        const given = typeof operation.args?.['role'] === 'string' ? String(operation.args['role']).trim() : '';
        if (given !== '') {
            return given;
        }
        if (operation.args?.['headless'] === true) {
            return undefined;
        }
        const roles = await this.edgeRoles(sourceUri);
        if (!roles || roles.length === 0) {
            return undefined;
        }
        if (roles.length === 1) {
            return roles[0].id;
        }
        const picked = await vscode.window.showQuickPick(
            roles.map(role => ({ label: role.id, description: role.label, detail: role.description, id: role.id })),
            { placeHolder: 'Which kind of edge?', matchOnDescription: true }
        );
        return picked ? picked.id : null;
    }

    /** The edge kinds the sidecar offers (asked once per session); nothing when it says nothing. */
    protected async edgeRoles(sourceUri: string): Promise<SidecarEdgeRole[] | undefined> {
        return this.sidecar.edgeRoles(sourceUri);
    }

    /**
     * The port an edge is drawn from or to: the element itself, or the port
     * of a network's own port, which is drawn as a node with its port hidden
     * inside it and is what the pointer is on.
     */
    private portOf(elementId: string): GPort | undefined {
        const element = this.modelState.index.get(elementId) as GPort | undefined;
        const type = (element as { type?: string } | undefined)?.type;
        if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            return ((element as any).children as GPort[] | undefined)?.find(child => typeof child.type === 'string' && child.type.startsWith('port'));
        }
        return element;
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

    /**
     * Have the producer write the connection; false, its reason shown to a
     * person (`say`: not to an agent, which has its own way to fail), when
     * it does not.
     */
    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }, say = true): Promise<boolean> {
        const result = await this.sidecar.sendSidecarOpDetailed(sourceUri, payload);
        if (!result.ok && say) {
            void vscode.window.showWarningMessage(result.message ?? 'The connection was not made.');
        }
        return result.ok;
    }
}
