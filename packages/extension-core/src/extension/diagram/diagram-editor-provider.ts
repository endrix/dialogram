/**
 * Workflow GLSP Editor Provider
 * 
 * Implements the VS Code CustomEditorProvider for Workflow network diagrams.
 * Extends GlspEditorProvider to handle diagram webview setup and lifecycle.
 */

import { GlspEditorProvider, GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { RequestModelAction } from '@eclipse-glsp/protocol';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    LOADING_MESSAGE_TYPE,
    OUTLINE_ACTIVATE_MESSAGE,
    OUTLINE_REQUEST_MESSAGE,
    RevealNodeAction,
    VIEW_OPTIONS_CHANGED_MESSAGE,
    WORKFLOW_DIAGRAM_TYPE,
    normalizeLoadProgress,
    type LoadProgress,
    type LoadingMessage,
    type LoadingUpdate
} from '@dialogram/shared';
import { type DiagramClientBehavior, type DiagramProfile, type DiagramWatchAffects, type RevealRangeOptions } from '../../api';
import { listAcpConnectors, watchAcpConnectorChoice, workspaceDirFor } from '../chat/acp-connectors';
import { normalizeSourceUriKey } from '@dialogram/diagram-server/server/uri-keys';
import type { OutOfBandWrite } from '@dialogram/diagram-server/server/out-of-band-writes';
import { matchesSourceExtension, sourceWatchGlobs } from './source-extensions';
import { inPlace, openColumnFor } from './open-in-place';
import type { OutlineHost } from './outline-host';
import type { ViewOptionsHost } from './view-options-host';

const RUN_ID_ARG = 'wf:runId';

/** How many crumbs a trail has; none for no trail, or one that cannot be read. */
function crumbCount(navTrail: string | undefined): number {
    if (typeof navTrail !== 'string' || navTrail.trim() === '') {
        return 0;
    }
    try {
        const parsed: unknown = JSON.parse(navTrail);
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}

/** What an editor shows, which its refreshes ask for again: the view, not only the file. */
export interface DiagramViewRecord {
    networkName?: string;
    navTrail?: string;
    queueTraceVisible?: boolean;
    runId?: string;
    shownSourceUri?: string;
}

/**
 * One diagram editor: a webview panel on a document, with its GLSP client.
 *
 * A file can have more than one: "View: Split Editor Right" on a diagram
 * makes a second editor of the same file, with a panel and a client of its
 * own, and either can be closed first. What is kept per editor
 * is everything an editor has of its own: its client, its webview, and the
 * view it shows (navigating in place, which graph of which file under which
 * crumbs).
 */
interface DiagramEditor {
    clientId: string;
    /** The document's canonical key ({@link normalizeSourceUriKey}). */
    documentKey: string;
    /** The document's URI as VS Code spells it: what a product is handed. */
    documentUri: string;
    webview?: vscode.Webview;
    panel?: vscode.WebviewPanel;
    view?: DiagramViewRecord;
    /** Rises each time the editor opens or becomes active: which of a file's editors was used last. */
    lastActive: number;
}

/**
 * Source of live-overlay signatures, injected by the host (glsp-activation wires
 * this from the toolkit's `CliRunDriver`). The provider no longer reads
 * `run.wf-viewer.live.json` itself: it registers each open diagram via
 * {@link LiveOverlaySignatureSource.watch} and refreshes on signature change via
 * {@link LiveOverlaySignatureSource.onSignature}. When no source is attached
 * (e.g. read-only/mlir profiles with no run driver), the provider's signature
 * map is simply never fed — matching the old absent-overlay-file path.
 */
export interface LiveOverlaySignatureSource {
    /** Begin polling a source URI's overlay; dispose to stop. */
    watch(sourceUri: vscode.Uri): { dispose(): void };
    /** Subscribe to signature updates for all watched URIs. */
    onSignature(listener: (sourceUri: string, signature: string | undefined) => void): { dispose(): void };
}

/**
 * Workflow Network Diagram Editor Provider
 * 
 * This provider handles:
 * - Opening .cal files as network diagrams
 * - Setting up the webview with the Sprotty/GLSP client
 * - Managing document lifecycle (save, revert, backup)
 */
export class WorkflowEditorProvider extends GlspEditorProvider {
    protected get assetsBaseUri(): vscode.Uri {
        return this.assetsUri ?? this.extensionContext.extensionUri;
    }

    /**
     * The diagram type identifier matching the server's diagram module
     */
    readonly diagramType = WORKFLOW_DIAGRAM_TYPE;

    /**
     * A diagram is never dirty: each edit is on disk when it is made (the edit
     * commands save the source they change, and the layout is written as it
     * moves). GLSP reports every operation to VS Code as an unsaved edit of the
     * document, so a diagram showed ● after any command, an auto-layout as well
     * as an edit, and asked to save on close what was already saved. No edit is
     * reported: undo and redo are the products' own keys, bound to the diagram's
     * command stack (`<ns>.glsp.undo` / `redo`), not VS Code's edit stack.
     */
    private readonly neverChanges = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
    override get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.neverChanges.event;
    }

    /**
     * Every diagram editor open, by its client. Kept per editor and not per
     * file: one entry per file, written by each editor that opened and deleted
     * by any that closed, took the entry of the editor left open with it, and
     * that editor stopped hearing saves and changes on disk.
     */
    private readonly editors = new Map<string, DiagramEditor>();
    private activity = 0;
    /** The run's overlay signature, by file: it is the file's run, whichever editors show it. */
    private uriToLiveOverlaySignature = new Map<string, string | undefined>();

    /**
     * Where the outline's requests for rows, and its clicks on rows that are
     * the product's, go (outline-host.ts); set by the activation.
     */
    outlineHost?: Pick<OutlineHost, 'onWebviewRequest' | 'onWebviewActivate'>;

    /**
     * Fires each time a webview (re)registers for a document (initial open and
     * every reopen), with the document's URI string and the client that
     * registered. The host wires this to drain the execution-overlay replay
     * buffer through the bridge so a webview reopened mid-run comes back with
     * the live "Running agents" bar rather than empty: to the editor that is
     * new, and not to the file's other editor, which has it already. The URI
     * is emitted as `document.uri.toString()` — the same representation run
     * drivers emit with — so the replay lookup keys match.
     */
    private readonly registerEditorEmitter = new vscode.EventEmitter<{ uri: string; clientId: string }>();
    readonly onDidRegisterEditor: vscode.Event<{ uri: string; clientId: string }> = this.registerEditorEmitter.event;

    /** Injected live-overlay signature source (the run driver). The provider drives
     *  live-execution glow purely off the signatures this source publishes; the
     *  file read + out-dir resolution now live in the driver. */
    private liveOverlayWatch?: (sourceUri: vscode.Uri) => { dispose(): void };
    private liveOverlaySignatureSubscription?: { dispose(): void };
    private readonly uriToLiveOverlayWatch = new Map<string, { dispose(): void }>();

    /**
     * Where the reader's view-option changes go (view-options-host.ts): set
     * by the activation, which makes the host before the server, and the
     * provider after.
     */
    viewOptionsHost?: Pick<ViewOptionsHost, 'onWebviewChange'>;

    /**
     * Debounce timers for live document change updates.
     * Maps document URI to timeout handle.
     */
    private changeDebounceTimers = new Map<string, NodeJS.Timeout>();

    /** Debounce timer for external (on-disk) source changes picked up by the watcher. */
    private externalRefreshTimer?: NodeJS.Timeout;
    /** The files changed on disk within the debounce window: for a profile that says which diagrams each affects. */
    private readonly pendingExternalChanges = new Set<string>();
    /** When each source file was last saved through the editor, to skip the watcher's
     *  duplicate refresh for an in-editor save (the save handler already refreshed). */
    private lastSavedAt = new Map<string, number>();
    /** Each file an edit's producer last wrote and its diagrams were reloaded for: what it then held (a digest), and when. */
    private readonly reloadedOutOfBandWrites = new Map<string, { digest: string; at: number }>();

    /**
     * Debounce delay in milliseconds for live document changes.
     */
    private static readonly CHANGE_DEBOUNCE_MS = 500;
    private static readonly EXTERNAL_REFRESH_DEBOUNCE_MS = 250;
    /**
     * How long after a producer's write the watcher's report of a file
     * holding that same text is taken for the report of that write, which
     * the diagrams were already reloaded for. The report comes within a
     * second or so of the write when the watcher works at all.
     */
    private static readonly OUT_OF_BAND_ECHO_MS = 5000;

    /**
     * Path segments that mark a watched source file as a build artifact /
     * irrelevant tree, NOT a source module worth reloading open diagrams for.
     * The profile's watch glob fires for every matching file in the workspace,
     * so without this filter unrelated generated files thrash the diagram.
     *
     * Incident this guards against: in a CMake-based workspace, the build tool
     * regenerated a source file under `build/test/` on every configure, which the
     * watcher treated as a cross-file import edit and force-reloaded the open diagram
     * 4+ times in seconds — each reload paying 1-2.3s of source-CLI spawn (`acquire`)
     * plus a full webview re-render. A file whose path contains any of these
     * segments is never a legitimate reload trigger.
     *
     * It matters more now that the watcher can be told to watch everything: a
     * profile that declares no source extensions gets `**\/*`, and this filter is
     * what keeps a build tree from reloading diagrams it has nothing to do with.
     */
    private static readonly ARTIFACT_PATH_SEGMENTS: ReadonlySet<string> = new Set([
        'build', 'dist', 'out', 'wf-out', 'node_modules', '.git', '__pycache__', '.venv', 'venv'
    ]);

    /**
     * True when the URI lives under an artifact / irrelevant directory (see
     * {@link ARTIFACT_PATH_SEGMENTS}). Segment-based, so it matches at any depth
     * (`.../build/test/generated-config`) without matching filenames that merely
     * contain a segment word (`build_config`).
     */
    private isUnderArtifactDir(uri: vscode.Uri): boolean {
        const segments = uri.path.split('/');
        // Exclude the final segment (the filename); only directory segments count.
        for (let i = 0; i < segments.length - 1; i++) {
            if (WorkflowEditorProvider.ARTIFACT_PATH_SEGMENTS.has(segments[i])) {
                return true;
            }
        }
        return false;
    }

    private canonicalizeUriString(uriOrString: vscode.Uri | string): string {
        // Delegates to the ONE shared key function (`normalizeSourceUriKey`) so the
        // provider's client/URI resolution and the execution-overlay replay buffer
        // key identically (Task-4 review M2). Same canonicalization as the former
        // inline body — a valid `vscode.Uri.toString()` round-trips losslessly.
        return normalizeSourceUriKey(typeof uriOrString === 'string' ? uriOrString : uriOrString.toString());
    }

    constructor(
        protected readonly extensionContext: vscode.ExtensionContext,
        protected override readonly glspVscodeConnector: GlspVscodeConnector,
        protected readonly profile: DiagramProfile,
        protected readonly assetsUri?: vscode.Uri
    ) {
        super(glspVscodeConnector);

        extensionContext.subscriptions.push(this.registerEditorEmitter);

        // Listen for document changes for live preview (debounced)
        extensionContext.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                this.handleDocumentChange(e);
            })
        );

        // Listen for document saves to trigger diagram updates (immediate, force reload)
        extensionContext.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                this.handleDocumentSave(doc);
            })
        );

        // Catch EXTERNAL source writes — the chat agent editing via the MCP edit
        // backend, git, a formatter, etc. Those bypass the editor (no onDidChange/Save),
        // so without this the diagram wouldn't reflect agent-added nodes until a manual
        // save/reopen. onDidChangeTextDocument only fires for in-editor edits.
        //
        // What to watch comes from the profile, in that order of specificity:
        // `watch.globs` is the exact answer when a product has one (it can watch
        // more than its own sources — a manifest, a generated index); otherwise the
        // globs are derived from the declared extensions; otherwise everything.
        // Until this was wired the field existed and nothing read it, and the
        // watcher was pinned to one product's extension.
        const onExternal = (uri: vscode.Uri) => this.handleExternalFileChange(uri);
        for (const glob of profile.watch?.globs ?? sourceWatchGlobs(profile.sourceExtensions)) {
            const sourceWatcher = vscode.workspace.createFileSystemWatcher(glob);
            sourceWatcher.onDidChange(onExternal);
            sourceWatcher.onDidCreate(onExternal);
            extensionContext.subscriptions.push(sourceWatcher);
        }
    }

    /**
     * Set up the webview content for the diagram editor.
     * 
     * This method is called when a custom editor is opened.
     * It configures the webview with the GLSP diagram client.
     * 
     * @param document - The document being edited
     * @param webviewPanel - The webview panel for the editor
     * @param token - Cancellation token
     * @param clientId - Unique client identifier for this session
     */
    setUpWebview(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
        clientId: string
    ): void {
        // Track this editor. Its file may have another already.
        const { key: canonicalDocumentUri, first } = this.trackEditor(document.uri, clientId, webviewPanel.webview, webviewPanel);

        // Ask the injected source (run driver) to poll this diagram's live overlay:
        // once per file, for as long as any editor shows it.
        if (first) {
            this.startLiveOverlayWatch(canonicalDocumentUri, document.uri);
        }

        // Announce the (re)registration so the host can replay any buffered
        // execution-overlay events for this source into the (re)opened webview.
        // Fired synchronously here: the drain runs before any later live batch on
        // the single-threaded host loop, preserving replay-before-live order.
        this.registerEditorEmitter.fire({ uri: document.uri.toString(), clientId });

        // Which of a file's editors was used last: the one a command for "the"
        // diagram of the file goes to when neither is focused.
        webviewPanel.onDidChangeViewState?.(event => {
            const editor = this.editors.get(clientId);
            if (editor && event.webviewPanel.active) {
                editor.lastActive = ++this.activity;
            }
        });

        // Clean up when webview is disposed: this editor's entry, and what is
        // the file's only with its last editor.
        webviewPanel.onDidDispose(() => {
            const gone = this.untrackEditor(clientId);
            if (gone?.last) {
                this.uriToLiveOverlaySignature.delete(canonicalDocumentUri);
                this.stopLiveOverlayWatch(canonicalDocumentUri);
                this.tellProfile('onEditorClosed', document.uri.toString());
            }
        });

        if (first) {
            this.tellProfile('onEditorOpened', document.uri.toString());
        }

        const webview = webviewPanel.webview;

        webview.onDidReceiveMessage(async message => {
            try {
                if (message?.type === 'dialogram.diagram.clientDebug.webviewError') {
                    // eslint-disable-next-line no-console
                    console.error('[cal-diagram][webview] error', message.payload);
                    return;
                }
                if (message?.type === 'dialogram.diagram.clientDebug.webviewUnhandledRejection') {
                    // eslint-disable-next-line no-console
                    console.error('[cal-diagram][webview] unhandledrejection', message.payload);
                    return;
                }

                if (message?.type === 'dialogram.ui.quickPick') {
                    const requestId = message.payload?.requestId as string | undefined;
                    const items = (message.payload?.items as Array<any> | undefined) ?? [];
                    const placeHolder = message.payload?.placeHolder as string | undefined;

                    const picked = await vscode.window.showQuickPick(
                        items.map(it => ({
                            label: String(it.label ?? it.id ?? ''),
                            description: it.description ? String(it.description) : undefined,
                            detail: it.detail ? String(it.detail) : undefined,
                            id: String(it.id ?? it.label ?? '')
                        })),
                        { placeHolder }
                    );

                    await webview.postMessage({
                        type: 'dialogram.ui.response',
                        payload: { requestId, result: picked?.id }
                    });
                    return;
                }

                if (message?.type === 'dialogram.ui.inputBox') {
                    const requestId = message.payload?.requestId as string | undefined;
                    const prompt = message.payload?.prompt as string | undefined;
                    const value = message.payload?.value as string | undefined;
                    const placeHolder = message.payload?.placeHolder as string | undefined;

                    const result = await vscode.window.showInputBox({ prompt, value, placeHolder });
                    await webview.postMessage({
                        type: 'dialogram.ui.response',
                        payload: { requestId, result }
                    });
                    return;
                }

                if (message?.type === 'dialogram.svg.extracted') {
                    await this.saveExtractedSvg(canonicalDocumentUri, message.payload ?? {});
                    return;
                }

                // A diagram surface's image (diagram-client svg-export-command.ts):
                // the reply of the one editor the export command was sent to
                // (glsp-activation.ts), so one dialog asks where to save it.
                if (message?.type === 'dialogram.png.extracted') {
                    await this.saveExtractedPng(canonicalDocumentUri, message.payload ?? {});
                    return;
                }

                // The outline asks for rows of a lazy group, or where one is:
                // answered to this editor only, which is the one scrolling (a
                // file's other editor scrolls its own list), and to nothing
                // when it has closed while the producer was answering.
                if (message?.type === OUTLINE_REQUEST_MESSAGE) {
                    if (this.outlineHost) {
                        await this.outlineHost.onWebviewRequest(message.payload, reply => {
                            this.postToClient(clientId, reply);
                        });
                    }
                    return;
                }

                // A row of the outline that is the product's was clicked.
                if (message?.type === OUTLINE_ACTIVATE_MESSAGE) {
                    await this.outlineHost?.onWebviewActivate(message.payload);
                    return;
                }

                if (message?.type === 'dialogram.svg.failed') {
                    const reason = message.payload?.reason as string | undefined;
                    const format = message.payload?.format === 'PNG' ? 'PNG' : 'SVG';
                    void vscode.window.showWarningMessage(`Could not export the diagram as ${format}${reason ? `: ${reason}` : '.'}`);
                    return;
                }

                if (message?.type === 'dialogram.ui.infoMessage') {
                    const text = message.payload?.message as string | undefined;
                    if (text) {
                        void vscode.window.showInformationMessage(text);
                    }
                    return;
                }

                if (message?.type === 'dialogram.ui.errorMessage') {
                    const text = message.payload?.message as string | undefined;
                    if (text) {
                        void vscode.window.showErrorMessage(text);
                    }
                    return;
                }

                if (message?.type === 'dialogram.ui.getViewerEditors') {
                    const requestId = message.payload?.requestId as string | undefined;

                    const cfg = vscode.workspace.getConfiguration(this.profile.settingsNamespace);
                    const raw = cfg.get<any[]>('viewerEditors') ?? [];
                    const editors = Array.isArray(raw)
                        ? raw
                              .map(e => ({
                                  label: String(e?.label ?? ''),
                                  viewType: String(e?.viewType ?? ''),
                                  description: e?.description !== undefined ? String(e.description) : undefined
                              }))
                              .filter(e => e.label.trim().length > 0 && e.viewType.trim().length > 0)
                        : [];

                    await webview.postMessage({
                        type: 'dialogram.ui.response',
                        payload: { requestId, result: editors }
                    });
                    return;
                }

                if (message?.type === 'dialogram.ui.appendViewerEditor') {
                    const requestId = message.payload?.requestId as string | undefined;
                    const editor = message.payload?.editor as any;
                    const label = String(editor?.label ?? '').trim();
                    const viewType = String(editor?.viewType ?? '').trim();
                    const description = editor?.description !== undefined ? String(editor.description) : undefined;

                    if (!label || !viewType) {
                        await webview.postMessage({
                            type: 'dialogram.ui.response',
                            payload: { requestId, result: false }
                        });
                        return;
                    }

                    const cfg = vscode.workspace.getConfiguration(this.profile.settingsNamespace);
                    const raw = cfg.get<any[]>('viewerEditors') ?? [];
                    const existing = Array.isArray(raw) ? raw : [];

                    // De-dupe by viewType (keep first match).
                    const has = existing.some(e => String(e?.viewType ?? '').trim() === viewType);
                    const next = has
                        ? existing
                        : [...existing, { label, viewType, ...(description ? { description } : {}) }];

                    // Prefer user-global setting to make it portable.
                    await cfg.update('viewerEditors', next, vscode.ConfigurationTarget.Global);

                    await webview.postMessage({
                        type: 'dialogram.ui.response',
                        payload: { requestId, result: true }
                    });
                    return;
                }

                if (message?.type === 'dialogram.ui.executeCommand') {
                    const requestId = message.payload?.requestId as string | undefined;
                    const command = message.payload?.command as string | undefined;
                    const args = (message.payload?.args as unknown[] | undefined) ?? [];

                    if (!requestId || !command) {
                        return;
                    }

                    try {
                        const normalizedArgs = [...args];
                        // These commands take a Uri as their first argument; the webview can only
                        // send a string path, so convert it here (markdown preview included).
                        const uriFirstArgCommands = new Set([
                            'vscode.open',
                            'vscode.openWith',
                            'markdown.showPreview',
                            'markdown.showPreviewToSide'
                        ]);
                        if (uriFirstArgCommands.has(command) && typeof normalizedArgs[0] === 'string') {
                            const raw = String(normalizedArgs[0]).trim();
                            if (raw.length > 0 && !/^\w+:\/\//.test(raw)) {
                                normalizedArgs[0] = vscode.Uri.file(raw);
                            }
                        }

                        const result = await vscode.commands.executeCommand(command, ...normalizedArgs);
                        await webview.postMessage({
                            type: 'dialogram.ui.response',
                            payload: { requestId, result }
                        });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await webview.postMessage({
                            type: 'dialogram.ui.response',
                            payload: { requestId, result: { error: msg } }
                        });
                    }
                    return;
                }

                // The reader changed what is shown, in the palette: the host
                // keeps it for the file (beside it, on disk), tells the
                // product, and tells every diagram of the file, this one
                // too. Only for a file this editor shows: what is written
                // beside a file is that editor's to change.
                if (message?.type === VIEW_OPTIONS_CHANGED_MESSAGE) {
                    if (this.shows(clientId, message.payload)) {
                        await this.viewOptionsHost?.onWebviewChange(message.payload);
                    }
                    return;
                }

                // Consumer-owned inbound messages: everything the built-in debug /
                // dialogram.ui.* handlers above did not already consume. Absent hook
                // → the message is ignored, byte-identical to prior behavior.
                if (this.profile.onWebviewMessage) {
                    await this.profile.onWebviewMessage(document.uri.toString(), message, {
                        postToWebview: (msg: unknown) => {
                            void webview.postMessage(msg);
                        },
                        revealRange: (uriStr, range, options) => this.revealRange(uriStr, range, options)
                    });
                    return;
                }
            } catch (err) {
                console.warn('[dialogram provider] webview message handling failed:', err);
            }
        });

        // Resolve which client bundle to serve: the stock one, or a consumer's
        // configured `clientAssets`.
        const assets = this.resolveClientAssets(webview);

        // Enable scripts in the webview
        webview.options = {
            enableScripts: true,
            localResourceRoots: assets.localResourceRoots
        };

        // Set the webview HTML content
        webview.html = this.getWebviewContent(webview, {
            scriptUri: assets.scriptUri,
            libavoidWasmUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'libavoid.wasm'),
            libavoidModuleUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'libavoid.mjs'),
            styleUri: assets.styleUri,
            extraStyleUris: assets.extraStyleUris,
            clientId,
            documentUri: document.uri.toString()
        });
        this.postClientBehaviorExtras(document.uri.toString(), webview);
        // A connector declared, or removed, in a connectors file is in the
        // list the agent panel offers without opening the diagram again.
        const acpConnector = this.profile.chat?.acpConnector;
        if (acpConnector) {
            const watch = watchAcpConnectorChoice(this.profile.settingsNamespace, acpConnector, () =>
                this.postClientBehaviorExtras(document.uri.toString(), webview));
            webviewPanel.onDidDispose(() => watch.dispose());
        }
    }

    /**
      * Handle document save events to trigger diagram updates.
      * On save, we refresh affected diagrams and force reload from disk.
     */
    protected handleDocumentSave(document: vscode.TextDocument): void {
        // Only react to source-file saves.
        if (!matchesSourceExtension(document.uri.path, this.profile.sourceExtensions)) {
            return;
        }

        const savedUriString = this.canonicalizeUriString(document.uri);
        // Record the save so the on-disk watcher skips its duplicate refresh for
        // this same change (the loop below already force-reloads).
        this.lastSavedAt.set(savedUriString, Date.now());
        // What it holds now is the save's: a producer's write before it is
        // no longer the file's text to skip a report of.
        this.reloadedOutOfBandWrites.delete(savedUriString);

        // Cancel any pending debounced change update for the saved document
        // since we're doing a full refresh.
        const pendingTimer = this.changeDebounceTimers.get(savedUriString);
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.changeDebounceTimers.delete(savedUriString);
        }

        // Refresh all open diagrams on save so cross-file references (including sibling/deep imports)
        // pick up persisted changes immediately: every editor, two of one file included. A
        // profile that says which diagrams a file affects (`watch.affects`) has only those.
        this.reloadAffectedBy([document.uri.toString()], 'Document saved');
    }

    /**
     * React to a source file changing ON DISK from outside the editor — the chat agent
     * writing via the MCP edit backend, git, a formatter, etc. In-editor edits go
     * through handleDocumentChange/handleDocumentSave instead, so here we:
     *  - skip files open with unsaved edits (the editor owns those),
     *  - skip a change we just produced via an in-editor save (deduped by time), and
     *  - skip the report of a producer's write already reloaded for (deduped by
     *    content; see {@link reloadAfterOutOfBandWrites}).
     * A changed module can be a cross-file import of an open workflow, so — like
     * save — refresh every open diagram. Debounced to coalesce edit bursts.
     */
    protected handleExternalFileChange(uri: vscode.Uri): void {
        if (!this.changeOnDiskReloads(uri)) {
            return;
        }
        const canonical = this.canonicalizeUriString(uri);

        // The editor's own save handler already refreshed for this write.
        const savedAt = this.lastSavedAt.get(canonical);
        if (savedAt !== undefined && Date.now() - savedAt < 1500) {
            return;
        }
        // Unsaved in-editor edits are handled by the live-preview change handler.
        if (this.isOpenDirty(canonical)) {
            return;
        }
        // The report of a write an edit's producer made, which the diagrams
        // were reloaded for when it was made: the file still holds what it
        // wrote. Holding anything else, it has changed since, and reloads.
        const written = this.reloadedOutOfBandWrites.get(canonical);
        if (written && Date.now() - written.at < WorkflowEditorProvider.OUT_OF_BAND_ECHO_MS) {
            void holdsText(uri, written.digest).then(same => {
                if (!same) {
                    // Changed since: that write is no longer the file's
                    // text, and a later report of it is a change back.
                    if (this.reloadedOutOfBandWrites.get(canonical) === written) {
                        this.reloadedOutOfBandWrites.delete(canonical);
                    }
                    this.scheduleReloadFromDisk(uri);
                }
            });
            return;
        }
        this.reloadedOutOfBandWrites.delete(canonical);
        this.scheduleReloadFromDisk(uri);
    }

    /**
     * Reload the diagrams that files an edit's producer wrote itself affect
     * (`writes`, from the command stack; see out-of-band-writes.ts), without
     * waiting for the file watcher.
     *
     * Nothing else in VS Code saw the write: the editor applied nothing, and
     * the diagrams were reloaded only when the watcher reported the file
     * changed. A watcher can report nothing (a machine out of inotify
     * instances gives every new window one that does not), and the edit was
     * then written and not drawn. The reload is the watcher's, with its
     * wait, so the edits of a burst are one reload and the diagram's own
     * submit after the edit is over first; and as the watcher's, it leaves a
     * file open with unsaved changes to the live preview. A save of the
     * file a moment before does not keep it back: this write is not that
     * save's.
     *
     * The watcher's report of the same write, when it comes, finds the text
     * written and reloads nothing more ({@link handleExternalFileChange}).
     */
    reloadAfterOutOfBandWrites(writes: readonly OutOfBandWrite[]): void {
        // Only writes the watcher may still report are kept.
        const now = Date.now();
        for (const [file, { at }] of this.reloadedOutOfBandWrites) {
            if (now - at >= WorkflowEditorProvider.OUT_OF_BAND_ECHO_MS) {
                this.reloadedOutOfBandWrites.delete(file);
            }
        }
        for (const write of writes) {
            const uri = vscode.Uri.parse(write.uri);
            const canonical = this.canonicalizeUriString(uri);
            if (!this.changeOnDiskReloads(uri) || this.isOpenDirty(canonical)) {
                continue;
            }
            this.reloadedOutOfBandWrites.set(canonical, { digest: digestOf(write.text), at: Date.now() });
            this.scheduleReloadFromDisk(uri);
        }
    }

    /**
     * Whether a change on disk to `uri` is one to reload diagrams for: a
     * source, or any file for a profile that says what each affects, while a
     * diagram is open, and not a build artifact unless it is an open
     * diagram's own source.
     */
    private changeOnDiskReloads(uri: vscode.Uri): boolean {
        // A file that is not a source is heard only by a profile that says what
        // it affects: without that, a side file (a manifest, a configuration)
        // would reload every diagram, as a source does. With it, the profile is
        // asked about every file its watch globs see.
        const affects = this.profile.watch?.affects;
        if ((!affects && !matchesSourceExtension(uri.path, this.profile.sourceExtensions)) || this.editors.size === 0) {
            return false;
        }
        // Always reload when the changed file IS an open diagram's own source. For
        // any OTHER watched file, keep the cross-file-import reload but skip build
        // artifacts / irrelevant trees (see isUnderArtifactDir) so generated files
        // under a build tree don't thrash open diagrams.
        const isOwnSource = this.editorsOfDocument(this.canonicalizeUriString(uri)).length > 0;
        return isOwnSource || !this.isUnderArtifactDir(uri);
    }

    /** Whether the file `canonical` names is open in a text editor with unsaved changes. */
    private isOpenDirty(canonical: string): boolean {
        return vscode.workspace.textDocuments.some(
            d => this.canonicalizeUriString(d.uri) === canonical && d.isDirty
        );
    }

    /**
     * Reload, from disk and after the watcher's wait, the diagrams a change to
     * `uri` affects. Every file changed in the window is kept: a burst that
     * touches a side file and then a source reloads what either affects, not
     * what the last one does.
     */
    private scheduleReloadFromDisk(uri: vscode.Uri): void {
        this.pendingExternalChanges.add(uri.toString());
        if (this.externalRefreshTimer) {
            clearTimeout(this.externalRefreshTimer);
        }
        this.externalRefreshTimer = setTimeout(() => {
            this.externalRefreshTimer = undefined;
            const changed = [...this.pendingExternalChanges];
            this.pendingExternalChanges.clear();
            this.reloadAffectedBy(changed, 'External change');
        }, WorkflowEditorProvider.EXTERNAL_REFRESH_DEBOUNCE_MS);
    }

    /**
     * Reload, from disk, the diagrams a change to `changed` (URI strings)
     * affects: every open one, as it always was, or, for a profile that says
     * (`watch.affects`), the ones it names and the changed files' own. Every
     * editor of such a file is reloaded, not one.
     */
    private reloadAffectedBy(changed: readonly string[], why: string): void {
        const affects = this.profile.watch?.affects;
        const reload = (documents: ReadonlySet<string>): void => {
            for (const editor of [...this.editors.values()]) {
                if (!documents.has(editor.documentKey)) {
                    continue;
                }
                console.log(`[WorkflowEditorProvider] ${why}: ${changed.join(', ')}; force-reloading diagram for client ${editor.clientId} (source ${editor.documentKey}).`);
                this.dispatchModelRefresh(editor.clientId, editor.documentKey, { forceReloadFromDisk: true });
            }
        };
        if (!affects) {
            reload(new Set(this.openDocumentKeys()));
            return;
        }
        void this.documentsAffectedBy(changed, affects).then(reload);
    }

    /**
     * The open documents the profile says a change to `changed` affects, with
     * each changed file's own. A hook that fails reloads every open diagram:
     * a reload too many is cheaper than a diagram left stale without a word.
     */
    private async documentsAffectedBy(
        changed: readonly string[],
        affects: DiagramWatchAffects
    ): Promise<Set<string>> {
        const open = this.openDocumentKeys();
        // Handed as VS Code spells them, which is how the product was handed them in `getGraph`.
        const openUris = open.map(key => this.editorsOfDocument(key)[0]?.documentUri ?? key);
        const affected = new Set<string>();
        for (const file of changed) {
            const own = this.canonicalizeUriString(file);
            if (open.includes(own)) {
                affected.add(own);
            }
            try {
                const named = (await affects(file, openUris)) as readonly string[] | undefined;
                for (const uri of Array.isArray(named) ? named : []) {
                    const key = this.canonicalizeUriString(uri);
                    if (open.includes(key)) {
                        affected.add(key);
                    }
                }
            } catch (error) {
                console.warn(`[WorkflowEditorProvider] watch.affects failed for ${file}; reloading every open diagram:`, error);
                return new Set(this.openDocumentKeys());
            }
        }
        return affected;
    }

    /**
     * Handle document change events for live preview (debounced).
     * Only updates if the document has an open diagram.
     * 
     * Live updates are sent with the current document content so the server
     * can re-parse and re-generate the diagram without touching the file system.
     */
    protected handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const uriString = this.canonicalizeUriString(event.document.uri);

        // Not an editor's own document, but possibly a nested workflow's file
        // shown in another editor's view: preview it there.
        if (this.editorsOfDocument(uriString).length === 0) {
            this.previewInViewsShowing(event);
            return;
        }
        
        // Ignore empty changes
        if (event.contentChanges.length === 0) {
            return;
        }
        
        // Debounce: cancel previous timer if exists
        const existingTimer = this.changeDebounceTimers.get(uriString);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // Schedule a new update
        const timer = setTimeout(() => {
            this.changeDebounceTimers.delete(uriString);
            // Send the current document content for live preview, to every
            // editor of the document open when the wait is over.
            const content = event.document.getText();
            for (const editor of this.editorsOfDocument(uriString)) {
                console.log(`[WorkflowEditorProvider] Document changed (debounced): ${uriString}. Triggering live diagram update for client: ${editor.clientId}`);
                this.dispatchModelRefresh(editor.clientId, uriString, {
                    content
                });
            }
        }, WorkflowEditorProvider.CHANGE_DEBOUNCE_MS);
        
        this.changeDebounceTimers.set(uriString, timer);
    }

    /**
     * Live preview for a file that is not an editor's document but is shown in
     * one: a nested workflow navigated into in place. Each editor showing it is
     * refreshed with that file's current text, debounced as its own document is.
     */
    protected previewInViewsShowing(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0) {
            return;
        }
        const changed = this.canonicalizeUriString(event.document.uri);
        for (const { clientId: editorClientId, documentKey: editorUri, view } of this.editors.values()) {
            const shown = view?.shownSourceUri;
            if (!shown || this.canonicalizeUriString(shown) !== changed) {
                continue;
            }
            const timerKey = `${editorClientId}::${changed}`;
            const existing = this.changeDebounceTimers.get(timerKey);
            if (existing) {
                clearTimeout(existing);
            }
            this.changeDebounceTimers.set(timerKey, setTimeout(() => {
                this.changeDebounceTimers.delete(timerKey);
                this.dispatchModelRefresh(editorClientId, editorUri, {
                    content: event.document.getText(),
                    contentUri: changed
                });
            }, WorkflowEditorProvider.CHANGE_DEBOUNCE_MS));
        }
    }

    /**
     * Dispatch a RequestModelAction to refresh the diagram.
     * 
     * @param clientId - The GLSP client session ID
     * @param sourceUri - The document URI
     * @param options - Additional options (content for live preview, forceReloadFromDisk for save)
     */
    protected dispatchModelRefresh(
        clientId: string,
        sourceUri: string,
        options: { content?: string; forceReloadFromDisk?: boolean; contentUri?: string; silent?: boolean } = {}
    ): void {
        // The view of THIS editor: a file's other editor may show another.
        const editor = this.editors.get(clientId);
        const refreshContext = editor ? editor.view : this.getRefreshContext(sourceUri);

        // The editor refreshes the view it shows. Navigating in place that can be
        // a workflow in another file than the editor's own document: refresh that
        // file, from disk -- live-preview `content` is the editor document's text,
        // which is not the shown file's.
        const shownSourceUri = refreshContext?.shownSourceUri;
        const showsOtherFile = typeof shownSourceUri === 'string'
            && this.canonicalizeUriString(shownSourceUri) !== this.canonicalizeUriString(sourceUri);
        // `content` is the text of `contentUri` when given, of the editor's
        // document otherwise. It previews the view only if it is the shown file's.
        const { contentUri, silent, ...rest } = options;
        const contentFile = this.canonicalizeUriString(contentUri ?? sourceUri);
        const shownFile = this.canonicalizeUriString(showsOtherFile ? shownSourceUri! : sourceUri);
        const effectiveOptions = rest.content !== undefined && contentFile !== shownFile
            ? { forceReloadFromDisk: true }
            : rest;

        // Create a RequestModelAction to refresh the diagram
        // A silent refresh carries a request id the server's model handler
        // recognises (`refresh-live-overlay-`): no "Model loading in progress"
        // status is started for it. The run's overlay changes on every firing;
        // a notification per firing is noise.
        const action = RequestModelAction.create({
            requestId: (silent ? 'refresh-live-overlay-' : 'refresh-') + Date.now(),
            options: {
                sourceUri: showsOtherFile ? shownSourceUri : sourceUri,
                diagramType: this.diagramType,
                ...(typeof refreshContext?.queueTraceVisible === 'boolean' ? { queueTraceVisible: refreshContext.queueTraceVisible } : {}),
                ...(refreshContext?.networkName ? { networkName: refreshContext.networkName } : {}),
                ...(refreshContext?.navTrail ? { 'wf:navTrail': refreshContext.navTrail } : {}),
                ...(refreshContext?.runId ? { [RUN_ID_ARG]: refreshContext.runId } : {}),
                ...effectiveOptions
            }
        });

        // Use the connector's dispatchAction method to properly route the action
        // through both client and server channels
        this.glspVscodeConnector.dispatchAction(action, clientId);
    }

    /** Record what every editor of a document shows (see {@link setRefreshContextForClient} for one). */
    setRefreshContext(documentUri: vscode.Uri | string, context: DiagramViewRecord): void {
        for (const editor of this.editorsOfDocument(this.canonicalizeUriString(documentUri))) {
            this.mergeView(editor, context);
        }
    }

    /**
     * Record what one editor shows: the one whose diagram asked for a model.
     * A file's other editor can be on another view of it, and refreshes that.
     * False when the client is not an editor's.
     */
    setRefreshContextForClient(clientId: string, context: DiagramViewRecord): boolean {
        const editor = this.editors.get(clientId);
        if (!editor) {
            return false;
        }
        this.mergeView(editor, context);
        return true;
    }

    private mergeView(editor: DiagramEditor, context: DiagramViewRecord): void {
        const next = { ...editor.view, ...context };
        editor.view = !next.networkName && !next.navTrail && typeof next.queueTraceVisible !== 'boolean' && !next.runId && !next.shownSourceUri
            ? undefined
            : next;
    }

    /**
     * The editors a refresh named by a file is a refresh of: the one opened on
     * that file, and every one showing it in place. A view names itself by the
     * file it is of, which navigating in place is not always its editor's
     * document; looked up as a document only, a refresh of a nested view of
     * another file reached nobody, or the editor of that file and not the one
     * that asked.
     */
    editorsOf(uri: vscode.Uri | string): string[] {
        return [...new Set(this.editorsShowing(uri).map(editor => editor.documentKey))];
    }

    /**
     * The clients of the editors {@link editorsOf} names, each editor once: for
     * what each diagram of a file is told on its own (a view option another
     * editor turned, a row of its outline to show), which a file's second
     * editor must hear as well, and the one it came from need not.
     */
    clientIdsShowing(uri: vscode.Uri | string): string[] {
        return this.editorsShowing(uri).map(editor => editor.clientId);
    }

    /**
     * The clients of the editors {@link editorsOf} names, each with the
     * file's URI as that editor names it: its document's, or that of the view
     * it shows in place. A diagram knows its file by its own spelling.
     */
    clientsShowing(uri: vscode.Uri | string): Array<{ clientId: string; sourceUri: string }> {
        const wanted = this.canonicalizeUriString(uri);
        return this.editorsShowing(uri).map(editor => ({
            clientId: editor.clientId,
            sourceUri: editor.documentKey === wanted ? editor.documentUri : (editor.view?.shownSourceUri ?? editor.documentUri)
        }));
    }

    /**
     * Whether a webview's message names a file its editor shows (its
     * `sourceUri`): what the host writes beside, and hands the product, is
     * that editor's file and no other.
     */
    private shows(clientId: string, payload: unknown): boolean {
        const sourceUri = (payload as { sourceUri?: unknown } | undefined)?.sourceUri;
        return typeof sourceUri === 'string' && sourceUri !== '' && this.clientIdsShowing(sourceUri).includes(clientId);
    }

    /** The editors {@link editorsOf} names, each one: a file can have two. */
    private editorsShowing(uri: vscode.Uri | string): DiagramEditor[] {
        const wanted = this.canonicalizeUriString(uri);
        return [...this.editors.values()].filter(editor => {
            const shown = editor.view?.shownSourceUri;
            return editor.documentKey === wanted || (typeof shown === 'string' && this.canonicalizeUriString(shown) === wanted);
        });
    }

    /**
     * The view the HOST put in an editor, recorded as what that editor shows.
     *
     * The record is otherwise written when the diagram asks for a model. A
     * view the host sends an editor that already exists (the definition of a
     * workflow opened from another editor, with the crumbs of the way there)
     * is asked for by the host, and was not on record: the next save
     * refreshed the view before it. What is absent here is absent from the
     * view: a view asked for by no name has none.
     */
    recordHostView(
        documentUri: vscode.Uri | string,
        view: { sourceUri: string; networkName?: string; navTrail?: string; runId?: string },
        /** The editor the host sent it to; absent, every editor of the document. */
        clientId?: string
    ): void {
        const record: DiagramViewRecord = {
            shownSourceUri: view.sourceUri,
            networkName: view.networkName?.trim() || undefined,
            navTrail: view.navTrail?.trim() || undefined,
            runId: view.runId?.trim() || undefined
        };
        if (clientId === undefined || !this.setRefreshContextForClient(clientId, record)) {
            this.setRefreshContext(documentUri, record);
        }
    }

    /**
     * What a refresh the HOST asks for is a refresh of: which file, under
     * which name, by which trail. The refresh command's half of what
     * {@link dispatchModelRefresh} does for a save.
     *
     * Not of which run: a host refresh names none, as it never did, and the
     * server shows the latest. The run on record is the one the DIAGRAM last
     * asked for, and a run started since is shown without the record
     * hearing of it: sent along, the record would take the overlay back to
     * the run before.
     *
     * A REFRESH never changes which view an editor shows: it is of the view
     * on record, in the file that view is of. Navigating in place that can be
     * a workflow in another file than the editor's own document, and asked of
     * the document under that view's name and trail it is a view the document
     * does not have: the producer refuses it, or draws it as a different
     * view, kept under a different layout.
     *
     * A caller may say which view it means (`fallbackName`; the diagram's own
     * controls name the view they are on). That is taken only where there is
     * no name on record: an editor that has shown nothing but its default, or
     * a view put there in a way that left no record. Where there is a name on
     * record, the record is what the editor shows, and a name that differs is
     * about another editor, or about a view the reader has already left.
     *
     * An OPEN (`open`, the open commands on an editor that exists already) is
     * of a graph of the editor's document, as its root, whatever is on
     * screen: the trail that came before led to the view that was there, and
     * sent along it would file the new view under crumbs it was not reached
     * by. The trail is the view itself, which is also what tells the diagram
     * to start its crumbs over. It is remembered as what the editor shows, so
     * that the next save refreshes it and not the view before; the run on
     * record stays there only when the graph opened is the root that was
     * already shown, since a run is a run of a graph.
     */
    hostRefreshTarget(
        documentUri: vscode.Uri | string,
        request: { open?: string; fallbackName?: string } = {},
        /** The editor asked; absent, the document's current one. */
        clientId?: string
    ): { sourceUri: string; networkName?: string; navTrail?: string } {
        const own = typeof documentUri === 'string' ? documentUri : documentUri.toString();
        const editor = clientId !== undefined ? this.editors.get(clientId) : undefined;
        const context = editor ? editor.view : this.getRefreshContext(documentUri);
        const shown = typeof context?.shownSourceUri === 'string' && context.shownSourceUri.trim() !== ''
            ? context.shownSourceUri
            : undefined;
        const opened = typeof request.open === 'string' ? request.open.trim() : '';
        if (opened !== '') {
            const navTrail = JSON.stringify([{ sourceUri: own, workflowName: opened }]);
            // The root that is on record already: the name, in the editor's own
            // file, and not as an instance further down (a view of that name
            // three crumbs deep is another graph's part, with that graph's run).
            const sameRoot = context?.networkName === opened
                && this.canonicalizeUriString(shown ?? own) === this.canonicalizeUriString(own)
                && crumbCount(context?.navTrail) <= 1;
            const record: DiagramViewRecord = {
                shownSourceUri: own,
                networkName: opened,
                navTrail,
                ...(sameRoot ? {} : { runId: undefined })
            };
            if (editor) {
                this.mergeView(editor, record);
            } else {
                this.setRefreshContext(documentUri, record);
            }
            return { sourceUri: own, networkName: opened, navTrail };
        }
        const networkName = context?.networkName ?? (request.fallbackName?.trim() || undefined);
        return {
            sourceUri: shown ?? own,
            ...(networkName ? { networkName } : {}),
            ...(context?.navTrail ? { navTrail: context.navTrail } : {})
        };
    }

    /**
     * Ask again for the model of every editor a refresh of `uri` is a refresh
     * of, or open a graph by name in the editor opened on it. Returns how
     * many editors were asked.
     */
    refreshFromHost(
        uri: vscode.Uri | string,
        options: {
            /**
             * For a refresh, the view the caller means: taken where the one
             * editor asked has no name on record, and not at all when several
             * are asked, since it is the view of one of them at most. For an
             * open, the graph to open.
             */
            workflowName?: string;
            /** The graph named is to be opened, as the root of the editor opened on `uri`. */
            open?: boolean;
            /** Only what lies over the graph changed: see the fast path in the model handler. */
            agentContextOnly?: boolean;
            /** The label of a node to select and centre when the model that has it arrives. */
            reveal?: string;
            queueTraceVisible?: boolean;
        } = {}
    ): number {
        const named = typeof options.workflowName === 'string' ? options.workflowName.trim() : '';
        const opening = options.open === true && named !== '';
        // An open is of the editor opened on the file (the one used last, of
        // two). A refresh is of every view of it, in every editor.
        const own = this.canonicalizeUriString(uri);
        const current = opening ? this.currentEditorOf(own) : undefined;
        const editors = opening ? (current ? [current] : []) : this.editorsShowing(uri);
        let asked = 0;
        for (const { documentKey: editorUri, clientId } of editors) {
            const target = this.hostRefreshTarget(
                editorUri,
                opening ? { open: named } : { fallbackName: editors.length === 1 ? named : undefined },
                clientId
            );
            const action = RequestModelAction.create({
                requestId: 'refresh-queue-visibility-' + Date.now(),
                options: {
                    sourceUri: target.sourceUri,
                    diagramType: this.diagramType,
                    ...(typeof options.queueTraceVisible === 'boolean' ? { queueTraceVisible: options.queueTraceVisible } : {}),
                    // Queue-trace visibility toggles only re-apply the queue-trace overlay (edge glow /
                    // queue-depth args) onto the unchanged graph — no node/edge/position change — so this
                    // redelivery can rebuild off the warm plan cache and skip the RequestBounds round-trip
                    // via the agent-context-only fast path. Callers that may change the source (rename) or
                    // want a fresh re-plan (the generic refresh command) leave this unset and pay the full
                    // reload, which re-acquires and re-runs bounds as required for correctness.
                    ...(options.agentContextOnly ? { agentContextOnly: true } : {}),
                    ...(target.networkName ? { networkName: target.networkName } : {}),
                    ...(target.navTrail ? { 'wf:navTrail': target.navTrail } : {})
                }
            });
            if (options.reveal) {
                // Named before the model is asked for: the diagram selects and
                // centres the node when the model that has it comes in. What a
                // product's command added is not always where the view is.
                this.glspVscodeConnector.dispatchAction(RevealNodeAction.create(options.reveal), clientId);
            }
            this.glspVscodeConnector.dispatchAction(action, clientId);
            asked += 1;
        }
        return asked;
    }

    /** What the document's current editor shows (see {@link getClientIdForDocumentUri}). */
    getRefreshContext(documentUri: vscode.Uri | string): DiagramViewRecord | undefined {
        return this.currentEditorOf(this.canonicalizeUriString(documentUri))?.view;
    }

    /** What one editor shows. */
    getRefreshContextForClient(clientId: string): DiagramViewRecord | undefined {
        return this.editors.get(clientId)?.view;
    }

    /**
     * Attach (or detach, with `undefined`) the live-overlay signature source. The
     * host wires this from the run driver after both are constructed. Attaching
     * subscribes to signature updates and begins watching any already-open
     * diagrams; detaching disposes the subscription and all per-diagram watches.
     */
    setLiveOverlaySignatureSource(source: LiveOverlaySignatureSource | undefined): void {
        this.liveOverlaySignatureSubscription?.dispose();
        this.liveOverlaySignatureSubscription = undefined;
        for (const watch of this.uriToLiveOverlayWatch.values()) {
            watch.dispose();
        }
        this.uriToLiveOverlayWatch.clear();

        this.liveOverlayWatch = source ? (uri: vscode.Uri) => source.watch(uri) : undefined;

        if (source) {
            this.liveOverlaySignatureSubscription = source.onSignature(
                (sourceUri, signature) => this.onLiveOverlaySignatureUpdate(sourceUri, signature)
            );
            // Begin watching any diagrams already open when the source is attached.
            for (const key of this.openDocumentKeys()) {
                this.startLiveOverlayWatch(key, vscode.Uri.parse(key));
            }
        }
    }

    private startLiveOverlayWatch(key: string, sourceUri: vscode.Uri): void {
        if (!this.liveOverlayWatch || this.uriToLiveOverlayWatch.has(key)) {
            return;
        }
        this.uriToLiveOverlayWatch.set(key, this.liveOverlayWatch(sourceUri));
    }

    private stopLiveOverlayWatch(key: string): void {
        const watch = this.uriToLiveOverlayWatch.get(key);
        if (watch) {
            watch.dispose();
            this.uriToLiveOverlayWatch.delete(key);
        }
    }

    /**
     * Handle a live-overlay signature update from the injected source. Refreshes
     * the diagram on a signature CHANGE, preserving the old passive poll's exact
     * semantics: an absent overlay maps to `undefined`, so a first observation of
     * an absent file (`previous === undefined`, `next === undefined`) is a no-op,
     * and any undefined↔defined transition triggers a refresh.
     */
    onLiveOverlaySignatureUpdate(sourceUri: string, signature: string | undefined): void {
        const key = this.canonicalizeUriString(sourceUri);
        const editors = this.editorsOfDocument(key);
        if (editors.length === 0) {
            return;
        }

        const previousSignature = this.uriToLiveOverlaySignature.get(key);
        this.uriToLiveOverlaySignature.set(key, signature);

        if (previousSignature === signature) {
            return;
        }

        // Silent: the overlay changes on every firing of a run, and each change
        // reloads the model to redraw the glow; a "Model loading in progress"
        // notification per firing was the complaint.
        for (const editor of editors) {
            this.dispatchModelRefresh(editor.clientId, vscode.Uri.parse(key).toString(), { silent: true });
        }
    }

    /**
     * Get a webview resource URI for a file in the extension.
     */
    protected getWebviewResourceUri(
        webview: vscode.Webview,
        ...pathSegments: string[]
    ): vscode.Uri {
        const fileUri = vscode.Uri.joinPath(this.assetsBaseUri, ...pathSegments);
        const webviewUri = webview.asWebviewUri(fileUri);
        // Cache-bust with the asset's mtime: VS Code's webview service worker
        // caches resources by URI and that cache survives Extension
        // Development Host restarts — without this, rebuilt client bundles
        // are silently ignored and the webview keeps running stale code.
        // (Same pattern mlir-viewer uses for its webview assets.)
        try {
            const mtime = statSync(fileUri.fsPath).mtimeMs;
            return webviewUri.with({ query: `v=${Math.trunc(mtime)}` });
        } catch {
            return webviewUri;
        }
    }

    /**
     * Resolve the script/style URIs and localResourceRoots the webview serves.
     *
     * With no `profile.clientAssets`, this returns the stock `dist/webview/*`
     * bundle under `assetsBaseUri` — byte-identical to the historical default.
     * With `clientAssets`, it serves the consumer's configured script (and
     * optional style) via `asWebviewUri` with a per-file `?v=<mtime>` cache-bust
     * and EXTENDS the stock resource roots with the configured ones (never
     * replacing them). A configured-but-unreadable path is a consumer error: it
     * is still served (with a `v=0` cache-bust) and a warning naming the path is
     * logged — the provider never silently falls back to the stock bundle, which
     * would mask the misconfiguration.
     */
    protected resolveClientAssets(webview: vscode.Webview): {
        scriptUri: vscode.Uri;
        styleUri?: vscode.Uri;
        extraStyleUris: vscode.Uri[];
        localResourceRoots: vscode.Uri[];
    } {
        const stockRoots = [
            vscode.Uri.joinPath(this.assetsBaseUri, 'out'),
            vscode.Uri.joinPath(this.assetsBaseUri, 'dist')
        ];
        // The product's own stylesheets come after the bundle's, stock or
        // configured, so the product's rules load last and win the cascade:
        // that is what a product-specific stylesheet is for. Each file's
        // directory joins the roots, or the webview refuses to load it.
        const stylesheets = this.profile.clientStylesheets ?? [];
        const extraStyleUris = stylesheets.map(sheet => this.getConfiguredAssetUri(webview, sheet));
        const stylesheetRoots = stylesheets.map(sheet => {
            const fileUri = this.toResourceUri(sheet);
            return fileUri.scheme === 'file'
                ? vscode.Uri.file(path.dirname(fileUri.fsPath))
                : vscode.Uri.joinPath(fileUri, '..');
        });

        const clientAssets = this.profile.clientAssets;
        if (!clientAssets) {
            return {
                scriptUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'diagram-client.js'),
                styleUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'diagram-client.css'),
                extraStyleUris,
                localResourceRoots: [...stockRoots, ...stylesheetRoots]
            };
        }

        const configuredRoots = (clientAssets.localResourceRoots ?? []).map(root => this.toResourceUri(root));
        return {
            scriptUri: this.getConfiguredAssetUri(webview, clientAssets.scriptPath),
            styleUri: clientAssets.stylePath
                ? this.getConfiguredAssetUri(webview, clientAssets.stylePath)
                : undefined,
            extraStyleUris,
            localResourceRoots: [...stockRoots, ...configuredRoots, ...stylesheetRoots]
        };
    }

    /**
     * Convert a data-only asset string (absolute fs path or file-URI string) to
     * a `vscode.Uri`. A value carrying a multi-character scheme (e.g. `file:`) is
     * parsed as a URI; anything else — including a Windows drive path such as
     * `C:\\...` — is treated as a filesystem path.
     */
    private toResourceUri(pathOrUri: string): vscode.Uri {
        return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(pathOrUri)
            ? vscode.Uri.parse(pathOrUri)
            : vscode.Uri.file(pathOrUri);
    }

    /**
     * Build the webview URI for a consumer-configured asset: convert the
     * data-only path/URI, map it through `asWebviewUri`, and cache-bust with the
     * file's mtime. Unlike the stock path, an unreadable file is NOT served bare
     * — it gets a `v=0` cache-bust plus a warning naming the path, so a
     * misconfigured consumer bundle surfaces instead of silently falling back.
     */
    private getConfiguredAssetUri(webview: vscode.Webview, pathOrUri: string): vscode.Uri {
        const fileUri = this.toResourceUri(pathOrUri);
        const webviewUri = webview.asWebviewUri(fileUri);
        try {
            const mtime = statSync(fileUri.fsPath).mtimeMs;
            return webviewUri.with({ query: `v=${Math.trunc(mtime)}` });
        } catch {
            console.warn(
                `[WorkflowEditorProvider] A configured client asset (clientAssets or clientStylesheets) is not readable; serving with v=0: ${fileUri.fsPath}`
            );
            return webviewUri.with({ query: 'v=0' });
        }
    }

    /**
     * Generate the HTML content for the diagram webview.
     *
     * This creates a minimal HTML page that loads the GLSP diagram client
     * and initializes it with the diagram identifier.
     */
    /**
     * The behavior that depends on the machine or the workspace rather than on
     * the product: the ACP connectors the document's workspace sees, for a
     * profile that declares the connector setting. Resolved after the webview
     * is up (this setup is synchronous) and posted to it as
     * `dialogram.clientBehavior.merge`, which the client folds into its
     * `clientBehavior()`. Bounded and never failing: without an answer the
     * static behavior stands.
     */
    private postClientBehaviorExtras(documentUri: string, webview: vscode.Webview): void {
        const acpConnector = this.profile.chat?.acpConnector;
        if (!acpConnector) {
            return;
        }
        const dir = workspaceDirFor(vscode.Uri.parse(documentUri).fsPath);
        const deadline = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000));
        void Promise.race([listAcpConnectors(acpConnector, dir), deadline])
            .then((acpConnectors) => {
                if (acpConnectors) {
                    const extras: Partial<DiagramClientBehavior> = { acpConnectors };
                    void webview.postMessage({ type: 'dialogram.clientBehavior.merge', payload: extras });
                }
            })
            .catch((err) => console.warn('[dialogram provider] listing the ACP connectors failed:', err));
    }

    protected getWebviewContent(
        webview: vscode.Webview,
        options: {
            scriptUri: vscode.Uri;
            libavoidWasmUri?: vscode.Uri;
            libavoidModuleUri?: vscode.Uri;
            styleUri?: vscode.Uri;
            /** The product's own stylesheets, linked after `styleUri`. */
            extraStyleUris?: vscode.Uri[];
            clientId: string;
            documentUri: string;
        }
    ): string {
        // Use a content security policy to only allow loading specific resources
        const nonce = this.getNonce();

        // Debug toggle (set via launch.json env), applied inside the webview.
        const debugEdgePoints = process.env.WORKFLOW_DEBUG_EDGE_POINTS === '1';

        // The stylesheet link is emitted only when a style URI is present; a
        // consumer bundle may inline its CSS and supply no `stylePath`.
        const styleLink = [
            ...(options.styleUri ? [options.styleUri] : []),
            ...(options.extraStyleUris ?? [])
        ].map(uri => `<link href="${uri}" rel="stylesheet" />\n    `).join('');

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource};
        connect-src ${webview.cspSource} blob:;
        font-src ${webview.cspSource} data:;
        img-src ${webview.cspSource} data:;
    ">
    ${styleLink}<title>Workflow Network Diagram</title>
    <style>
        html, body {
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
        }
        .sprotty-container {
            height: 100%;
            width: 100%;
        }
    </style>
</head>
<body>
    <div id="${options.clientId}" class="sprotty-container">
        <!-- Sprotty diagram will be rendered here -->
    </div>
    
    <!-- Properties Toggle Button (floating, top-left) -->
    <button id="btn-toggle-properties" class="floating-tool-btn" title="Show Properties (P)">
        <span class="codicon codicon-list-selection"></span>
    </button>
    
    <!-- Property Panel (positioned absolute, left side) -->
    <div id="property-panel" class="property-panel collapsed">
        <div class="property-panel-header">
            <span class="panel-title">Properties</span>
            <div class="panel-header-actions">
                <button id="btn-float-properties" class="panel-btn" title="Float panel near node">
                    <span class="codicon codicon-move"></span>
                </button>
                <button id="btn-pin-properties" class="panel-btn" title="Pin panel (keeps visible)">
                    <span class="codicon codicon-pin"></span>
                </button>
                <button id="btn-close-properties" class="panel-btn" title="Close">
                    <span class="codicon codicon-close"></span>
                </button>
            </div>
        </div>
        <div class="property-panel-body">
            <div id="property-content">
                <div class="no-selection">Select an element to view properties</div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        // Pass diagram identifier to the client. Serialized as one JSON literal
        // with '<' escaped so no value (e.g. a URI) can break out of the script.
        window.diagramIdentifier = ${this.toScriptJson({
            clientId: options.clientId,
            diagramType: this.diagramType,
            uri: options.documentUri,
            commandIds: this.profile.commands,
            operationKinds: this.profile.operationKinds,
            settingsNamespace: this.profile.settingsNamespace,
            clientBehavior: {
                ...this.profile.clientBehavior,
                // Derived here rather than taken from the product, because the
                // client and the host have to agree about this and a field a
                // product sets by hand is one it can set wrongly. `chat` being
                // absent is exactly what "the chat backend is not activated"
                // means, so it is the honest source.
                chatBackend: this.profile.chat !== undefined,
                // The same for the run driver: Run and Stop are offered exactly
                // when something is registered to run the diagram, and a run is
                // resumable only where something can run it again.
                runDriver: this.profile.runDriver !== undefined,
                resumeAtStep: this.profile.clientBehavior?.resumeAtStep === true && this.profile.runDriver !== undefined,
                // The node families the server classes nodes with are the ones
                // the client draws marks and colours for, unless the product
                // names others for the client: a profile that gives them to
                // the server only would class nodes the editor draws plain.
                nodeFamilies: this.profile.clientBehavior?.nodeFamilies ?? this.profile.storageOptions?.nodeFamilies,
                // The same for the status source: the menu offers exactly the
                // commands the host registered, or none. Data only; `collect`
                // stays on the host.
                statusSource: this.profile.statusSource
                    ? {
                        label: this.profile.statusSource.label,
                        showCommand: this.profile.statusSource.showCommand,
                        clearCommand: this.profile.statusSource.clearCommand
                    }
                    : undefined
            },
            // Where the live edge router fetches its WASM binary. The webview
            // cannot read the filesystem, so the URI is resolved host-side.
            libavoidWasmUri: options.libavoidWasmUri?.toString(),
            libavoidModuleUri: options.libavoidModuleUri?.toString()
        })};

        // Edge route/bendpoint overlay (WorkflowEdgeView), a purely visual
        // client-side debug aid injected from the extension host (launch.json env).
        if (${debugEdgePoints ? 'true' : 'false'}) {
            (window).WORKFLOW_DEBUG_EDGE_POINTS = true;
        }

        // Surface any runtime errors from the webview/client bundle in the
        // Extension Host console.
        try {
            // NOTE: VS Code only allows acquiring the API once per webview.
            // Cache and reuse it; also override acquireVsCodeApi so libraries that
            // call it internally won't crash the webview.
            const originalAcquire = acquireVsCodeApi;
            const vscode = originalAcquire();
            window.__calVscodeApi = vscode;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window).acquireVsCodeApi = () => vscode;
            window.addEventListener('error', (e) => {
                vscode.postMessage({
                    type: 'dialogram.diagram.clientDebug.webviewError',
                    payload: {
                        message: e?.message,
                        filename: e?.filename,
                        lineno: e?.lineno,
                        colno: e?.colno
                    }
                });
            });
            window.addEventListener('unhandledrejection', (e) => {
                const anyEvent = e;
                const reason = anyEvent && anyEvent.reason;
                vscode.postMessage({
                    type: 'dialogram.diagram.clientDebug.webviewUnhandledRejection',
                    payload: {
                        message: reason?.message ?? String(reason)
                    }
                });
            });
        } catch {
            // ignore
        }
    </script>
    <!-- Parser-blocking by design: this classic <script> runs synchronously in
         document order, so the client bundle installs the webview messenger
         BEFORE VS Code flushes any queued postMessage to the webview (the diagram
         identifier, an in-progress run's overlay batch). Do NOT add defer/async/
         type="module" — any of them defers execution past the flush and early
         host notifications are dropped before a handler exists. See task-4 review. -->
    <script nonce="${nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
    }

    /**
     * Generate a random nonce for content security policy.
     */
    protected getNonce(): string {
        // Cryptographically-strong nonce (CSP nonces must be unpredictable).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('node:crypto').randomBytes(16).toString('base64');
    }

    /**
     * Serialize a value to a JSON literal safe to embed inside an inline
     * <script> — escapes '<' (and line separators) so a value containing
     * "</script>" or U+2028/U+2029 cannot terminate or corrupt the script.
     */
    protected toScriptJson(value: unknown): string {
        return JSON.stringify(value)
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    /**
     * Resolve the GLSP client/session id for a given CAL document URI.
     * Useful for dispatching actions when the diagram tab is not the active webview.
     */
    /** The document an editor's client was opened on: its root. */
    getDocumentUriForClientId(clientId: string): string | undefined {
        return this.editors.get(clientId)?.documentKey;
    }

    /**
     * The file a client's chat panel speaks for: its editor's document as VS
     * Code spells it, which the webview is handed (`diagramIdentifier.uri`).
     * A view navigated into another file's workflow keeps it.
     */
    getChatUriForClientId(clientId: string): string | undefined {
        return this.editors.get(clientId)?.documentUri;
    }

    /**
     * "The" diagram of a file, for what goes to one editor (a command on the
     * active diagram, an open, an export): of two editors on the file, the
     * active one, or else the one used last.
     */
    getClientIdForDocumentUri(uri: vscode.Uri | string): string | undefined {
        return this.currentEditorOf(this.canonicalizeUriString(uri))?.clientId;
    }

    /** Every diagram of a file, for what each of them must hear (a reload, a run's overlay). */
    getClientIdsForDocumentUri(uri: vscode.Uri | string): string[] {
        return this.editorsOfDocument(this.canonicalizeUriString(uri)).map(editor => editor.clientId);
    }

    /** Begin tracking an editor; `first` when its document had no other. */
    private trackEditor(
        documentUri: vscode.Uri | string,
        clientId: string,
        webview?: vscode.Webview,
        panel?: vscode.WebviewPanel
    ): { key: string; first: boolean } {
        const key = this.canonicalizeUriString(documentUri);
        const first = this.editorsOfDocument(key).length === 0;
        this.editors.set(clientId, {
            clientId,
            documentKey: key,
            documentUri: typeof documentUri === 'string' ? documentUri : documentUri.toString(),
            webview,
            panel,
            lastActive: ++this.activity
        });
        return { key, first };
    }

    /** Stop tracking an editor; `last` when its document has no other left. */
    private untrackEditor(clientId: string): { key: string; last: boolean } | undefined {
        const editor = this.editors.get(clientId);
        if (!editor) {
            return undefined;
        }
        this.editors.delete(clientId);
        return { key: editor.documentKey, last: this.editorsOfDocument(editor.documentKey).length === 0 };
    }

    /** A document's editors, in the order they were opened. */
    private editorsOfDocument(key: string): DiagramEditor[] {
        return [...this.editors.values()].filter(editor => editor.documentKey === key);
    }

    /** A document's current editor: the active one, or else the one used last. */
    private currentEditorOf(key: string): DiagramEditor | undefined {
        let latest: DiagramEditor | undefined;
        for (const editor of this.editorsOfDocument(key)) {
            if (editor.panel?.active === true) {
                return editor;
            }
            if (!latest || editor.lastActive > latest.lastActive) {
                latest = editor;
            }
        }
        return latest;
    }

    /** The documents with an editor open, each once. */
    private openDocumentKeys(): string[] {
        return [...new Set([...this.editors.values()].map(editor => editor.documentKey))];
    }

    /**
     * Tell the profile a file's first editor opened, or its last closed.
     * Never a reason for the editor not to open or close: what the hook
     * throws or rejects with is logged.
     */
    private tellProfile(hook: 'onEditorOpened' | 'onEditorClosed', uri: string): void {
        const listener = this.profile[hook];
        if (!listener) {
            return;
        }
        const failed = (error: unknown): void => console.warn(`[WorkflowEditorProvider] the profile's ${hook} failed for ${uri}:`, error);
        try {
            const result = listener.call(this.profile, uri) as unknown;
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch(failed);
            }
        } catch (error) {
            failed(error);
        }
    }

    /**
     * Open a source URI and select the given range — the `revealRange` capability
     * handed to a profile's {@link DiagramProfile.onWebviewMessage} hook. An
     * absent range opens the document without a selection.
     *
     * By default the file is shown where it is already open, or else in the
     * active group, which is the diagram's: over the diagram. `beside` keeps the
     * diagram in sight. The file is shown in a group other than the active one
     * where it is open there, and otherwise in the group beside, even where the
     * diagram's own group holds it in a tab behind: shown there, it would cover
     * the diagram again.
     */
    private async revealRange(
        uriStr: string,
        range?: { startLine: number; startColumn?: number },
        options?: RevealRangeOptions
    ): Promise<void> {
        const uri = vscode.Uri.parse(uriStr);
        const selection = range
            ? new vscode.Range(range.startLine, range.startColumn ?? 0, range.startLine, range.startColumn ?? 0)
            : undefined;
        const show: vscode.TextDocumentShowOptions = { selection, preserveFocus: options?.preserveFocus === true };
        if (options?.beside === true) {
            await vscode.window.showTextDocument(uri, { ...show, viewColumn: openColumnFor(uri, 'text') ?? vscode.ViewColumn.Beside });
            return;
        }
        await vscode.window.showTextDocument(uri, inPlace(uri, 'text', show));
    }

    /**
     * Dispatch a host→client action to the webview owning `uri` over the ungated
     * `sendMessageToClient` overlay-bridge path (reaches the client even for kinds
     * it did not advertise in `clientActions`). Backs the profile handle's
     * `dispatchToWebview`. No-op when no client is registered for the URI.
     */
    dispatchToWebview(uri: string, action: { kind: string } & Record<string, unknown>): void {
        // Every editor of the file: each shows it.
        for (const clientId of this.getClientIdsForDocumentUri(uri)) {
            (this.glspVscodeConnector as unknown as {
                sendMessageToClient(clientId: string, message: unknown): void;
            }).sendMessageToClient(clientId, { clientId, action });
        }
    }

    /**
     * Post a raw message straight to the webview panel owning `uri`. Backs the
     * profile handle's `postToWebview` (cursor-sync / graph-era channel). No-op
     * when no panel is registered for the URI.
     */
    /**
     * Save the SVG the webview extracted (diagram-client/src/svg-export.ts), as
     * the mlir-viewer does: VS Code's own dialog, so it lands where the user's
     * files land and on whatever filesystem the workspace is on, defaulting
     * beside the file the diagram came from and named after the workflow.
     */
    private async saveExtractedSvg(
        documentUri: string,
        payload: { svg?: unknown; name?: unknown; elementCount?: unknown }
    ): Promise<void> {
        if (typeof payload.svg !== 'string' || payload.svg.length === 0) {
            return;
        }
        const count = typeof payload.elementCount === 'number' ? ` (${payload.elementCount} elements)` : '';
        await this.saveExport(documentUri, {
            bytes: Buffer.from(payload.svg, 'utf8'),
            name: payload.name,
            format: 'SVG',
            extension: 'svg',
            detail: count
        });
    }

    /**
     * Save a diagram surface's image (diagram-client svg-export-command.ts):
     * base64 PNG bytes, checked to be a PNG, through the same dialog as the
     * SVG.
     */
    private async saveExtractedPng(
        documentUri: string,
        payload: { data?: unknown; name?: unknown }
    ): Promise<void> {
        if (typeof payload.data !== 'string' || payload.data.length === 0) {
            return;
        }
        const bytes = Buffer.from(payload.data, 'base64');
        if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
            void vscode.window.showWarningMessage('Could not export the diagram as PNG: the image is not a PNG.');
            return;
        }
        await this.saveExport(documentUri, { bytes, name: payload.name, format: 'PNG', extension: 'png', detail: '' });
    }

    /** Ask where, write, and offer to open or reveal what was written. */
    private async saveExport(
        documentUri: string,
        file: { bytes: Uint8Array; name: unknown; format: 'SVG' | 'PNG'; extension: string; detail: string }
    ): Promise<void> {
        const base = typeof file.name === 'string' && file.name ? file.name : 'diagram';
        const source = vscode.Uri.parse(documentUri);
        const folder = source.scheme === 'file' ? path.dirname(source.fsPath) : undefined;
        const fileName = `${base}.${file.extension}`;

        const target = await vscode.window.showSaveDialog({
            title: `Export diagram as ${file.format}`,
            defaultUri: folder ? vscode.Uri.file(path.join(folder, fileName)) : vscode.Uri.file(fileName),
            filters: { [`${file.format} image`]: [file.extension] },
            saveLabel: 'Export'
        });
        if (!target) {
            return;
        }
        try {
            await vscode.workspace.fs.writeFile(target, file.bytes);
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Could not write ${target.fsPath}: ${error instanceof Error ? error.message : String(error)}`
            );
            return;
        }
        const count = file.detail;
        const open = 'Open';
        const reveal = 'Reveal in Explorer';
        const choice = await vscode.window.showInformationMessage(
            `Exported ${path.basename(target.fsPath)}${count}.`,
            open,
            reveal
        );
        if (choice === open) {
            const column = openColumnFor(target, { default: true });
            await vscode.commands.executeCommand('vscode.open', ...(column === undefined ? [target] : [target, { viewColumn: column }]));
        } else if (choice === reveal) {
            await vscode.commands.executeCommand('revealInExplorer', target);
        }
    }

    /**
     * What a client's load is doing, to the diagram that is waiting for it
     * (diagram-client `loading-indicator.ts`). By client and not by source:
     * a view opened in place is of another file than its editor's, and the
     * webview is the editor's. A client that has gone is told nothing.
     */
    postLoading(clientId: string, update: LoadingUpdate): void {
        const message: LoadingMessage = { type: LOADING_MESSAGE_TYPE, payload: update };
        this.postToClient(clientId, message);
    }

    /**
     * What a PRODUCT says a file's diagram is doing (`DiagramProfileHandle.loading`),
     * to every editor of the file: work the product does for the file after
     * the platform has drawn it, which its reader is waiting on all the same.
     * Words that would show nothing (no message) are not posted.
     */
    postLoadingToDocument(uri: string, update: LoadingUpdate): void {
        const payload = update.state === 'progress' ? normalizeLoadProgress(update) : update;
        if (!payload) {
            return;
        }
        const message: LoadingMessage = {
            type: LOADING_MESSAGE_TYPE,
            payload: update.state === 'progress' ? { state: 'progress', ...(payload as LoadProgress) } : update
        };
        this.postToWebview(uri, message);
    }

    /** Post to every editor of a file. */
    postToWebview(uri: string, message: unknown): void {
        for (const editor of this.editorsOfDocument(this.canonicalizeUriString(uri))) {
            void editor.webview?.postMessage(message);
        }
    }

    /** Post to one editor; false when it has gone. */
    postToClient(clientId: string, message: unknown): boolean {
        const webview = this.editors.get(clientId)?.webview;
        if (!webview) {
            return false;
        }
        void webview.postMessage(message);
        return true;
    }

    /**
     * Reload the diagram for a document from disk. Used after an external
     * mutation (e.g. a chat-issued edit-backend operation) so the graph reflects the
     * new source. Returns true if a diagram client was found and refreshed.
     */
    refreshModelFromDisk(uri: vscode.Uri): boolean {
        const clientIds = this.getClientIdsForDocumentUri(uri);
        for (const clientId of clientIds) {
            this.dispatchModelRefresh(clientId, uri.toString(), { forceReloadFromDisk: true });
        }
        return clientIds.length > 0;
    }
}

/**
 * Register the Workflow Editor Provider with VS Code.
 *
 * This sets up the custom editor for .cal files with diagram visualization.
 *
 * @param context - Extension context
 * @param glspVscodeConnector - The GLSP VS Code connector
 * @returns The registration disposable and the created provider
 */
export function registerWorkflowEditorProvider(
    context: vscode.ExtensionContext,
    glspVscodeConnector: GlspVscodeConnector,
    profile: DiagramProfile,
    assetsUri?: vscode.Uri
): { disposable: vscode.Disposable; provider: WorkflowEditorProvider } {
    const provider = new WorkflowEditorProvider(context, glspVscodeConnector, profile, assetsUri);

    const registration = vscode.window.registerCustomEditorProvider(
        profile.customEditorViewType,
        provider,
        {
            webviewOptions: {
                retainContextWhenHidden: true
            },
            supportsMultipleEditorsPerDocument: false
        }
    );

    return {
        disposable: vscode.Disposable.from(registration),
        provider
    };
}

/** A digest of `text`, to tell whether a file still holds it without keeping it. */
function digestOf(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

/** Whether the file `uri` names holds, on disk, the text `digest` is of; false for one that cannot be read. */
async function holdsText(uri: vscode.Uri, digest: string): Promise<boolean> {
    if (uri.scheme !== 'file') {
        return false;
    }
    try {
        return digestOf(await readFile(uri.fsPath, 'utf8')) === digest;
    } catch {
        return false;
    }
}
