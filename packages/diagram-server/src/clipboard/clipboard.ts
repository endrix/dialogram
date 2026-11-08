import type { Args } from '@eclipse-glsp/protocol';
import type { ModelState } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, type DiagramClipboardItem, type DiagramClipboardPayload } from '@dialogram/shared';

export { clipboardDataFromPayload, parseClipboardPayload, type DiagramClipboardItem, type DiagramClipboardPayload } from '@dialogram/shared';

function isReadOnly(element: any): boolean {
    const args: Args | undefined = element?.args;
    if (!args) {
        return false;
    }
    return args[WorkflowDiagramMetadata.IS_READ_ONLY] === true || args[WorkflowDiagramMetadata.IS_VIRTUAL] === true;
}

/**
 * The clipboard payload for the selected elements: every editable entity,
 * boundary port and connection among them, by the names a paste re-creates
 * it from. Read-only and virtual elements are left out.
 */
export function buildClipboardPayload(modelState: ModelState, sourceUri: string, selectedElementIds: string[]): DiagramClipboardPayload {
    const items: DiagramClipboardItem[] = [];
    for (const id of selectedElementIds) {
        const element: any = modelState.index.get(id);
        if (!element || isReadOnly(element)) {
            continue;
        }
        const elementTypeId: string | undefined = element.type;
        const args: Args | undefined = element.args;

        if (
            elementTypeId === WorkflowDiagramTypes.NODE_ACTOR ||
            elementTypeId === WorkflowDiagramTypes.NODE_NETWORK ||
            elementTypeId === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const name = args?.[WorkflowDiagramMetadata.ENTITY_NAME];
            const typeName = args?.[WorkflowDiagramMetadata.ENTITY_TYPE];
            if (typeof name === 'string' && name.trim() !== '' && typeof typeName === 'string' && typeName.trim() !== '') {
                items.push({ kind: 'entity', elementTypeId, name, typeName });
            }
            continue;
        }

        if (elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const portName = args?.[WorkflowDiagramMetadata.PORT_NAME];
            const portType = args?.[WorkflowDiagramMetadata.PORT_TYPE];
            if (typeof portName === 'string' && portName.trim() !== '') {
                items.push({
                    kind: 'boundaryPort',
                    elementTypeId,
                    direction: elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ? 'input' : 'output',
                    portName,
                    portType: typeof portType === 'string' ? portType : undefined
                });
            }
            continue;
        }

        if (elementTypeId === WorkflowDiagramTypes.EDGE_CONNECTION || elementTypeId === WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW) {
            items.push({
                kind: 'connection',
                elementTypeId,
                from: args?.['wf:from'] as string | undefined,
                to: args?.['wf:to'] as string | undefined,
                outPort: args?.['wf:outPort'] as string | undefined,
                inPort: args?.['wf:inPort'] as string | undefined
            });
            continue;
        }
    }
    return { version: 1, sourceUri, items };
}
