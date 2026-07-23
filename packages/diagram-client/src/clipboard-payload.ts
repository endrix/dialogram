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

export function tryParseWorkflowClipboardPayload(clipboardData: Record<string, string>): WorkflowClipboardPayload | undefined {
    const json = clipboardData[WORKFLOW_CLIPBOARD_FORMAT] ?? Object.values(clipboardData)[0];
    if (!json) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(json) as WorkflowClipboardPayload;
        if (!parsed || parsed.version !== 1 || typeof parsed.sourceUri !== 'string' || !Array.isArray(parsed.items)) {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}
