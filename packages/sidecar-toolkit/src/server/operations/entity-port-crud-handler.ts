import { Action, Command, ModelState, OperationHandler, type OperationHandlerConstructor } from '@eclipse-glsp/server';
import { decorate, inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { entityPortWrite } from './entity-port-write';
import { producerWriteCommand } from './producer-write';
import { SidecarInvoker } from './sidecar-invoker';

type CreateEntityPortOp = Action & {
    kind: string;
    elementId: string;
    /** The entity's file, as the property panel read it off the instance. */
    entityDocumentUri?: string;
    entityType: string;
    portDirection: 'input' | 'output';
    portName: string;
    portType: string;
};

type DeleteEntityPortOp = Action & {
    kind: string;
    /** The instance the port was deleted from; older clients send none. */
    elementId?: string;
    entityDocumentUri?: string;
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

    /**
     * Add or delete the port where its entity is declared
     * (entity-port-write.ts); a delete is refused while a connection here
     * uses it, by a sidecar that is told where it is used.
     */
    createCommand(action: Action): Command | undefined {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }
        const createKind = this.sidecar.operationKindCreateEntityPort();
        const deleteKind = this.sidecar.operationKindDeleteEntityPort();
        if ((action as any).kind !== createKind && (action as any).kind !== deleteKind) {
            return undefined;
        }
        const op = action as CreateEntityPortOp | DeleteEntityPortOp;
        const isCreate = op.kind === createKind;
        return producerWriteCommand({
            label: isCreate ? 'Create Entity Port' : 'Delete Entity Port',
            sidecar: this.sidecar,
            failed: isCreate ? `Port '${op.portName}' was not added.` : `Port '${op.portName}' was not deleted.`,
            request: async () => {
                const write = await entityPortWrite(
                    this.sidecar,
                    this.modelState,
                    sourceUri,
                    { entityType: op.entityType, entityDocumentUri: op.entityDocumentUri, elementId: op.elementId },
                    {
                        op: this.sidecar.sidecarOp(isCreate ? 'createEntityPort' : 'deleteEntityPort'),
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
                    },
                    !isCreate
                );
                if ('refused' in write) {
                    void vscode.window.showWarningMessage(write.refused);
                    return undefined;
                }
                return write;
            }
        });
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
