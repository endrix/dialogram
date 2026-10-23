/**
 * Opening what a node, or a link in its properties, points at.
 *
 * Two things a producer says, both about files a person would otherwise have
 * to find by hand:
 *
 * - A node can stand for a file (`wf:open`, from the producer's `meta.open`):
 *   a specification clause that names a function, an IP block that names its
 *   source. A double-click opens that file at its line. It wins over every
 *   other double-click meaning — a drill-down, the node's views, its
 *   definition — because a producer that names the file is saying what the
 *   node is for.
 * - The property panel's text can carry links (Markdown, the producer's
 *   facts). A click opens the target: `#<id>` is an element of this diagram
 *   (its id, or the producer's own, `wf:graphNodeId`), selected and brought
 *   into view, or, when the diagram does not draw it, the file reference in
 *   the link's title (`[X](#id "/abs/doc.md#L12")`), opened instead; `http(s):` and `mailto:` go to the
 *   browser; anything else is a file reference, resolved by the extension
 *   host (an absolute path, or a path relative to the node's own file, else
 *   searched for in the workspace), with `#L12`, `#L12-L20` or a symbol after
 *   the `#`.
 */
import { Action, Args, GModelElement, NavigateToExternalTargetAction } from '@eclipse-glsp/sprotty';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';
/** On a navigate action: the target is a reference for the host to resolve, not a URI. */
export const OPEN_REFERENCE_ARG = 'wf:openReference';
/** On a reference: the file it was written in, which a relative path is relative to. */
export const REFERENCE_BASE_ARG = 'wf:referenceBase';

export interface OpenTarget {
    uri: string;
    /** 1-based. */
    line?: number;
}

function asOpenTarget(value: unknown): OpenTarget | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const { uri, line } = value as { uri?: unknown; line?: unknown };
    if (typeof uri !== 'string' || uri.trim() === '') {
        return undefined;
    }
    return typeof line === 'number' && line > 0 ? { uri, line } : { uri };
}

/** The file the element, or the nearest node holding it, stands for. */
export function openTargetOf(element: GModelElement | undefined): OpenTarget | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const target = asOpenTarget(args?.[WorkflowDiagramMetadata.OPEN_TARGET]);
        if (target) {
            return target;
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

/** Open a file at a line, in the text editor, for real (not as a preview). */
export function openFileAction(target: OpenTarget): Action {
    const line = target.line ? target.line - 1 : undefined;
    return NavigateToExternalTargetAction.create({
        uri: target.uri,
        args: {
            [SHOW_OPTIONS_ARG]: JSON.stringify({
                ...(line !== undefined ? { selection: { start: { line, character: 0 }, end: { line, character: 0 } } } : {}),
                preview: false,
                preserveFocus: false
            })
        }
    }) as Action;
}

/** What a double-click on this element opens, when its node stands for a file. */
export function openTargetAction(element: GModelElement | undefined): Action | undefined {
    const target = openTargetOf(element);
    return target ? openFileAction(target) : undefined;
}

export type PanelLink =
    | { kind: 'element'; id: string; fallback?: string }
    | { kind: 'external'; href: string }
    | { kind: 'reference'; href: string };

/**
 * What a link in the property panel points at, or undefined for nothing to
 * follow. An element link keeps its title as a fallback when the title is a
 * file reference (not a URL, not plain words).
 */
export function classifyLink(href: string | null | undefined, title?: string | null): PanelLink | undefined {
    const value = href?.trim();
    if (!value) {
        return undefined;
    }
    if (value.startsWith('#')) {
        const id = decodeURIComponentSafe(value.slice(1));
        if (!id) {
            return undefined;
        }
        const fallback = title?.trim();
        return fallback && !/\s/.test(fallback) && !/^[a-z][a-z0-9+.-]*:/i.test(fallback)
            ? { kind: 'element', id, fallback }
            : { kind: 'element', id };
    }
    if (/^(https?|mailto):/i.test(value)) {
        return { kind: 'external', href: value };
    }
    if (/^(javascript|data|vbscript):/i.test(value)) {
        return undefined;
    }
    return { kind: 'reference', href: value };
}

/**
 * Ask the host to open a link's target: an external link in the browser, a
 * file reference resolved against `baseUri` (the file the text came from).
 */
export function referenceAction(link: Extract<PanelLink, { kind: 'external' | 'reference' }>, baseUri: string | undefined): Action {
    return NavigateToExternalTargetAction.create({
        uri: link.href,
        args: {
            [OPEN_REFERENCE_ARG]: true,
            ...(baseUri ? { [REFERENCE_BASE_ARG]: baseUri } : {})
        }
    }) as Action;
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
