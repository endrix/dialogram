/**
 * Where a file is already open. An open that names no editor group lands in
 * the active one, the diagram's, and a file open in the group beside it got
 * a second editor there. An open asks here first: the group that already
 * shows the file, in the kind of editor wanted, is where it is revealed.
 */
import * as vscode from 'vscode';

/**
 * The kind of editor an open wants: the text editor, whatever `vscode.open`
 * gives (text, a notebook, a custom editor that is the file's default, but
 * not `exceptViewType`, the diagram's own editor), or one custom editor.
 */
export type OpenKind = 'text' | { default: true; exceptViewType?: string } | { viewType: string };

/**
 * The view types of the diagram editors in this window. A default open never
 * takes one for the file's editor: `vscode.open` on a source file gives its
 * text, and the diagram of that file open elsewhere is another thing.
 */
const diagramViewTypes = new Set<string>();

/** Tells the opens which custom editor is a diagram (each profile's, at activation). */
export function registerDiagramViewType(viewType: string): void {
    diagramViewTypes.add(viewType);
}

interface TabLike { input?: unknown }
interface GroupLike { viewColumn: vscode.ViewColumn; tabs: readonly TabLike[] }

function shows(input: unknown, uri: vscode.Uri, kind: OpenKind): boolean {
    if (!input || typeof input !== 'object') {
        return false;
    }
    const shown = (input as { uri?: unknown }).uri;
    // A diff has `original` and `modified`, no `uri`: it is not the file's editor.
    if (!shown || typeof (shown as vscode.Uri).toString !== 'function' || (shown as vscode.Uri).toString() !== uri.toString()) {
        return false;
    }
    const viewType = (input as { viewType?: unknown }).viewType;
    const custom = typeof viewType === 'string';
    const notebook = typeof (input as { notebookType?: unknown }).notebookType === 'string';
    if (kind === 'text') {
        return !custom && !notebook;
    }
    if ('viewType' in kind) {
        return custom && viewType === kind.viewType;
    }
    return !custom || (viewType !== kind.exceptViewType && !diagramViewTypes.has(viewType as string));
}

/**
 * The column of the group that already shows `uri` in the kind of editor
 * wanted: the active group when it does (nothing to say: an open goes there),
 * else the first that does. `undefined` when none does, or the active one.
 */
export function openColumnFor(
    uri: vscode.Uri,
    kind: OpenKind,
    groups: readonly GroupLike[] = vscode.window.tabGroups?.all ?? [],
    active: GroupLike | undefined = vscode.window.tabGroups?.activeTabGroup
): vscode.ViewColumn | undefined {
    const has = (group: GroupLike): boolean => group.tabs.some(tab => shows(tab.input, uri, kind));
    if (active && has(active)) {
        return undefined;
    }
    return groups.find(has)?.viewColumn;
}

/** `options` with the column the file is already open in, unless the caller named one. */
export function inPlace(uri: vscode.Uri, kind: OpenKind, options: vscode.TextDocumentShowOptions): vscode.TextDocumentShowOptions {
    if (options.viewColumn !== undefined) {
        return options;
    }
    const viewColumn = openColumnFor(uri, kind);
    return viewColumn === undefined ? options : { ...options, viewColumn };
}

/** The arguments of `vscode.openWith` for a custom editor: with the column the file is open in it, when it is. */
export function openWithArguments(uri: vscode.Uri, viewType: string): [vscode.Uri, string] | [vscode.Uri, string, vscode.ViewColumn] {
    const viewColumn = openColumnFor(uri, { viewType });
    return viewColumn === undefined ? [uri, viewType] : [uri, viewType, viewColumn];
}

/** A position as the diagram sends it, zero-based. */
interface SentPosition { line: number; character: number }

const isSentPosition = (value: unknown): value is SentPosition =>
    !!value && typeof value === 'object'
    && typeof (value as SentPosition).line === 'number' && typeof (value as SentPosition).character === 'number';

/**
 * How to show a file the diagram asks for with nothing but where in it
 * (`jsonOpenerOptions`): a double-click on a node with no diagram behind it,
 * or on a node that stands for a file. GLSP's own handler showed it in the
 * active group, the diagram's, whatever group already had the file; this is
 * its options, at the line asked for, in that group.
 */
export function plainOpenOptions(uri: vscode.Uri, args: Record<string, unknown> | undefined): vscode.TextDocumentShowOptions {
    let sent: Record<string, unknown> = {};
    const raw = args?.jsonOpenerOptions;
    if (typeof raw === 'string' && raw.trim() !== '') {
        try {
            const parsed = JSON.parse(raw);
            sent = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        } catch {
            sent = {};
        }
    }
    const selection = sent.selection as { start?: unknown; end?: unknown } | undefined;
    const options: vscode.TextDocumentShowOptions = {
        ...(typeof sent.viewColumn === 'number' ? { viewColumn: sent.viewColumn as vscode.ViewColumn } : {}),
        ...(typeof sent.preview === 'boolean' ? { preview: sent.preview } : {}),
        ...(typeof sent.preserveFocus === 'boolean' ? { preserveFocus: sent.preserveFocus } : {}),
        ...(selection && isSentPosition(selection.start) && isSentPosition(selection.end)
            ? { selection: new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character) }
            : {})
    };
    return inPlace(uri, 'text', options);
}
