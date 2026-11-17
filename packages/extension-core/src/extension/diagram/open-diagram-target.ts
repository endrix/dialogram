import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchesSourceExtension } from './source-extensions';

export type DiagramOpenTargetArg = vscode.Uri | string | {
    sourceUri?: string;
    uri?: string;
    filePath?: string;
    /**
     * Which named graph inside the file to open at.
     *
     * A source file can hold several graphs, and the platform can already show
     * one by name — but only once a diagram exists, because the name has only
     * ever arrived on a request the WEBVIEW originates: a drill-down, or a
     * cross-file navigation. A caller that knows the name BEFORE the editor
     * exists had nowhere to put it, which is what stopped a consumer from
     * asking "which module?" and opening at the answer.
     */
    networkName?: string;
};

/**
 * The named graph an open request asks for, if any.
 *
 * Separate from {@link resolveDiagramOpenTarget} because they fail differently:
 * a target that cannot be resolved means there is nothing to open, while an
 * absent name simply means "open at the default", which is what every existing
 * caller already relies on.
 */
export function readRequestedNetworkName(arg: DiagramOpenTargetArg | undefined): string | undefined {
    if (!arg || typeof arg === 'string' || arg instanceof vscode.Uri) {
        return undefined;
    }
    const name = typeof arg.networkName === 'string' ? arg.networkName.trim() : '';
    return name === '' ? undefined : name;
}

export type ResolveDiagramOpenTargetOptions = {
    getActiveWorkflowUri: () => vscode.Uri | undefined;
    openTextDocument: (uri: vscode.Uri) => Thenable<{ uri: vscode.Uri }>;
    /**
     * Whether a file is there, asked when it could not be opened as text.
     *
     * VS Code does not hand a file over 50 MB to extensions as a text
     * document, and a generated source can be larger: a circuit, a netlist.
     * The diagram of such a file is drawn from the file by its producer and
     * needs no text document, so a file that exists is a file to open. Absent,
     * a file that cannot be opened as text is not a target, as before.
     */
    fileExists?: (uri: vscode.Uri) => Thenable<boolean>;
    workspaceRoot?: string;
    /** The profile's declared source extensions; absent/empty accepts any file
     *  (see `source-extensions.ts` for why the default is permissive). */
    sourceExtensions?: readonly string[];
};

function isUriString(value: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function resolveRelativePath(value: string, workspaceRoot: string | undefined): vscode.Uri | undefined {
    if (!workspaceRoot) {
        return undefined;
    }
    return vscode.Uri.file(path.resolve(workspaceRoot, value));
}

function parseTargetCandidate(
    arg: DiagramOpenTargetArg | undefined,
    workspaceRoot: string | undefined
): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }

    if (typeof arg === 'string') {
        const trimmed = arg.trim();
        if (trimmed === '') {
            return undefined;
        }
        if (isUriString(trimmed)) {
            try {
                return vscode.Uri.parse(trimmed);
            } catch {
                return undefined;
            }
        }
        if (path.isAbsolute(trimmed)) {
            return vscode.Uri.file(trimmed);
        }
        return resolveRelativePath(trimmed, workspaceRoot);
    }

    const candidate = typeof arg?.sourceUri === 'string' && arg.sourceUri.trim() !== ''
        ? arg.sourceUri.trim()
        : typeof arg?.uri === 'string' && arg.uri.trim() !== ''
            ? arg.uri.trim()
            : typeof arg?.filePath === 'string' && arg.filePath.trim() !== ''
                ? arg.filePath.trim()
                : undefined;

    if (!candidate) {
        return undefined;
    }
    if (isUriString(candidate)) {
        try {
            return vscode.Uri.parse(candidate);
        } catch {
            return undefined;
        }
    }
    if (path.isAbsolute(candidate)) {
        return vscode.Uri.file(candidate);
    }
    return resolveRelativePath(candidate, workspaceRoot);
}

export async function resolveDiagramOpenTarget(
    arg: DiagramOpenTargetArg | undefined,
    options: ResolveDiagramOpenTargetOptions
): Promise<vscode.Uri | undefined> {
    const candidate = parseTargetCandidate(arg, options.workspaceRoot);
    const resolved = candidate ?? options.getActiveWorkflowUri();

    if (!resolved || resolved.scheme !== 'file' || !matchesSourceExtension(resolved.fsPath, options.sourceExtensions)) {
        return undefined;
    }

    try {
        const document = await options.openTextDocument(resolved);
        return document.uri;
    } catch {
        try {
            return options.fileExists && (await options.fileExists(resolved)) ? resolved : undefined;
        } catch {
            return undefined;
        }
    }
}

/** What the window has in front: each as VS Code reports it, any of them absent. */
export type ActiveSources = {
    /** The file the active diagram is of. */
    diagramUri?: vscode.Uri;
    /** The document of the active text editor. */
    textEditorUri?: vscode.Uri;
    /** The file the active tab shows, whatever shows it. */
    tabUri?: vscode.Uri;
};

/**
 * The source file a command with no argument is about: the active diagram's,
 * else the active text editor's, else the active tab's.
 *
 * The tab is asked last and has to be asked: a file over 50 MB is shown in a
 * text editor that extensions are not told about, so `activeTextEditor` is
 * absent while the file is on screen, and the command said "open a file first"
 * to someone looking at one.
 */
export function activeSourceUri(
    active: ActiveSources,
    isSource: (uri: vscode.Uri | undefined) => boolean
): vscode.Uri | undefined {
    return [active.diagramUri, active.textEditorUri, active.tabUri].find(uri => isSource(uri));
}