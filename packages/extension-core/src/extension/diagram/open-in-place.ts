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

/** The arg in which the diagram sends how to show a file, as JSON (GLSP's `jsonOpenerOptions`). */
export const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';

/** A position as the diagram sends it, zero-based. */
export type SerializedPosition = { line: number; character: number };
export type SerializedRange = { start: SerializedPosition; end: SerializedPosition };
export type ParsedShowOptions = Omit<vscode.TextDocumentShowOptions, 'selection'> & { selection?: SerializedRange };

/** A position a range can be made of: whole numbers, none negative (`vscode.Range` throws on those). */
export function isSerializedPosition(value: unknown): value is SerializedPosition {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const { line, character } = value as Record<string, unknown>;
    return Number.isInteger(line) && (line as number) >= 0 && Number.isInteger(character) && (character as number) >= 0;
}

export function isSerializedRange(value: unknown): value is SerializedRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return isSerializedPosition(v.start) && isSerializedPosition(v.end);
}

/** A range sent as an object or as its JSON. */
export function parseSerializedRangeArg(value: unknown): SerializedRange | undefined {
    if (isSerializedRange(value)) {
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(value);
        return isSerializedRange(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** The show options the diagram sent as JSON in `SHOW_OPTIONS_ARG`, if any. */
export function parseShowOptionsArg(args: Record<string, unknown> | undefined): ParsedShowOptions | undefined {
    const raw = args?.[SHOW_OPTIONS_ARG];
    if (typeof raw !== 'string' || raw.trim() === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as ParsedShowOptions : undefined;
    } catch {
        return undefined;
    }
}

export function serializedRangeToVscodeRange(range: SerializedRange): vscode.Range {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** A column VS Code takes: a group's (1 to 9), the active one (-1) or beside it (-2). */
function isViewColumn(value: unknown): value is vscode.ViewColumn {
    return Number.isInteger(value) && ((value as number) >= 1 || value === -1 || value === -2);
}

/**
 * How to show a file the diagram asks for with nothing but where in it: a
 * double-click on a node with no diagram behind it, or on a node that stands
 * for a file. GLSP's own handler showed it in the active group, the
 * diagram's, whatever group already had the file; this is its options (the
 * args, then the JSON in `SHOW_OPTIONS_ARG` over them, as GLSP read them) at
 * the line asked for, in that group. What is malformed is left out: a range
 * `vscode.Range` would throw on, a column VS Code has no group for.
 */
export function plainOpenOptions(uri: vscode.Uri, args: Record<string, unknown> | undefined): vscode.TextDocumentShowOptions {
    const sent: Record<string, unknown> = { ...(args ?? {}), ...(parseShowOptionsArg(args) ?? {}) };
    const options: vscode.TextDocumentShowOptions = {
        ...(isViewColumn(sent.viewColumn) ? { viewColumn: sent.viewColumn } : {}),
        ...(typeof sent.preview === 'boolean' ? { preview: sent.preview } : {}),
        ...(typeof sent.preserveFocus === 'boolean' ? { preserveFocus: sent.preserveFocus } : {}),
        ...(isSerializedRange(sent.selection) ? { selection: serializedRangeToVscodeRange(sent.selection) } : {})
    };
    return inPlace(uri, 'text', options);
}
