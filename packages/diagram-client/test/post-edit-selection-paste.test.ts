/**
 * After a paste the webview selects the pasted elements by the names the
 * sidecar gives them. It reads those names from the clipboard payload copy
 * wrote, so it must read the shape copy writes.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { clipboardDataFromPayload, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { PostEditSelectionService } from '../src/post-edit-selection-service';

function modelRootWith(elements: Array<{ id: string; type: string; args: Record<string, unknown> }>) {
    return { type: 'graph', children: elements };
}

describe('PostEditSelectionService.prepareForPaste', () => {
    it('plans the pasted names from the entity names of the copied payload', () => {
        const service = new PostEditSelectionService();
        const root = modelRootWith([
            { id: 'add', type: WorkflowDiagramTypes.NODE_ACTOR, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'add' } },
            { id: 'a', type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'a' } }
        ]);
        const clipboardData = clipboardDataFromPayload({
            version: 1,
            sourceUri: 'file:///hdl/top.sv',
            items: [
                { kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name: 'add', typeName: 'Adder' },
                { kind: 'boundaryPort', elementTypeId: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, direction: 'input', portName: 'a' }
            ]
        });

        service.prepareForPaste(clipboardData, root);

        const pending = (service as any).pending;
        expect(pending.entityNames).toHaveLength(1);
        expect(pending.entityNames[0]).not.toBe('add');
        expect(pending.entityNames[0]).toMatch(/^add/);
        expect(pending.boundaryPortNames).toHaveLength(1);
        expect(pending.boundaryPortNames[0]).toMatch(/^a/);
    });

    it('plans nothing for clipboard data that is not a diagram payload', () => {
        const service = new PostEditSelectionService();
        service.prepareForPaste({ 'text/plain': 'not a payload' }, modelRootWith([]));
        expect((service as any).pending).toBeUndefined();
    });
});
