import { Action, ApplyLabelEditOperation, Command, GModelElement, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { RenameEntityOperation, RenameEntityOperationHandler } from './rename-entity-handler';

/**
 * Server-side handler for the protocol `ApplyLabelEditOperation`, closing the MCP rename-coverage
 * gap.
 *
 * The GLSP-MCP built-in `modify-nodes` tool renames a node by dispatching an
 * {@link ApplyLabelEditOperation} (labelId + new text) server-side. The diagram module does NOT
 * call `super.configureOperationHandlers` (it would register conflicting default GModel handlers),
 * and the toolkit registers only the CUSTOM {@link RenameEntityOperation.KIND}; the client-side
 * `ApplyLabelEdit → RenameEntityOperation` interception is bypassed by the MCP path. Without this
 * handler an MCP-driven rename is a SILENT no-op success — the `.py` source never changes.
 *
 * This routes the label edit to the SAME reversible rename path: it resolves the edited label back
 * to its owning entity node (the nearest ancestor carrying an {@link WorkflowDiagramMetadata.ENTITY_NAME}
 * arg) and delegates to {@link RenameEntityOperationHandler}, so the rename rides the sidecar
 * `renameNode` op wrapped in a reversible workspace edit (free undo/redo + layout migration).
 */
@injectable()
export class ApplyLabelEditRenameHandler extends OperationHandler {
    // STATIC protocol literal — GLSP's DefaultGlobalActionProvider reads `.operationType` off a
    // `new ctor()` built WITHOUT DI, so this must never touch an injected field.
    readonly operationType = ApplyLabelEditOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(RenameEntityOperationHandler)
    protected readonly renameHandler!: RenameEntityOperationHandler;

    createCommand(operation: Action): Command | undefined {
        if (!ApplyLabelEditOperation.is(operation)) {
            return undefined;
        }

        const newName = operation.text?.trim();
        if (!newName) {
            return undefined;
        }

        const elementId = this.resolveEntityElementId(operation.labelId);
        if (!elementId) {
            return undefined;
        }

        const renameOp: RenameEntityOperation.Operation = {
            kind: RenameEntityOperation.KIND,
            elementId,
            newName
        };
        return this.renameHandler.createCommand(renameOp);
    }

    /**
     * Walk up from the edited label to the nearest ancestor whose `args` carry the entity name —
     * that is the node {@link RenameEntityOperationHandler} renames. Returns its id, or `undefined`
     * when the label belongs to no entity node (e.g. a port/decorator label), or when the label is
     * not a NAME (see {@link isRenameableLabel}).
     */
    private resolveEntityElementId(labelId: string): string | undefined {
        let element: GModelElement | undefined = this.modelState.index.find(labelId);
        if (!this.isRenameableLabel(element)) {
            return undefined;
        }
        while (element) {
            const name = element.args?.[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof name === 'string' && name.trim() !== '') {
                return element.id;
            }
            element = element.parent;
        }
        return undefined;
    }

    /**
     * Whether the edited element is something a rename may act on.
     *
     * This handler turns EVERY label edit into a rename of the nearest ancestor carrying an entity
     * name, which is right for a name label and silently destructive for any other. A boundary
     * port's TYPE label is the case that bit: it carries only a port name of its own, so the walk
     * lands on the boundary node — whose entity name is the PORT's name — and the edit went out as
     * `renameNode { old: <port name>, new: <the type the user typed> }`. Editing a type renamed the
     * port to that type. An entity node's type subtitle had the same shape.
     *
     * So labels are allow-listed by type, not deny-listed: a label type added later is refused
     * until someone deliberately decides a rename is what editing it means.
     *
     * Anything that is not a typed label passes through unchanged — the MCP caller addresses a node
     * by its label id, but a synthetic or untyped element must keep the original walk-up rather than
     * be silently dropped.
     */
    private isRenameableLabel(element: GModelElement | undefined): boolean {
        const type = (element as { type?: unknown } | undefined)?.type;
        if (typeof type !== 'string' || !type.startsWith('label:')) {
            return true;
        }
        return type === WorkflowDiagramTypes.LABEL_NAME || type === WorkflowDiagramTypes.LABEL_BOUNDARY_NAME;
    }
}
