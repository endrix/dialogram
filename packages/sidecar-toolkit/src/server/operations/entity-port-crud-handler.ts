import { Action, Command, ModelState, OperationHandler, type OperationHandlerConstructor } from '@eclipse-glsp/server';
import { decorate, inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

type CreateEntityPortOp = Action & {
    kind: string;
    elementId: string;
    entityType: string;
    portDirection: 'input' | 'output';
    portName: string;
    portType: string;
};

type DeleteEntityPortOp = Action & {
    kind: string;
    entityType: string;
    portDirection: 'input' | 'output';
    portName: string;
};

/**
 * Shared create/delete entity-port CRUD logic.
 *
 * `operationType` is intentionally NOT declared here as a getter. GLSP's
 * {@link https://github.com/eclipse-glsp/glsp-server-node DefaultGlobalActionProvider}
 * collects the diagram's handled operation kinds by reading `.operationType` off a
 * `new constructor()` instance built WITHOUT dependency injection (the diagram module's
 * `bindOperations` seam does `container.get(OperationHandlerConstructor).map(c => new c().operationType)`).
 * A getter that dereferenced the injected `sidecar` therefore threw
 * `TypeError: Cannot read properties of undefined (reading 'operationKindCreateEntityPort')`
 * during GLSP server start. The concrete, product-specific kind is instead baked in as a
 * plain field by the configured subclasses that {@link createEntityPortCrudHandlers}
 * returns, so it is readable without DI while the injected `sidecar` still drives the
 * actual edit at execution time (where handlers ARE resolved through the container).
 */
@injectable()
class EntityPortCrudHandlerBase extends OperationHandler {
    /** Product operation kind; assigned as a plain field by the configured subclass. */
    override operationType!: string;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(action: Action): Command | undefined {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri || !sourceUri.endsWith('.py')) {
            return undefined;
        }
        const createKind = this.sidecar.operationKindCreateEntityPort();
        const deleteKind = this.sidecar.operationKindDeleteEntityPort();
        if ((action as any).kind !== createKind && (action as any).kind !== deleteKind) {
            return undefined;
        }
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const command = new ReversibleWorkspaceEditCommand({
            label: (action as any).kind === createKind ? 'Create Entity Port' : 'Delete Entity Port',
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const op = action as CreateEntityPortOp | DeleteEntityPortOp;
                const isCreate = op.kind === createKind;
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: isCreate ? this.sidecar.sidecarOp('createEntityPort') : this.sidecar.sidecarOp('deleteEntityPort'),
                    args: isCreate
                        ? {
                            entityType: op.entityType,
                            portDirection: op.portDirection,
                            portName: op.portName,
                            portType: (op as CreateEntityPortOp).portType
                        }
                        : {
                            entityType: op.entityType,
                            portDirection: op.portDirection,
                            portName: op.portName
                        }
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            }
        });
        return command;
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }
}

/**
 * Build the create + delete entity-port CRUD handler constructors with their product
 * operation kinds baked in as plain (DI-free) `operationType` fields.
 *
 * A fresh, config-specific subclass is generated per call so that two products assembled
 * in one process (e.g. both shells in a single test run) never share a mutable `operationType`.
 * The class names are preserved (`EntityPortCrudHandler` / `DeleteEntityPortCrudHandler`)
 * so downstream registration snapshots stay stable. Each subclass is decorated with
 * `@injectable()` so the container can resolve it (and inject `sidecar`/`modelState`)
 * at execution time; the plain `operationType` field keeps the DI-less
 * `new constructor().operationType` probe safe.
 */
export function createEntityPortCrudHandlers(kinds: {
    createEntityPort: string;
    deleteEntityPort: string;
}): OperationHandlerConstructor[] {
    class EntityPortCrudHandler extends EntityPortCrudHandlerBase {
        override readonly operationType = kinds.createEntityPort;
    }
    class DeleteEntityPortCrudHandler extends EntityPortCrudHandlerBase {
        override readonly operationType = kinds.deleteEntityPort;
    }
    decorate(injectable(), EntityPortCrudHandler);
    decorate(injectable(), DeleteEntityPortCrudHandler);
    return [EntityPortCrudHandler, DeleteEntityPortCrudHandler];
}
