import type { Args } from '@eclipse-glsp/protocol';
import type { ModelState } from '@eclipse-glsp/server';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

export const WORKFLOW_CLIPBOARD_FORMAT = 'application/json';

type SerializedPosition = { line: number; character: number };
export type SerializedRange = { start: SerializedPosition; end: SerializedPosition };

export type WorkflowClipboardItem =
    | {
          kind: 'entity';
          elementTypeId: string;
          entityName: string;
          sourceRange: SerializedRange;
          text: string;
      }
    | {
          kind: 'boundaryPort';
          elementTypeId: string;
          direction: 'input' | 'output';
          portName: string;
          sourceRange: SerializedRange;
          text: string;
      }
    | {
          kind: 'connection';
          elementTypeId: string;
          sourceRange: SerializedRange;
          text: string;
      };

export interface WorkflowClipboardPayload {
    version: 1;
    sourceUri: string;
    items: WorkflowClipboardItem[];
}

function isSerializedPosition(value: unknown): value is SerializedPosition {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.line === 'number' && typeof v.character === 'number';
}

export function isSerializedRange(value: unknown): value is SerializedRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return isSerializedPosition(v.start) && isSerializedPosition(v.end);
}

function findNearestSourceRange(element: unknown): SerializedRange | undefined {
    let current: any = element;
    while (current) {
        const args: Args | undefined = current.args;
        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return range;
        }
        current = current.parent;
    }
    return undefined;
}

function getTextForRange(document: vscode.TextDocument, range: SerializedRange): string {
    return document.getText(
        new vscode.Range(
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character
        )
    );
}

function isReadOnly(element: any): boolean {
    const args: Args | undefined = element?.args;
    if (!args) {
        return false;
    }
    return args[WorkflowDiagramMetadata.IS_READ_ONLY] === true || args[WorkflowDiagramMetadata.IS_VIRTUAL] === true;
}

export async function buildWorkflowClipboardPayload(
    modelState: ModelState,
    sourceUri: string,
    selectedElementIds: string[]
): Promise<WorkflowClipboardPayload> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));

    const items: WorkflowClipboardItem[] = [];
    for (const id of selectedElementIds) {
        const element: any = modelState.index.get(id);
        if (!element || isReadOnly(element)) {
            continue;
        }

        const elementTypeId: string | undefined = element.type;
        const args: Args | undefined = element.args;

        const range = findNearestSourceRange(element);
        if (!range) {
            continue;
        }

        const text = getTextForRange(doc, range);
        if (!text || text.trim() === '') {
            continue;
        }

        if (
            elementTypeId === WorkflowDiagramTypes.NODE_ACTOR ||
            elementTypeId === WorkflowDiagramTypes.NODE_NETWORK ||
            elementTypeId === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const entityName = args?.[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof entityName !== 'string' || entityName.trim() === '') {
                continue;
            }
            items.push({
                kind: 'entity',
                elementTypeId,
                entityName,
                sourceRange: range,
                text
            });
            continue;
        }

        if (elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const portName = args?.[WorkflowDiagramMetadata.PORT_NAME];
            if (typeof portName !== 'string' || portName.trim() === '') {
                continue;
            }
            items.push({
                kind: 'boundaryPort',
                elementTypeId,
                direction: elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ? 'input' : 'output',
                portName,
                sourceRange: range,
                text
            });
            continue;
        }

        if (elementTypeId === WorkflowDiagramTypes.EDGE_CONNECTION || elementTypeId === WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW) {
            items.push({
                kind: 'connection',
                elementTypeId,
                sourceRange: range,
                text
            });
            continue;
        }
    }

    return {
        version: 1,
        sourceUri,
        items
    };
}

export function clipboardDataFromPayload(payload: WorkflowClipboardPayload): Record<string, string> {
    return {
        [WORKFLOW_CLIPBOARD_FORMAT]: JSON.stringify(payload)
    };
}

export function parseWorkflowClipboardPayload(clipboardData: Record<string, string>): WorkflowClipboardPayload | undefined {
    const json = clipboardData[WORKFLOW_CLIPBOARD_FORMAT] ?? Object.values(clipboardData)[0];
    if (!json) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(json) as WorkflowClipboardPayload;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items) || typeof parsed.sourceUri !== 'string') {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}

export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}
