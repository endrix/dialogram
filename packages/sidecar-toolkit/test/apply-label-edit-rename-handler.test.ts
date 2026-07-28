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
import { WorkflowDiagramMetadata } from '@dialogram/shared';

import { ApplyLabelEditRenameHandler } from '../src/server/operations/apply-label-edit-rename-handler';
import { RenameEntityOperation } from '../src/server/operations/rename-entity-handler';

/** A node element carrying the entity name in `args`, plus its header label child. */
function modelWith(nodeId: string, entityName: string, labelId: string) {
    const node: any = { id: nodeId, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: entityName } };
    const label: any = { id: labelId, args: {}, parent: node };
    node.parent = undefined;
    const index = {
        find: (id: string) => (id === labelId ? label : id === nodeId ? node : undefined)
    };
    return { index };
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
