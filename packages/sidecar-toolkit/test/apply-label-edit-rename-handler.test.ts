// RED→GREEN for the MCP rename-coverage gap.
//
// The GLSP-MCP built-in `modify-nodes` tool renames a node by dispatching the protocol
// `ApplyLabelEditOperation` server-side (labelId + new text). Before this handler, NO server
// operation handler was registered for `ApplyLabelEditOperation.KIND` (the diagram module does
// not call `super.configureOperationHandlers`, and the toolkit registered only the CUSTOM
// `RenameEntityOperation.KIND`) — so an MCP-driven rename was a SILENT no-op success: the model
// was never touched and the `.py` source never changed.
//
// This suite pins that the new handler closes the gap by routing a label edit to the SAME
// reversible rename path (`RenameEntityOperationHandler`), resolving the edited label back to its
// owning entity node.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ApplyLabelEditOperation, type Command } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { ApplyLabelEditRenameHandler } from '../src/server/operations/apply-label-edit-rename-handler';
import { RenameEntityOperation } from '../src/server/operations/rename-entity-handler';

/** A node element carrying the entity name in `args`, plus one typed label child. */
function modelWith(nodeId: string, entityName: string, labelId: string, labelType?: string) {
    const node: any = { id: nodeId, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: entityName } };
    const label: any = { id: labelId, type: labelType, args: {}, parent: node };
    node.parent = undefined;
    const index = {
        find: (id: string) => (id === labelId ? label : id === nodeId ? node : undefined)
    };
    return { index };
}

/** The delegating handler, wired to record what it would rename. */
function handlerFor(model: ReturnType<typeof modelWith>) {
    const handler = new ApplyLabelEditRenameHandler();
    (handler as any).modelState = model;
    const seen: RenameEntityOperation.Operation[] = [];
    (handler as any).renameHandler = {
        createCommand: (op: RenameEntityOperation.Operation) => {
            seen.push(op);
            return { label: 'rename-command' } as unknown as Command;
        }
    };
    return { handler, seen };
}

describe('ApplyLabelEditRenameHandler (MCP label-edit → reversible rename)', () => {
    it('exposes the protocol operation kind as a static literal (DI-less read)', () => {
        // The GLSP DefaultGlobalActionProvider reads `.operationType` off a `new ctor()` built
        // WITHOUT DI, so it must not touch injected fields.
        expect(new ApplyLabelEditRenameHandler().operationType).toBe(ApplyLabelEditOperation.KIND);
        expect(ApplyLabelEditOperation.KIND).toBe('applyLabelEdit');
    });

    it('routes a label edit to RenameEntityOperationHandler with the resolved entity id + new name', () => {
        const handler = new ApplyLabelEditRenameHandler();
        (handler as any).modelState = modelWith('node:Splitter', 'Splitter', 'node:Splitter_label_name');

        const sentinel = { label: 'rename-command' } as unknown as Command;
        let delegated: RenameEntityOperation.Operation | undefined;
        (handler as any).renameHandler = {
            createCommand: (op: RenameEntityOperation.Operation) => {
                delegated = op;
                return sentinel;
            }
        };

        const command = handler.createCommand(
            ApplyLabelEditOperation.create({ labelId: 'node:Splitter_label_name', text: '  Merger  ' })
        );

        expect(command).toBe(sentinel);
        expect(delegated).toEqual({
            kind: RenameEntityOperation.KIND,
            elementId: 'node:Splitter',
            newName: 'Merger'
        });
    });

    it('ignores unrelated operations and empty/whitespace labels', () => {
        const handler = new ApplyLabelEditRenameHandler();
        (handler as any).modelState = modelWith('node:A', 'A', 'node:A_label_name');
        (handler as any).renameHandler = { createCommand: () => ({} as Command) };

        expect(handler.createCommand({ kind: 'someOther' } as any)).toBeUndefined();
        expect(
            handler.createCommand(ApplyLabelEditOperation.create({ labelId: 'node:A_label_name', text: '   ' }))
        ).toBeUndefined();
    });

    it('returns undefined when the label resolves to no entity node', () => {
        const handler = new ApplyLabelEditRenameHandler();
        const orphan: any = { id: 'stray_label', args: {}, parent: undefined };
        (handler as any).modelState = { index: { find: (id: string) => (id === 'stray_label' ? orphan : undefined) } };
        (handler as any).renameHandler = { createCommand: () => ({} as Command) };

        expect(
            handler.createCommand(ApplyLabelEditOperation.create({ labelId: 'stray_label', text: 'X' }))
        ).toBeUndefined();
    });
});

/**
 * Editing a TYPE must never rename.
 *
 * This handler turns every label edit into a rename of the nearest ancestor carrying an entity
 * name. For a boundary port's type label that ancestor is the boundary node, whose entity name is
 * the PORT's name — so changing a port's type sent `renameNode { old: <port name>, new: <the type
 * typed> }` and renamed the port to its own type. The property panel offers exactly that edit
 * ("Change Port Type"), and the canvas label is editable too, so both routes corrupted the source.
 *
 * The guard is an allow-list, which is the polarity that matters: the next label type added is
 * refused by default rather than silently inheriting "editing this renames the node".
 */
describe('ApplyLabelEditRenameHandler — only a NAME may rename', () => {
    it('refuses a boundary port type label', () => {
        const { handler, seen } = handlerFor(
            modelWith('bnd:Com', 'Com', 'bnd:Com_label_type', WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE)
        );

        const command = handler.createCommand(
            ApplyLabelEditOperation.create({ labelId: 'bnd:Com_label_type', text: 'RobAlloc' })
        );

        expect(command).toBeUndefined();
        // The bug was not "wrong command" but "renamed the port to the type".
        expect(seen).toEqual([]);
    });

    it('refuses an entity node type subtitle', () => {
        const { handler, seen } = handlerFor(
            modelWith('node:rob', 'rob', 'node:rob_subtitle', WorkflowDiagramTypes.LABEL_TYPE)
        );

        expect(
            handler.createCommand(ApplyLabelEditOperation.create({ labelId: 'node:rob_subtitle', text: 'Rob' }))
        ).toBeUndefined();
        expect(seen).toEqual([]);
    });

    it('still renames from a name label, on a node and on a boundary port', () => {
        const entity = handlerFor(
            modelWith('node:rob', 'rob', 'node:rob_label_name', WorkflowDiagramTypes.LABEL_NAME)
        );
        entity.handler.createCommand(
            ApplyLabelEditOperation.create({ labelId: 'node:rob_label_name', text: 'reorder' })
        );
        expect(entity.seen).toEqual([
            { kind: RenameEntityOperation.KIND, elementId: 'node:rob', newName: 'reorder' }
        ]);

        const boundary = handlerFor(
            modelWith('bnd:Com', 'Com', 'bnd:Com_label_name', WorkflowDiagramTypes.LABEL_BOUNDARY_NAME)
        );
        boundary.handler.createCommand(
            ApplyLabelEditOperation.create({ labelId: 'bnd:Com_label_name', text: 'Commit' })
        );
        expect(boundary.seen).toEqual([
            { kind: RenameEntityOperation.KIND, elementId: 'bnd:Com', newName: 'Commit' }
        ]);
    });

    /** A label type nobody has classified yet is refused, not assumed to be a name. */
    it('refuses a label type it has never heard of', () => {
        const { handler, seen } = handlerFor(modelWith('node:x', 'x', 'node:x_label_new', 'label:something:new'));

        expect(
            handler.createCommand(ApplyLabelEditOperation.create({ labelId: 'node:x_label_new', text: 'Y' }))
        ).toBeUndefined();
        expect(seen).toEqual([]);
    });
});
