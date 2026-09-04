/**
 * Workflow GLSP Editor Provider
 * 
 * Implements the VS Code CustomEditorProvider for Workflow network diagrams.
 * Extends GlspEditorProvider to handle diagram webview setup and lifecycle.
 */

import { GlspEditorProvider, GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { RequestModelAction } from '@eclipse-glsp/protocol';
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { WORKFLOW_DIAGRAM_TYPE } from '@dialogram/shared';
import { type DiagramProfile } from '../../api';
import { normalizeSourceUriKey } from './uri-keys';
import { matchesSourceExtension, sourceWatchGlobs } from './source-extensions';

const RUN_ID_ARG = 'wf:runId';

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

    private uriToClientId = new Map<string, string>();
    /** Per-URI webview handles, for the profile's raw `postToWebview` channel. */
    private uriToWebview = new Map<string, vscode.Webview>();
    private uriToRefreshContext = new Map<string, { networkName?: string; navTrail?: string; queueTraceVisible?: boolean; runId?: string }>();
    private uriToLiveOverlaySignature = new Map<string, string | undefined>();

    /**
     * Fires with a document's URI string each time a webview (re)registers for it
     * (initial open and every reopen). The host wires this to drain the
     * execution-overlay replay buffer through the bridge so a webview reopened
     * mid-run comes back with the live "Running agents" bar rather than empty.
     * The URI is emitted as `document.uri.toString()` — the same representation
     * run drivers emit with — so the replay lookup keys match.
     */
    private readonly registerClientEmitter = new vscode.EventEmitter<string>();
    readonly onDidRegisterClient: vscode.Event<string> = this.registerClientEmitter.event;

    /** Injected live-overlay signature source (the run driver). The provider drives
     *  live-execution glow purely off the signatures this source publishes; the
     *  file read + out-dir resolution now live in the driver. */
    private liveOverlayWatch?: (sourceUri: vscode.Uri) => { dispose(): void };
    private liveOverlaySignatureSubscription?: { dispose(): void };
    private readonly uriToLiveOverlayWatch = new Map<string, { dispose(): void }>();

    /**
     * Debounce timers for live document change updates.
     * Maps document URI to timeout handle.
     */
    private changeDebounceTimers = new Map<string, NodeJS.Timeout>();

    /** Debounce timer for external (on-disk) source changes picked up by the watcher. */
    private externalRefreshTimer?: NodeJS.Timeout;
    /** When each source file was last saved through the editor, to skip the watcher's
     *  duplicate refresh for an in-editor save (the save handler already refreshed). */
    private lastSavedAt = new Map<string, number>();

    /**
     * Debounce delay in milliseconds for live document changes.
     */
    private static readonly CHANGE_DEBOUNCE_MS = 500;
    private static readonly EXTERNAL_REFRESH_DEBOUNCE_MS = 250;

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

        extensionContext.subscriptions.push(this.registerClientEmitter);

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
        // Track the client ID for this document
        const canonicalDocumentUri = this.canonicalizeUriString(document.uri);
        this.uriToClientId.set(canonicalDocumentUri, clientId);
        this.uriToWebview.set(canonicalDocumentUri, webviewPanel.webview);

        // Ask the injected source (run driver) to poll this diagram's live overlay.
        this.startLiveOverlayWatch(canonicalDocumentUri, document.uri);

        // Announce the (re)registration so the host can replay any buffered
        // execution-overlay events for this source into the (re)opened webview.
        // Fired synchronously here: the drain runs before any later live batch on
        // the single-threaded host loop, preserving replay-before-live order.
        this.registerClientEmitter.fire(document.uri.toString());

        // Clean up when webview is disposed
        webviewPanel.onDidDispose(() => {
            this.uriToClientId.delete(canonicalDocumentUri);
            this.uriToWebview.delete(canonicalDocumentUri);
            this.uriToRefreshContext.delete(canonicalDocumentUri);
            this.uriToLiveOverlaySignature.delete(canonicalDocumentUri);
            this.stopLiveOverlayWatch(canonicalDocumentUri);
        });

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

                // Consumer-owned inbound messages: everything the built-in debug /
                // dialogram.ui.* handlers above did not already consume. Absent hook
                // → the message is ignored, byte-identical to prior behavior.
                if (this.profile.onWebviewMessage) {
                    await this.profile.onWebviewMessage(document.uri.toString(), message, {
                        postToWebview: (msg: unknown) => {
                            void webview.postMessage(msg);
                        },
                        revealRange: (uriStr, range) => this.revealRange(uriStr, range)
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
            clientId,
            documentUri: document.uri.toString()
        });
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

        // Cancel any pending debounced change update for the saved document
        // since we're doing a full refresh.
        const pendingTimer = this.changeDebounceTimers.get(savedUriString);
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.changeDebounceTimers.delete(savedUriString);
        }

        // Refresh all open diagrams on save so cross-file references (including sibling/deep imports)
        // pick up persisted changes immediately.
        for (const [sourceUri, clientId] of this.uriToClientId) {
            console.log(`[WorkflowEditorProvider] Document saved: ${document.uri}. Triggering diagram update for client: ${clientId} (source: ${sourceUri})`);
            this.dispatchModelRefresh(clientId, sourceUri, {
                forceReloadFromDisk: true
            });
        }
    }

    /**
     * React to a source file changing ON DISK from outside the editor — the chat agent
     * writing via the MCP edit backend, git, a formatter, etc. In-editor edits go
     * through handleDocumentChange/handleDocumentSave instead, so here we:
     *  - skip files open with unsaved edits (the editor owns those), and
     *  - skip a change we just produced via an in-editor save (deduped by time).
     * A changed module can be a cross-file import of an open workflow, so — like
     * save — refresh every open diagram. Debounced to coalesce edit bursts.
     */
    protected handleExternalFileChange(uri: vscode.Uri): void {
        if (!matchesSourceExtension(uri.path, this.profile.sourceExtensions) || this.uriToClientId.size === 0) {
            return;
        }
        const canonical = this.canonicalizeUriString(uri);

        // Always reload when the changed file IS an open diagram's own source. For
        // any OTHER watched file, keep the cross-file-import reload but skip build
        // artifacts / irrelevant trees (see isUnderArtifactDir) so generated files
        // under a build tree don't thrash open diagrams.
        const isOwnSource = this.uriToClientId.has(canonical);
        if (!isOwnSource && this.isUnderArtifactDir(uri)) {
            return;
        }

        // The editor's own save handler already refreshed for this write.
        const savedAt = this.lastSavedAt.get(canonical);
        if (savedAt !== undefined && Date.now() - savedAt < 1500) {
            return;
        }
        // Unsaved in-editor edits are handled by the live-preview change handler.
        const openDirty = vscode.workspace.textDocuments.some(
            d => this.canonicalizeUriString(d.uri) === canonical && d.isDirty
        );
        if (openDirty) {
            return;
        }

        if (this.externalRefreshTimer) {
            clearTimeout(this.externalRefreshTimer);
        }
        this.externalRefreshTimer = setTimeout(() => {
            this.externalRefreshTimer = undefined;
            for (const [sourceUri, clientId] of this.uriToClientId) {
                console.log(`[WorkflowEditorProvider] External change to ${uri.fsPath}; force-reloading diagram for client ${clientId} (source ${sourceUri}).`);
                this.dispatchModelRefresh(clientId, sourceUri, { forceReloadFromDisk: true });
            }
        }, WorkflowEditorProvider.EXTERNAL_REFRESH_DEBOUNCE_MS);
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

        const clientId = this.uriToClientId.get(uriString);
        
        // Only process if this document has an open diagram
        if (!clientId) {
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
            console.log(`[WorkflowEditorProvider] Document changed (debounced): ${uriString}. Triggering live diagram update for client: ${clientId}`);
            
            // Send the current document content for live preview
            const content = event.document.getText();
            this.dispatchModelRefresh(clientId, uriString, {
                content
            });
        }, WorkflowEditorProvider.CHANGE_DEBOUNCE_MS);
        
        this.changeDebounceTimers.set(uriString, timer);
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
        options: { content?: string; forceReloadFromDisk?: boolean } = {}
    ): void {
        const refreshContext = this.getRefreshContext(sourceUri);

        // Create a RequestModelAction to refresh the diagram
        const action = RequestModelAction.create({
            requestId: 'refresh-' + Date.now(),
            options: {
                sourceUri,
                diagramType: this.diagramType,
                ...(typeof refreshContext?.queueTraceVisible === 'boolean' ? { queueTraceVisible: refreshContext.queueTraceVisible } : {}),
                ...(refreshContext?.networkName ? { networkName: refreshContext.networkName } : {}),
                ...(refreshContext?.navTrail ? { 'wf:navTrail': refreshContext.navTrail } : {}),
                ...(refreshContext?.runId ? { [RUN_ID_ARG]: refreshContext.runId } : {}),
                ...options
            }
        });

        // Use the connector's dispatchAction method to properly route the action
        // through both client and server channels
        this.glspVscodeConnector.dispatchAction(action, clientId);
    }

    setRefreshContext(
        documentUri: vscode.Uri | string,
        context: { networkName?: string; navTrail?: string; queueTraceVisible?: boolean; runId?: string }
    ): void {
        const key = this.canonicalizeUriString(documentUri);
        const next = {
            ...this.uriToRefreshContext.get(key),
            ...context
        };

        if (!next.networkName && !next.navTrail && typeof next.queueTraceVisible !== 'boolean' && !next.runId) {
            this.uriToRefreshContext.delete(key);
            return;
        }

        this.uriToRefreshContext.set(key, next);
    }

    getRefreshContext(documentUri: vscode.Uri | string): { networkName?: string; navTrail?: string; queueTraceVisible?: boolean; runId?: string } | undefined {
        return this.uriToRefreshContext.get(this.canonicalizeUriString(documentUri));
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
            for (const key of this.uriToClientId.keys()) {
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
        const clientId = this.uriToClientId.get(key);
        if (!clientId) {
            return;
        }

        const previousSignature = this.uriToLiveOverlaySignature.get(key);
        this.uriToLiveOverlaySignature.set(key, signature);

        if (previousSignature === signature) {
            return;
        }

        this.dispatchModelRefresh(clientId, vscode.Uri.parse(key).toString());
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
        localResourceRoots: vscode.Uri[];
    } {
        const stockRoots = [
            vscode.Uri.joinPath(this.assetsBaseUri, 'out'),
            vscode.Uri.joinPath(this.assetsBaseUri, 'dist')
        ];

        const clientAssets = this.profile.clientAssets;
        if (!clientAssets) {
            return {
                scriptUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'diagram-client.js'),
                styleUri: this.getWebviewResourceUri(webview, 'dist', 'webview', 'diagram-client.css'),
                localResourceRoots: stockRoots
            };
        }

        const configuredRoots = (clientAssets.localResourceRoots ?? []).map(root => this.toResourceUri(root));
        return {
            scriptUri: this.getConfiguredAssetUri(webview, clientAssets.scriptPath),
            styleUri: clientAssets.stylePath
                ? this.getConfiguredAssetUri(webview, clientAssets.stylePath)
                : undefined,
            localResourceRoots: [...stockRoots, ...configuredRoots]
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
                `[WorkflowEditorProvider] Configured clientAssets path is not readable; serving with v=0: ${fileUri.fsPath}`
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
    protected getWebviewContent(
        webview: vscode.Webview,
        options: {
            scriptUri: vscode.Uri;
            libavoidWasmUri?: vscode.Uri;
            libavoidModuleUri?: vscode.Uri;
            styleUri?: vscode.Uri;
            clientId: string;
            documentUri: string;
        }
    ): string {
        // Use a content security policy to only allow loading specific resources
        const nonce = this.getNonce();

        // Debug toggles (set via launch.json env). These get applied inside the webview.
        const debugPortLabels = process.env.WORKFLOW_DIAGRAM_DEBUG_PORT_LABELS === '1';
        const debugPortLabelsAll = process.env.WORKFLOW_DIAGRAM_DEBUG_PORT_LABELS_ALL === '1';
        const debugPortLabelsThresholdPx = process.env.WORKFLOW_DIAGRAM_DEBUG_PORT_LABELS_THRESHOLD_PX;
        const debugPortLabelsFilter = process.env.WORKFLOW_DIAGRAM_DEBUG_PORT_LABELS_FILTER;
        const debugEdgePoints = process.env.WORKFLOW_DEBUG_EDGE_POINTS === '1';

        // The stylesheet link is emitted only when a style URI is present; a
        // consumer bundle may inline its CSS and supply no `stylePath`.
        const styleLink = options.styleUri
            ? `<link href="${options.styleUri}" rel="stylesheet" />\n    `
            : '';

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
            clientBehavior: this.profile.clientBehavior,
            // Where the live edge router fetches its WASM binary. The webview
            // cannot read the filesystem, so the URI is resolved host-side.
            libavoidWasmUri: options.libavoidWasmUri?.toString(),
            libavoidModuleUri: options.libavoidModuleUri?.toString()
        })};

        // Optional debug config injected from the extension host (launch.json env).
        try {
            if (${debugPortLabels ? 'true' : 'false'}) {
                localStorage.setItem('workflow.diagram.debug.portLabels', '1');
            }
            if (${debugPortLabelsAll ? 'true' : 'false'}) {
                localStorage.setItem('workflow.diagram.debug.portLabels.all', '1');
            }
            const thresholdRaw = ${debugPortLabelsThresholdPx ? JSON.stringify(debugPortLabelsThresholdPx) : 'undefined'};
            if (thresholdRaw !== undefined && thresholdRaw !== '') {
                localStorage.setItem('workflow.diagram.debug.portLabels.thresholdPx', String(thresholdRaw));
            }
            const filterRaw = ${debugPortLabelsFilter ? JSON.stringify(debugPortLabelsFilter) : 'undefined'};
            if (filterRaw !== undefined && filterRaw !== '') {
                localStorage.setItem('workflow.diagram.debug.portLabels.filter', String(filterRaw));
            }

            // Edge route/bendpoint overlay (WorkflowEdgeView).
            // This is a purely visual client-side debug aid.
            if (${debugEdgePoints ? 'true' : 'false'}) {
                (window).WORKFLOW_DEBUG_EDGE_POINTS = true;
            }
        } catch {
            // ignore
        }

        // Debug plumbing: verify webview -> extension host messaging works and surface
        // any runtime errors from the webview/client bundle in the Extension Host console.
        try {
            // NOTE: VS Code only allows acquiring the API once per webview.
            // Cache and reuse it; also override acquireVsCodeApi so libraries that
            // call it internally won't crash the webview.
            const originalAcquire = acquireVsCodeApi;
            const vscode = originalAcquire();
            window.__calVscodeApi = vscode;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window).acquireVsCodeApi = () => vscode;
            vscode.postMessage({ type: 'dialogram.diagram.clientDebug.inlinePing', payload: { when: Date.now() } });
            vscode.postMessage({
                type: 'dialogram.diagram.clientDebug.inlineConfig',
                payload: {
                    debugPortLabels: ${debugPortLabels ? 'true' : 'false'},
                    debugPortLabelsAll: ${debugPortLabelsAll ? 'true' : 'false'},
                    thresholdPx: ${debugPortLabelsThresholdPx ? JSON.stringify(debugPortLabelsThresholdPx) : 'undefined'},
                    filter: ${debugPortLabelsFilter ? JSON.stringify(debugPortLabelsFilter) : 'undefined'},
                    debugEdgePoints: ${debugEdgePoints ? 'true' : 'false'}
                }
            });
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
    getClientIdForDocumentUri(uri: vscode.Uri): string | undefined {
        return this.uriToClientId.get(this.canonicalizeUriString(uri));
    }

    /**
     * Open a source URI and select the given range — the `revealRange` capability
     * handed to a profile's {@link DiagramProfile.onWebviewMessage} hook. An
     * absent range opens the document without a selection.
     */
    private async revealRange(
        uriStr: string,
        range?: { startLine: number; startColumn?: number }
    ): Promise<void> {
        const uri = vscode.Uri.parse(uriStr);
        const selection = range
            ? new vscode.Range(range.startLine, range.startColumn ?? 0, range.startLine, range.startColumn ?? 0)
            : undefined;
        await vscode.window.showTextDocument(uri, { selection, preserveFocus: false });
    }

    /**
     * Dispatch a host→client action to the webview owning `uri` over the ungated
     * `sendMessageToClient` overlay-bridge path (reaches the client even for kinds
     * it did not advertise in `clientActions`). Backs the profile handle's
     * `dispatchToWebview`. No-op when no client is registered for the URI.
     */
    dispatchToWebview(uri: string, action: { kind: string } & Record<string, unknown>): void {
        const clientId = this.getClientIdForDocumentUri(vscode.Uri.parse(uri));
        if (!clientId) {
            return;
        }
        (this.glspVscodeConnector as unknown as {
            sendMessageToClient(clientId: string, message: unknown): void;
        }).sendMessageToClient(clientId, { clientId, action });
    }

    /**
     * Post a raw message straight to the webview panel owning `uri`. Backs the
     * profile handle's `postToWebview` (cursor-sync / graph-era channel). No-op
     * when no panel is registered for the URI.
     */
    postToWebview(uri: string, message: unknown): void {
        const webview = this.uriToWebview.get(this.canonicalizeUriString(uri));
        if (!webview) {
            return;
        }
        void webview.postMessage(message);
    }

    /**
     * Reload the diagram for a document from disk. Used after an external
     * mutation (e.g. a chat-issued edit-backend operation) so the graph reflects the
     * new source. Returns true if a diagram client was found and refreshed.
     */
    refreshModelFromDisk(uri: vscode.Uri): boolean {
        const clientId = this.getClientIdForDocumentUri(uri);
        if (!clientId) {
            return false;
        }
        this.dispatchModelRefresh(clientId, uri.toString(), { forceReloadFromDisk: true });
        return true;
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
