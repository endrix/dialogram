/**
 * The one clipboard shape of a diagram. The server writes it on copy (and the
 * sidecar toolkit on cut and duplicate), the toolkit's paste reads it, and the
 * webview reads it to pick the pasted elements once the model is back.
 *
 * An item carries the names the paste re-creates the element from, never the
 * source text: the pasted entity gets a fresh name in the target diagram, and
 * the product's sidecar writes it in the product's own syntax.
 */

export const CLIPBOARD_FORMAT = 'application/json';

export type DiagramClipboardItem =
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

export interface DiagramClipboardPayload {
    version: 1;
    sourceUri: string;
    items: DiagramClipboardItem[];
}

/**
 * The name a pasted or duplicated element gets: `base` when free, else
 * `base2`, `base3`, ... The sidecar writes this name, and the webview
 * predicts it to select the new element, so both apply this one rule.
 */
export function nextFreeName(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) {
        return base;
    }
    let index = 2;
    while (taken.has(`${base}${index}`)) {
        index += 1;
    }
    return `${base}${index}`;
}

/** The GLSP clipboard-data record carrying `payload`. */
export function clipboardDataFromPayload(payload: DiagramClipboardPayload): Record<string, string> {
    return { [CLIPBOARD_FORMAT]: JSON.stringify(payload) };
}

/** The payload in a GLSP clipboard-data record, or `undefined` when it carries none. */
export function parseClipboardPayload(clipboardData: Record<string, string> | undefined): DiagramClipboardPayload | undefined {
    if (!clipboardData) {
        return undefined;
    }
    const json = clipboardData[CLIPBOARD_FORMAT] ?? Object.values(clipboardData)[0];
    if (!json) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(json) as DiagramClipboardPayload;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items) || typeof parsed.sourceUri !== 'string') {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}
