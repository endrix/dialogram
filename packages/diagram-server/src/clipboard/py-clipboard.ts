import type { Args } from '@eclipse-glsp/protocol';
import type { ModelState } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

export const PY_CLIPBOARD_FORMAT = 'application/json';

export type PyClipboardItem =
    | {
          kind: 'entity';
          elementTypeId: string;
          name: string;
          typeName: string;
      }
    | {
          kind: 'boundaryPort';
          elementTypeId: string;
          direction: 'input' | 'output';
          portName: string;
          portType?: string;
      }
    | {
          kind: 'connection';
          elementTypeId: string;
          from?: string;
          to?: string;
          outPort?: string;
          inPort?: string;
      };

export interface PyClipboardPayload {
    version: 1;
    sourceUri: string;
    items: PyClipboardItem[];
}

function isReadOnly(element: any): boolean {
    const args: Args | undefined = element?.args;
    if (!args) {
        return false;
    }
    return args[WorkflowDiagramMetadata.IS_READ_ONLY] === true || args[WorkflowDiagramMetadata.IS_VIRTUAL] === true;
}

export async function buildPyClipboardPayload(
    modelState: ModelState,
    sourceUri: string,
    selectedElementIds: string[]
): Promise<PyClipboardPayload> {
    const items: PyClipboardItem[] = [];
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
            if (typeof name === 'string' && typeof typeName === 'string') {
                items.push({ kind: 'entity', elementTypeId, name, typeName });
            }
            continue;
        }

        if (elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const portName = args?.[WorkflowDiagramMetadata.PORT_NAME];
            const portType = args?.[WorkflowDiagramMetadata.PORT_TYPE];
            if (typeof portName === 'string') {
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

export function pyClipboardDataFromPayload(payload: PyClipboardPayload): Record<string, string> {
    return { [PY_CLIPBOARD_FORMAT]: JSON.stringify(payload) };
}

export function parsePyClipboardPayload(clipboardData: Record<string, string>): PyClipboardPayload | undefined {
    const json = clipboardData[PY_CLIPBOARD_FORMAT] ?? Object.values(clipboardData)[0];
    if (!json) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(json) as PyClipboardPayload;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items) || typeof parsed.sourceUri !== 'string') {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}
