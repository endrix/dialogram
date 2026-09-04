/**
 * Workflow GLSP Extension Activation
 * 
 * Handles the GLSP integration activation for the Workflow VS Code extension.
 * This module sets up the GLSP server, connector, and editor provider.
 */

import 'reflect-metadata';

import {
    GlspVscodeConnector,
    configureDefaultCommands
} from '@eclipse-glsp/vscode-integration';
import {
    Action,
    ActionMessage,
    NavigateToExternalTargetAction,
    RequestModelAction,
    TriggerLayoutAction,
    FitToScreenAction,
    CenterAction,
    RequestExportSvgAction,
    UndoAction,
    RedoAction
} from '@eclipse-glsp/protocol';
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ContainerModule } from 'inversify';
import { registerWorkflowEditorProvider } from './diagram-editor-provider';
import type { WorkflowEditorProvider } from './diagram-editor-provider';
import { ExecutionOverlayRegistry } from './execution-overlay';
import { forwardExecutionOverlayEvents, type ExecutionOverlayWebviewSink } from './execution-overlay-bridge';
import { readRequestedNetworkName, resolveDiagramOpenTarget, type DiagramOpenTargetArg } from './open-diagram-target';
import { normalizeSourceUriKey } from './uri-keys';
import { executeViewerCommand, executeViewerOpen, executeViewerReveal } from './viewer-actions';
import { decideDiagramOpen } from './diagram-open-decision';
import { readMcpServerUrl } from './mcp-server-url';
import { composeStorageRuntimeOptions } from './profile-storage-options';
import { type DiagramProfile, type DiagramRunHost } from '../../api';

// Define the diagram type constant locally to avoid import
const WORKFLOW_DIAGRAM_TYPE = 'cal-network-diagram';

const OPEN_DIAGRAM_ARG = 'cal:openDiagram';
const NETWORK_NAME_ARG = 'cal:networkName';
const GRAPH_SOURCE_URI_ARG = 'cal:graphSourceUri';
const ROOT_WORKFLOW_ARG = 'cal:rootWorkflow';
const INSTANCE_PATH_ARG = 'cal:instancePath';
const NAV_TRAIL_ARG = 'wf:navTrail';
const RUN_ID_ARG = 'wf:runId';
const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';
const NAVIGATE_PREFER_DEFINITION_ARG = 'wf:navigatePreferDefinition';
const NAVIGATE_SOURCE_URI_ARG = 'wf:navigateSourceUri';
const NAVIGATE_SOURCE_RANGE_ARG = 'wf:navigateSourceRange';
const NAVIGATE_SYMBOL_ARG = 'wf:navigateSymbol';

// Viewer actions (sent from the webview via NavigateToExternalTargetAction).
const VIEWER_ACTION_ARG = 'wf:viewerAction';
const VIEWER_VIEW_TYPE_ARG = 'wf:viewerViewType';
const VIEWER_COMMAND_ARG = 'wf:viewerCommand';
const VIEWER_COMMAND_ARGS_ARG = 'wf:viewerCommandArgs';
const VIEWER_LEFT_URI_ARG = 'wf:viewerLeftUri';
const VIEWER_RIGHT_URI_ARG = 'wf:viewerRightUri';
const VIEWER_TITLE_ARG = 'wf:viewerTitle';
const VIEWER_MESSAGE_ARG = 'wf:viewerMessage';

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };
type ParsedShowOptions = Omit<vscode.TextDocumentShowOptions, 'selection'> & { selection?: SerializedRange };

// Client-side action kind (handled by @eclipse-glsp/client gridModule).
// Do NOT import from '@eclipse-glsp/client' here because the package loads CSS.
const SHOW_GRID_ACTION_KIND = 'showGrid';
const NAVIGATION_RACE_WINDOW_MS = 2500;

// When opening a new diagram editor (cross-file drill-down), we stash the target
// network name and inject it into the first RequestModelAction for that file.
// These maps are transient per-activation state, threaded via GlspActivationState
// (see the `pending*BySourceUri` / `recentNavigationBySourceUri` fields below).

function parseExternalTargetUri(value: string): vscode.Uri | undefined {
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
        try {
            return vscode.Uri.parse(trimmed);
        } catch {
            return undefined;
        }
    }
    if (path.isAbsolute(trimmed)) {
        return vscode.Uri.file(trimmed);
    }
    try {
        return vscode.Uri.parse(trimmed);
    } catch {
        return undefined;
    }
}


type NavigationTrailEntry = {
    sourceUri?: string;
    workflowName?: string;
    workflowInstanceName?: string;
};


function parseNavigationTrail(raw: unknown): NavigationTrailEntry[] {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: NavigationTrailEntry[] = [];
        for (const entry of parsed) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const sourceUri = typeof (entry as NavigationTrailEntry).sourceUri === 'string'
                ? (entry as NavigationTrailEntry).sourceUri
                : undefined;
            const workflowName = typeof (entry as NavigationTrailEntry).workflowName === 'string'
                ? (entry as NavigationTrailEntry).workflowName
                : undefined;
            const workflowInstanceName = typeof (entry as NavigationTrailEntry & { workflowInstanceName?: string }).workflowInstanceName === 'string'
                ? (entry as NavigationTrailEntry & { workflowInstanceName?: string }).workflowInstanceName
                : undefined;
            if (sourceUri || workflowName) {
                out.push({
                    sourceUri,
                    workflowName,
                    ...(workflowInstanceName ? { workflowInstanceName } : {})
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

function rewriteNavigationTrailTargetSourceUri(
    raw: string | undefined,
    targetWorkflowName: string | undefined,
    targetSourceUri: string
): string | undefined {
    if (typeof raw !== 'string' || raw.trim() === '' || !targetWorkflowName || targetWorkflowName.trim() === '') {
        return raw;
    }

    const entries = parseNavigationTrail(raw);
    if (entries.length === 0) {
        return raw;
    }

    const rewritten = entries.map(entry => ({ ...entry }));
    const last = rewritten[rewritten.length - 1];
    if (last && typeof last.workflowName === 'string' && last.workflowName.trim() === targetWorkflowName.trim()) {
        last.sourceUri = normalizeSourceUriKey(targetSourceUri);
        return JSON.stringify(rewritten);
    }

    return raw;
}


function putPending<T>(map: Map<string, T>, rawUri: string, value: T): void {
    const key = normalizeSourceUriKey(rawUri);
    map.set(key, value);
    if (key !== rawUri) {
        map.set(rawUri, value);
    }
}

function getPending<T>(map: Map<string, T>, rawUri: string): T | undefined {
    const key = normalizeSourceUriKey(rawUri);
    return map.get(key) ?? map.get(rawUri);
}

function clearPending<T>(map: Map<string, T>, rawUri: string): void {
    const key = normalizeSourceUriKey(rawUri);
    map.delete(key);
    map.delete(rawUri);
}

function rememberRecentNavigation(
    state: GlspActivationState,
    sourceUri: string,
    patch: { networkName?: string; navTrail?: string; runId?: string }
): void {
    const key = normalizeSourceUriKey(sourceUri);
    const existing = getPending(state.recentNavigationBySourceUri, sourceUri);
    const next = {
        networkName: patch.networkName ?? existing?.networkName,
        navTrail: patch.navTrail ?? existing?.navTrail,
        runId: patch.runId ?? existing?.runId,
        expiresAt: Date.now() + NAVIGATION_RACE_WINDOW_MS
    };
    putPending(state.recentNavigationBySourceUri, key, next);
}

function getRecentNavigation(
    state: GlspActivationState,
    sourceUri: string
): { networkName?: string; navTrail?: string; runId?: string } | undefined {
    const hit = getPending(state.recentNavigationBySourceUri, sourceUri);
    if (!hit) {
        return undefined;
    }
    if (hit.expiresAt <= Date.now()) {
        clearPending(state.recentNavigationBySourceUri, sourceUri);
        return undefined;
    }
    return {
        networkName: hit.networkName,
        navTrail: hit.navTrail,
        runId: hit.runId
    };
}

function isSerializedPosition(value: unknown): value is SerializedPosition {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.line === 'number' && typeof v.character === 'number';
}

function isSerializedRange(value: unknown): value is SerializedRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return isSerializedPosition(v.start) && isSerializedPosition(v.end);
}

function parseSerializedRangeArg(value: unknown): SerializedRange | undefined {
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

function parseShowOptionsArg(args: Record<string, unknown> | undefined): ParsedShowOptions | undefined {
    const raw = args?.[SHOW_OPTIONS_ARG];
    if (typeof raw !== 'string' || raw.trim() === '') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return undefined;
        }
        return parsed as ParsedShowOptions;
    } catch {
        return undefined;
    }
}

function parseNavigateSymbolArg(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed !== '' ? trimmed : undefined;
}


function serializedRangeToVscodeRange(range: SerializedRange): vscode.Range {
    return new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character
    );
}



/**
 * State scoped to a single {@link activateGlspIntegration} call, threaded through
 * the helper functions that previously read/wrote module-level singletons.
 */
interface GlspActivationState {
    context: vscode.ExtensionContext;
    profile: DiagramProfile;
    // Transient cross-file drill-down handoff, scoped to this activation (per profile instance).
    pendingNetworkBySourceUri: Map<string, string>;
    pendingNavTrailBySourceUri: Map<string, unknown>;
    pendingRunIdBySourceUri: Map<string, string>;
    pendingGraphSourceUriBySourceUri: Map<string, string>;
    pendingRootWorkflowBySourceUri: Map<string, string>;
    pendingInstancePathBySourceUri: Map<string, unknown>;
    recentNavigationBySourceUri: Map<string, { networkName?: string; navTrail?: string; runId?: string; expiresAt: number }>;
}

function queueTraceVisibleStateKey(profile: DiagramProfile): string {
    return `${profile.commands.setQueueTraceVisible}.state`;
}

/**
 * Handle returned by {@link activateGlspIntegration}, exposing the connector
 * and editor provider created during activation alongside a disposable for
 * teardown.
 */
export interface GlspIntegrationHandle extends vscode.Disposable {
    connector: GlspVscodeConnector;
    editorProvider: WorkflowEditorProvider;
    /** Per-activation neutral execution-overlay seam (states + opaque events). */
    executionOverlay: ExecutionOverlayRegistry;
    /**
     * The in-host GLSP-MCP loopback server URL announced on the `initialize` handshake,
     * or `undefined` when MCP is disabled or no endpoint was announced. Read from the typed
     * initialize result (no stdout parsing). The chat runtime hands it to the agent clients.
     */
    mcpServerUrl?: string;
}

/**
 * Activate the GLSP integration for Workflow diagrams.
 *
 * This sets up:
 * - NodeGlspVscodeServer for handling GLSP protocol
 * - GlspVscodeConnector for communication management
 * - WorkflowEditorProvider for custom editor support
 * - Default GLSP commands
 *
 * @param context - Extension context
 * @returns Handle exposing the connector, editor provider, and a disposable for cleanup
 */
export async function activateGlspIntegration(
    context: vscode.ExtensionContext,
    profile: DiagramProfile,
    assetsUri?: vscode.Uri
): Promise<GlspIntegrationHandle> {
    console.log('[Workflow GLSP] Starting GLSP activation...');

    const state: GlspActivationState = {
        context,
        profile,
        pendingNetworkBySourceUri: new Map(),
        pendingNavTrailBySourceUri: new Map(),
        pendingRunIdBySourceUri: new Map(),
        pendingGraphSourceUriBySourceUri: new Map(),
        pendingRootWorkflowBySourceUri: new Map(),
        pendingInstancePathBySourceUri: new Map(),
        recentNavigationBySourceUri: new Map()
    };

    console.log('[Workflow GLSP] Creating GLSP server...');

    // Lazy import to avoid loading modules at extension activation time
    const { createWorkflowGlspVscodeServer } = await import('@dialogram/diagram-server');

    // GLSP-MCP opt-in gate. When on, load the MCP DI modules (bridging the profile's
    // read-only chat tools into diagram-scope MCP tools) AND send the wire-level
    // `mcpServer` config that boots the in-host loopback listener on `initialize`.
    const mcpEnabled = profile.mcp?.enabled === true;

    // The palette-suppression flag lives on the profile ROOT but is read on the
    // server off the storage runtime options, so it is folded onto that channel
    // here. See `profile-storage-options.ts` for the one case that is not a
    // straight pass-through.
    const storageOptions = composeStorageRuntimeOptions(profile);

    // Create the GLSP server (runs in the extension process). Every product
    // detail — model source, extra DI modules, edit operation modules and the
    // neutral storage options — arrives through the profile; core stays neutral.
    const workflowServer = createWorkflowGlspVscodeServer({
        clientId: profile.glspClientId,
        clientName: profile.glspClientName,
        storageOptions,
        additionalServerModules: (profile.serverModules ?? []) as ContainerModule[],
        edits: profile.edits,
        modelSourceFactory: profile.modelSource,
        // Build-time library seam: when the profile supplies its own GLSP DiagramModule
        // (constructed in the caller's realm), it replaces the stock module on the server.
        diagramModuleFactory: profile.serverDiagramModule,
        // MCP DI modules + the profile's read-only chat tools bridged into diagram-scope
        // MCP tools (library-mode closures; absent on the cross-extension API path).
        mcp: mcpEnabled ? { enabled: true, tools: profile.chat?.tools } : undefined,
        // Wire-level opt-in: a distinct server name per profile so two installed consumers
        // never collide on the built-in MCP host registry.
        mcpServer: mcpEnabled ? { name: `glsp-${profile.key}` } : undefined
    });

    // Start the server
    await workflowServer.start();

    // When MCP is on, read the announced loopback URL from the typed initialize result
    // (no stdout parsing). Skipped when off so activation never awaits an absent MCP field.
    const mcpServerUrl = await readMcpServerUrl(workflowServer, mcpEnabled);

    // Cross-file navigation provider, supplied by the profile (undefined = no
    // cross-file resolution; navigation falls through to the referenced target).
    const navigationProvider = profile.navigation;

    // Create the GLSP VS Code connector
    const glspVscodeConnector = new GlspVscodeConnector({
        server: workflowServer,
        logging: process.env.GLSP_DEBUG === 'true',
        onBeforeReceiveMessageFromClient: (message, callback) => {
            // Cross-file drill-down: open referenced file with the DIAGRAM editor
            // (not the text editor).
            if (ActionMessage.is(message) && NavigateToExternalTargetAction.is(message.action)) {
                const { uri, args } = message.action.target;

                if (args?.[NAVIGATE_PREFER_DEFINITION_ARG] === true) {
                    const fallbackTargetUri = parseExternalTargetUri(uri);
                    if (!fallbackTargetUri) {
                        void vscode.window.showErrorMessage(`Could not open target: ${uri}`);
                        callback(message, false);
                        return;
                    }
                    const sourceUriRaw = typeof args?.[NAVIGATE_SOURCE_URI_ARG] === 'string'
                        ? String(args[NAVIGATE_SOURCE_URI_ARG]).trim()
                        : '';
                    const sourceSelection = parseSerializedRangeArg(args?.[NAVIGATE_SOURCE_RANGE_ARG]);
                    const symbolHint = parseNavigateSymbolArg(args?.[NAVIGATE_SYMBOL_ARG]);
                    const showOptionsFromArgs = parseShowOptionsArg(args as Record<string, unknown> | undefined);

                    void (async () => {
                        let finalUri = fallbackTargetUri;
                        let finalSelection = isSerializedRange(showOptionsFromArgs?.selection)
                            ? showOptionsFromArgs?.selection
                            : undefined;

                        if (sourceUriRaw !== '') {
                            try {
                                const sourceUri = parseExternalTargetUri(sourceUriRaw);
                                if (!sourceUri) {
                                    throw new Error('invalid source uri');
                                }
                                const definitionTarget = await navigationProvider?.resolveTarget({
                                    kind: 'definition',
                                    sourceUri: sourceUri.toString(),
                                    ...(sourceSelection ? { sourceSelection } : {}),
                                    ...(symbolHint ? { symbolHint } : {})
                                });
                                if (definitionTarget) {
                                    finalUri = vscode.Uri.parse(definitionTarget.uri);
                                    finalSelection = definitionTarget.range
                                        ? {
                                            start: { line: definitionTarget.range.startLine, character: definitionTarget.range.startColumn },
                                            end: { line: definitionTarget.range.endLine, character: definitionTarget.range.endColumn }
                                        }
                                        : undefined;
                                }
                            } catch {
                                // Ignore source URI parse failures and fall back to referenced target.
                            }
                        }

                        const showOptions: vscode.TextDocumentShowOptions = {
                            ...(showOptionsFromArgs?.viewColumn !== undefined ? { viewColumn: showOptionsFromArgs.viewColumn } : {}),
                            ...(finalSelection ? { selection: serializedRangeToVscodeRange(finalSelection) } : {}),
                            preview: typeof showOptionsFromArgs?.preview === 'boolean' ? showOptionsFromArgs.preview : true,
                            preserveFocus: typeof showOptionsFromArgs?.preserveFocus === 'boolean' ? showOptionsFromArgs.preserveFocus : false
                        };

                        void vscode.window.showTextDocument(finalUri, showOptions);
                    })();

                    callback(message, false);
                    return;
                }

                // Viewer requests (open/openWith/diff/error)
                const viewerAction = args?.[VIEWER_ACTION_ARG];
                if (typeof viewerAction === 'string') {
                    if (viewerAction === 'error') {
                        const msg = args?.[VIEWER_MESSAGE_ARG];
                        void vscode.window.showErrorMessage(typeof msg === 'string' ? msg : 'Viewer action failed');
                        callback(message, false);
                        return;
                    }

                    if (viewerAction === 'diff') {
                        const left = args?.[VIEWER_LEFT_URI_ARG];
                        const right = args?.[VIEWER_RIGHT_URI_ARG];
                        const title = args?.[VIEWER_TITLE_ARG];
                        if (typeof left === 'string' && typeof right === 'string') {
                            const leftUri = parseExternalTargetUri(left);
                            const rightUri = parseExternalTargetUri(right);
                            if (!leftUri || !rightUri) {
                                void vscode.window.showErrorMessage('Viewer diff: invalid file URIs');
                                callback(message, false);
                                return;
                            }
                            void vscode.commands.executeCommand(
                                'vscode.diff',
                                leftUri,
                                rightUri,
                                typeof title === 'string' ? title : 'Diff'
                            );
                        } else {
                            void vscode.window.showErrorMessage('Viewer diff: missing file URIs');
                        }
                        callback(message, false);
                        return;
                    }

                    // open / openWith
                    const targetUri = parseExternalTargetUri(uri);
                    if (!targetUri) {
                        void vscode.window.showErrorMessage(`Could not open target: ${uri}`);
                        callback(message, false);
                        return;
                    }

                    if (viewerAction === 'command') {
                        const command = args?.[VIEWER_COMMAND_ARG];
                        const commandArgsRaw = args?.[VIEWER_COMMAND_ARGS_ARG];
                        if (typeof command !== 'string' || command.trim() === '') {
                            void vscode.window.showErrorMessage('Viewer command: missing command id');
                            callback(message, false);
                            return;
                        }
                        let commandArgs: unknown[] = [];
                        if (typeof commandArgsRaw === 'string') {
                            try {
                                const parsed = JSON.parse(commandArgsRaw);
                                if (Array.isArray(parsed)) {
                                    commandArgs = parsed;
                                }
                            } catch {
                                commandArgs = [];
                            }
                        }
                        void executeViewerCommand(command, targetUri, commandArgs).catch(error => {
                            const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
                            void vscode.window.showErrorMessage(message);
                        });
                        callback(message, false);
                        return;
                    }

                    if (viewerAction === 'reveal') {
                        void executeViewerReveal(targetUri).catch(error => {
                            const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
                            void vscode.window.showErrorMessage(message);
                        });
                        callback(message, false);
                        return;
                    }

                    if (viewerAction === 'openWith') {
                        void executeViewerOpen(targetUri, args?.[VIEWER_VIEW_TYPE_ARG]).catch(error => {
                            const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
                            void vscode.window.showErrorMessage(message);
                        });
                        callback(message, false);
                        return;
                    }

                    // Default open
                    void vscode.commands.executeCommand('vscode.open', targetUri);
                    callback(message, false);
                    return;
                }

                if (args?.[OPEN_DIAGRAM_ARG] === true) {
                    const initialTargetUri = parseExternalTargetUri(uri);
                    if (!initialTargetUri) {
                        void vscode.window.showErrorMessage(`Could not open diagram target: ${uri}`);
                        callback(message, false);
                        return;
                    }
                    const networkName = typeof args?.[NETWORK_NAME_ARG] === 'string'
                        ? String(args[NETWORK_NAME_ARG]).trim()
                        : undefined;
                    const graphSourceUri = typeof args?.[GRAPH_SOURCE_URI_ARG] === 'string'
                        ? String(args[GRAPH_SOURCE_URI_ARG]).trim() || undefined
                        : undefined;
                    const rootWorkflow = typeof args?.[ROOT_WORKFLOW_ARG] === 'string'
                        ? String(args[ROOT_WORKFLOW_ARG]).trim() || undefined
                        : undefined;
                    const rawInstancePath = args?.[INSTANCE_PATH_ARG];
                    const instancePath = Array.isArray(rawInstancePath)
                        ? rawInstancePath
                        : typeof rawInstancePath === 'string' && String(rawInstancePath).trim() !== ''
                            ? rawInstancePath
                            : undefined;
                    const hasInstancePath = Array.isArray(instancePath)
                        ? instancePath.length > 0
                        : typeof instancePath === 'string' && instancePath.trim() !== '';
                    const navTrailRaw = typeof args?.[NAV_TRAIL_ARG] === 'string'
                        ? String(args[NAV_TRAIL_ARG])
                        : undefined;
                    const requestedRunId = typeof args?.[RUN_ID_ARG] === 'string'
                        ? String(args[RUN_ID_ARG]).trim() || undefined
                        : undefined;
                    const incomingTrail = parseNavigationTrail(navTrailRaw);
                    const preferredSourceUri = typeof incomingTrail[0]?.sourceUri === 'string'
                        ? incomingTrail[0].sourceUri
                        : undefined;

                    void (async () => {
                        let targetUri = initialTargetUri;
                        if (networkName && networkName !== '') {
                            const definitionUri = await navigationProvider?.resolveTarget({
                                kind: 'workflow-definition-uri',
                                networkName,
                                fallbackUri: initialTargetUri.toString(),
                                ...(preferredSourceUri ? { preferredSourceUri } : {})
                            });
                            if (definitionUri) {
                                targetUri = vscode.Uri.parse(definitionUri.uri);
                            }
                        }

                        const canOpen = profile.canOpenSource
                            ? await profile.canOpenSource(targetUri, { requestedName: networkName })
                            : undefined;
                        const graphFallbackAvailable = !!graphSourceUri
                            && !!rootWorkflow
                            && hasInstancePath;
                        const openDecision = decideDiagramOpen(canOpen, graphFallbackAvailable);
                        const useGraphFallback = openDecision === 'graph-fallback';

                        if (openDecision === 'text-fallback') {
                            await vscode.window.showTextDocument(targetUri, {
                                preview: true,
                                preserveFocus: false
                            });
                            return;
                        }

                        const sourceRaw = targetUri.toString();
                        const navTrail = rewriteNavigationTrailTargetSourceUri(navTrailRaw, networkName, sourceRaw);

                        if (networkName && networkName !== '') {
                            putPending(state.pendingNetworkBySourceUri, sourceRaw, networkName);
                        }
                        if (typeof navTrail === 'string') {
                            putPending(state.pendingNavTrailBySourceUri, sourceRaw, navTrail);
                        }
                        if (requestedRunId) {
                            putPending(state.pendingRunIdBySourceUri, sourceRaw, requestedRunId);
                        }
                        if (useGraphFallback && graphSourceUri && rootWorkflow && instancePath !== undefined) {
                            putPending(state.pendingGraphSourceUriBySourceUri, sourceRaw, graphSourceUri);
                            putPending(state.pendingRootWorkflowBySourceUri, sourceRaw, rootWorkflow);
                            putPending(state.pendingInstancePathBySourceUri, sourceRaw, instancePath);
                        }
                        if ((networkName && networkName !== '') || typeof navTrail === 'string' || requestedRunId) {
                            rememberRecentNavigation(state, sourceRaw, {
                                ...(networkName && networkName !== '' ? { networkName } : {}),
                                ...(typeof navTrail === 'string' ? { navTrail } : {}),
                                ...(requestedRunId ? { runId: requestedRunId } : {})
                            });
                        }

                        await vscode.commands.executeCommand('vscode.openWith', targetUri, profile.customEditorViewType);

                        // Ensure cross-file drill-down is applied even when the target diagram
                        // editor already exists and does not emit a fresh initial request.
                        const applyRequestToTargetClient = async (): Promise<void> => {
                            const provider = editorProvider;
                            if (!provider) {
                                return;
                            }
                            const sourceUri = targetUri.toString();
                            const queueTraceVisible = context.globalState.get<boolean>(queueTraceVisibleStateKey(profile), true);

                            // Retry briefly while editor/client is initializing.
                            const delays = [0, 80, 180, 350, 700];
                            for (const delayMs of delays) {
                                if (delayMs > 0) {
                                    await new Promise(resolve => setTimeout(resolve, delayMs));
                                }

                                const clientId = provider.getClientIdForDocumentUri(targetUri);
                                if (!clientId) {
                                    continue;
                                }

                                const request = RequestModelAction.create({
                                    requestId: `open-diagram-${Date.now()}`,
                                    options: {
                                        sourceUri,
                                        diagramType: WORKFLOW_DIAGRAM_TYPE,
                                        queueTraceVisible,
                                        ...(networkName && networkName !== '' ? { networkName } : {}),
                                        ...(typeof navTrail === 'string' ? { [NAV_TRAIL_ARG]: navTrail } : {}),
                                        ...(requestedRunId ? { [RUN_ID_ARG]: requestedRunId } : {}),
                                        ...(useGraphFallback && graphSourceUri && rootWorkflow && instancePath !== undefined
                                            ? {
                                                [GRAPH_SOURCE_URI_ARG]: graphSourceUri,
                                                [ROOT_WORKFLOW_ARG]: rootWorkflow,
                                                [INSTANCE_PATH_ARG]: instancePath
                                            }
                                            : {})
                                    }
                                });
                                glspVscodeConnector.dispatchAction(request, clientId);
                                rememberRecentNavigation(state, sourceRaw, {
                                    ...(networkName && networkName !== '' ? { networkName } : {}),
                                    ...(typeof navTrail === 'string' ? { navTrail } : {}),
                                    ...(requestedRunId ? { runId: requestedRunId } : {})
                                });
                                // We explicitly applied the target selection for this source;
                                // clear pending handoff to avoid stale overrides on later requests.
                                clearPending(state.pendingNetworkBySourceUri, sourceRaw);
                                clearPending(state.pendingNavTrailBySourceUri, sourceRaw);
                                clearPending(state.pendingRunIdBySourceUri, sourceRaw);
                                clearPending(state.pendingGraphSourceUriBySourceUri, sourceRaw);
                                clearPending(state.pendingRootWorkflowBySourceUri, sourceRaw);
                                clearPending(state.pendingInstancePathBySourceUri, sourceRaw);
                                break;
                            }
                        };
                        await applyRequestToTargetClient();
                    })();

                    // Skip default connector processing (which would showTextDocument).
                    callback(message, false);
                    return;
                }
            }

            // Inject pending network selection into the first model request.
            if (ActionMessage.is(message) && RequestModelAction.is(message.action)) {
                const queueTraceVisible = context.globalState.get<boolean>(queueTraceVisibleStateKey(profile), true);
                const sourceUri = (message.action.options as any)?.sourceUri;
                const requestedNetworkName = (message.action.options as any)?.networkName;
                const requestedNavTrail = (message.action.options as any)?.[NAV_TRAIL_ARG];
                const requestedRunId = (message.action.options as any)?.[RUN_ID_ARG];
                const requestedGraphSourceUri = (message.action.options as any)?.[GRAPH_SOURCE_URI_ARG];
                const requestedRootWorkflow = (message.action.options as any)?.[ROOT_WORKFLOW_ARG];
                const requestedInstancePath = (message.action.options as any)?.[INSTANCE_PATH_ARG];
                const hasExplicitNetworkName = typeof requestedNetworkName === 'string' && requestedNetworkName.trim() !== '';
                const hasExplicitNavTrail = typeof requestedNavTrail === 'string' && requestedNavTrail.trim() !== '';
                const hasExplicitRunId = typeof requestedRunId === 'string' && requestedRunId.trim() !== '';
                const hasExplicitGraphSourceUri = typeof requestedGraphSourceUri === 'string' && requestedGraphSourceUri.trim() !== '';
                const hasExplicitRootWorkflow = typeof requestedRootWorkflow === 'string' && requestedRootWorkflow.trim() !== '';
                const hasExplicitInstancePath = requestedInstancePath !== undefined;

                if (typeof sourceUri === 'string' && (hasExplicitNetworkName || hasExplicitNavTrail || hasExplicitRunId)) {
                    rememberRecentNavigation(state, sourceUri, {
                        ...(hasExplicitNetworkName ? { networkName: String(requestedNetworkName).trim() } : {}),
                        ...(hasExplicitNavTrail ? { navTrail: String(requestedNavTrail) } : {}),
                        ...(hasExplicitRunId ? { runId: String(requestedRunId).trim() } : {})
                    });
                }

                let pendingNetwork: string | undefined;
                let pendingTrail: unknown;
                let pendingRunId: string | undefined;
                let pendingGraphSourceUri: string | undefined;
                let pendingRootWorkflow: string | undefined;
                let pendingInstancePath: unknown;
                const recent = typeof sourceUri === 'string' ? getRecentNavigation(state, sourceUri) : undefined;
                let applyPendingNetwork = false;
                let applyPendingTrail = false;
                let applyPendingRunId = false;
                let applyPendingGraphSourceUri = false;
                let applyPendingRootWorkflow = false;
                let applyPendingInstancePath = false;
                let applyRecentNetwork = false;
                let applyRecentTrail = false;
                let applyRecentRunId = false;
                if (typeof sourceUri === 'string') {
                    pendingNetwork = getPending(state.pendingNetworkBySourceUri, sourceUri);
                    pendingTrail = getPending(state.pendingNavTrailBySourceUri, sourceUri);
                    pendingRunId = getPending(state.pendingRunIdBySourceUri, sourceUri);
                    pendingGraphSourceUri = getPending(state.pendingGraphSourceUriBySourceUri, sourceUri);
                    pendingRootWorkflow = getPending(state.pendingRootWorkflowBySourceUri, sourceUri);
                    pendingInstancePath = getPending(state.pendingInstancePathBySourceUri, sourceUri);

                    const explicitName = typeof requestedNetworkName === 'string' ? requestedNetworkName.trim() : '';
                    const pendingName = typeof pendingNetwork === 'string' ? pendingNetwork.trim() : '';
                    const explicitMatchesPending = explicitName !== '' && pendingName !== '' && explicitName === pendingName;

                    applyPendingNetwork = !hasExplicitNetworkName && pendingName !== '';
                    applyPendingTrail = !hasExplicitNavTrail && pendingTrail !== undefined && (!hasExplicitNetworkName || explicitMatchesPending);
                    applyPendingRunId = !hasExplicitRunId && typeof pendingRunId === 'string' && pendingRunId.trim() !== '';
                    applyPendingGraphSourceUri = !hasExplicitGraphSourceUri && typeof pendingGraphSourceUri === 'string' && pendingGraphSourceUri.trim() !== '';
                    applyPendingRootWorkflow = !hasExplicitRootWorkflow && typeof pendingRootWorkflow === 'string' && pendingRootWorkflow.trim() !== '';
                    applyPendingInstancePath = !hasExplicitInstancePath && pendingInstancePath !== undefined;

                    // Clear once we have applied what we can for this source; otherwise keep pending
                    // so the next request can still consume it.
                    if (
                        applyPendingNetwork
                        || applyPendingTrail
                        || applyPendingRunId
                        || applyPendingGraphSourceUri
                        || applyPendingRootWorkflow
                        || applyPendingInstancePath
                    ) {
                        clearPending(state.pendingNetworkBySourceUri, sourceUri);
                        clearPending(state.pendingNavTrailBySourceUri, sourceUri);
                        clearPending(state.pendingRunIdBySourceUri, sourceUri);
                        clearPending(state.pendingGraphSourceUriBySourceUri, sourceUri);
                        clearPending(state.pendingRootWorkflowBySourceUri, sourceUri);
                        clearPending(state.pendingInstancePathBySourceUri, sourceUri);
                    }

                    const recentName = recent?.networkName?.trim();
                    const recentTrail = recent?.navTrail;
                    const explicitNameForRecent = hasExplicitNetworkName ? String(requestedNetworkName).trim() : '';
                    const explicitMatchesRecent = explicitNameForRecent !== '' && !!recentName && explicitNameForRecent === recentName;

                    applyRecentNetwork = !applyPendingNetwork && !hasExplicitNetworkName && !!recentName;
                    applyRecentTrail = !applyPendingTrail
                        && !hasExplicitNavTrail
                        && typeof recentTrail === 'string'
                        && (!hasExplicitNetworkName || explicitMatchesRecent);
                    applyRecentRunId = !applyPendingRunId
                        && !hasExplicitRunId
                        && typeof recent?.runId === 'string'
                        && recent.runId.trim() !== '';
                }

                const patched = {
                    ...message,
                    action: {
                        ...message.action,
                        options: {
                            ...(message.action.options as any),
                            ...(applyPendingNetwork && typeof pendingNetwork === 'string' ? { networkName: pendingNetwork, diagramType: WORKFLOW_DIAGRAM_TYPE } : {}),
                            ...(applyPendingTrail && typeof pendingTrail === 'string' ? { [NAV_TRAIL_ARG]: pendingTrail } : {}),
                            ...(applyPendingRunId && typeof pendingRunId === 'string' ? { [RUN_ID_ARG]: pendingRunId } : {}),
                            ...(applyPendingGraphSourceUri && typeof pendingGraphSourceUri === 'string' ? { [GRAPH_SOURCE_URI_ARG]: pendingGraphSourceUri } : {}),
                            ...(applyPendingRootWorkflow && typeof pendingRootWorkflow === 'string' ? { [ROOT_WORKFLOW_ARG]: pendingRootWorkflow } : {}),
                            ...(applyPendingInstancePath ? { [INSTANCE_PATH_ARG]: pendingInstancePath } : {}),
                            ...(applyRecentNetwork && typeof recent?.networkName === 'string' ? { networkName: recent.networkName, diagramType: WORKFLOW_DIAGRAM_TYPE } : {}),
                            ...(applyRecentTrail && typeof recent?.navTrail === 'string' ? { [NAV_TRAIL_ARG]: recent.navTrail } : {}),
                            ...(applyRecentRunId && typeof recent?.runId === 'string' ? { [RUN_ID_ARG]: recent.runId } : {}),
                            queueTraceVisible
                        }
                    }
                };
                if (typeof sourceUri === 'string') {
                    const finalOptions = (patched.action.options as any) ?? {};
                    editorProvider?.setRefreshContext(sourceUri, {
                        ...(typeof finalOptions.networkName === 'string' && finalOptions.networkName.trim() !== ''
                            ? { networkName: finalOptions.networkName.trim() }
                            : {}),
                        ...(typeof finalOptions[NAV_TRAIL_ARG] === 'string' && finalOptions[NAV_TRAIL_ARG].trim() !== ''
                            ? { navTrail: finalOptions[NAV_TRAIL_ARG] }
                            : {}),
                        ...(typeof finalOptions[RUN_ID_ARG] === 'string' && finalOptions[RUN_ID_ARG].trim() !== ''
                            ? { runId: finalOptions[RUN_ID_ARG] }
                            : {}),
                        queueTraceVisible
                    });
                }
                callback(patched as any, true);
                return;
            }

            callback(message, true);
        },
        onBeforePropagateMessageToServer: (originalMessage, processedMessage) => {
            // NavigateToExternalTargetAction is always handled in the extension host
            // (by the connector's built-in handler or our onBeforeReceiveMessageFromClient).
            // It should never be forwarded to the GLSP server, which has no handler for it.
            if (ActionMessage.is(originalMessage) && NavigateToExternalTargetAction.is(originalMessage.action)) {
                return undefined;
            }
            return processedMessage;
        }
    });

    // Register the custom editor provider
    const { disposable: editorProviderDisposable, provider: editorProvider } = registerWorkflowEditorProvider(
        context,
        glspVscodeConnector,
        profile,
        assetsUri
    );

    // Configure default GLSP commands (undo, redo, copy, paste, etc.)
    configureDefaultCommands({
        extensionContext: context,
        connector: glspVscodeConnector,
        diagramPrefix: profile.key
    });

    // Neutral execution-overlay seam (v2). Run drivers publish node states and
    // opaque stream events here; this host bridge forwards each emitted event
    // batch to the owning webview, resolving the target client from the source
    // URI exactly as the in-core run machinery did (canonicalized URI → clientId).
    // Key the replay buffer through the SAME canonicalization the editor provider
    // uses for its client/URI resolution (Task-4 review M2): the run driver emits
    // with one URI form and the provider replays with another; canonicalizing both
    // through `normalizeSourceUriKey` makes them hit the same buffer.
    const executionOverlay = new ExecutionOverlayRegistry(normalizeSourceUriKey);
    // One send path shared by live emission and replay drain so both use the
    // identical envelope, kind and ungated transport.
    //
    // Client-only kind → forward via the UNGATED sendMessageToClient path.
    // dispatchAction() only reaches the webview for kinds the client advertised
    // in `clientActions`, so it silently drops this batch — see the bridge note.
    // sendMessageToClient is protected on GlspVscodeConnector (same reason the
    // showGrid toggle below casts) — the bridge only needs that one method.
    const sendOverlayBatch = (uri: string, events: unknown[], origin: 'live' | 'replay'): void => {
        const clientId = editorProvider.getClientIdForDocumentUri(vscode.Uri.parse(uri));
        // eslint-disable-next-line no-console
        console.log(`[wf-lang overlay] host: bridge ${origin} uri=${uri} events=${events.length} clientId=${clientId ?? 'undefined'}`);
        const sink = glspVscodeConnector as unknown as ExecutionOverlayWebviewSink;
        forwardExecutionOverlayEvents(sink, clientId, uri, events, reason => {
            // UNGATED on purpose: a dropped batch (no diagram registered yet for the
            // source URI when the batch is emitted) is the one place a run's events
            // can vanish silently. Keep it visible so the next live run bisects.
            // eslint-disable-next-line no-console
            console.warn(reason);
        });
    };
    const executionOverlaySubscription = executionOverlay.onDidEmitEvents((uri, events) => {
        sendOverlayBatch(uri, events, 'live');
    });
    // Replay-on-(re)registration: when a webview registers for a source URI, drain
    // its bounded replay window through the SAME bridge BEFORE any subsequent live
    // batch. The drain is synchronous within the provider's registration event, so
    // on the single-threaded host loop the replayed window is enqueued ahead of any
    // live batch emitted afterwards (postMessage preserves order). A fresh source
    // has an empty window → nothing is sent.
    const executionOverlayReplaySubscription = editorProvider.onDidRegisterClient(uri => {
        const replay = executionOverlay.replayEvents(uri);
        if (replay.length === 0) {
            return;
        }
        sendOverlayBatch(uri, replay, 'replay');
    });

    // Register additional Workflow-specific commands
    registerCalDiagramCommands(state, glspVscodeConnector, editorProvider, executionOverlay);

    // Composite disposable for cleanup, kept internal to the handle below.
    const disposable = vscode.Disposable.from(
        editorProviderDisposable,
        glspVscodeConnector,
        executionOverlaySubscription,
        executionOverlayReplaySubscription
    );

    return {
        connector: glspVscodeConnector,
        editorProvider,
        executionOverlay,
        mcpServerUrl,
        dispose: () => disposable.dispose()
    };
}

/**
 * Register Workflow-specific diagram commands.
 */
function registerCalDiagramCommands(
    state: GlspActivationState,
    connector: GlspVscodeConnector,
    editorProvider: WorkflowEditorProvider,
    executionOverlay: ExecutionOverlayRegistry
): void {
    const { context, profile } = state;
    const gridStateKey = `${profile.commands.toggleGrid}.gridVisible`;

    const getActiveWorkflowDiagramUri = (): vscode.Uri | undefined => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input: any = tab?.input;
        // vscode.TabInputCustom has shape { viewType: string, uri: vscode.Uri }
        if (input && typeof input === 'object' && input.viewType === profile.customEditorViewType && input.uri) {
            return input.uri as vscode.Uri;
        }
        return undefined;
    };

    const getQueueTraceVisible = (): boolean => context.globalState.get<boolean>(queueTraceVisibleStateKey(profile), true);

    const getActiveDiagramClientId = (): string | undefined => {
        const provider = editorProvider;
        const uri = getActiveWorkflowDiagramUri();
        if (!provider || !uri) {
            return undefined;
        }
        return provider.getClientIdForDocumentUri(uri);
    };

    const dispatchToActiveDiagram = (action: Action): void => {
        const clientId = getActiveDiagramClientId();
        if (clientId) {
            connector.dispatchAction(action, clientId);
            return;
        }
        connector.dispatchAction(action);
    };

    const getActiveWorkflowUri = (): vscode.Uri | undefined => {
        const diagramUri = getActiveWorkflowDiagramUri();
        if (diagramUri?.fsPath?.endsWith('.py')) {
            return diagramUri;
        }
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        if (activeEditorUri?.fsPath?.endsWith('.py')) {
            return activeEditorUri;
        }
        return undefined;
    };

    const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const workspaceEditHasChanges = (edit: vscode.WorkspaceEdit): boolean => {
        for (const [_uri, edits] of edit.entries()) {
            if (edits.length > 0) {
                return true;
            }
        }
        return false;
    };

    const resolveRenameEdit = async (
        document: vscode.TextDocument,
        oldName: string,
        newName: string
    ): Promise<vscode.WorkspaceEdit | undefined> => {
        const text = document.getText();
        const matches = [...text.matchAll(new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g'))];

        for (const match of matches) {
            const offset = match.index;
            if (typeof offset !== 'number') {
                continue;
            }
            const position = document.positionAt(offset);
            try {
                const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
                    'vscode.executeDocumentRenameProvider',
                    document.uri,
                    position,
                    newName
                );
                if (edit && workspaceEditHasChanges(edit)) {
                    return edit;
                }
            } catch {
                // Try next occurrence if this position is not renameable.
            }
        }

        return undefined;
    };

    const refreshActiveDiagramModel = async (opts?: { sourceUri?: string; workflowName?: string; agentContextOnly?: boolean }): Promise<void> => {
        const uri = opts?.sourceUri ? vscode.Uri.parse(opts.sourceUri) : getActiveWorkflowDiagramUri();
        if (!uri) {
            return;
        }
        const provider = editorProvider;
        const clientId = provider?.getClientIdForDocumentUri(uri);
        if (!provider || !clientId) {
            return;
        }
        const refreshContext = provider.getRefreshContext(uri);
        const refreshAction = RequestModelAction.create({
            requestId: 'refresh-queue-visibility-' + Date.now(),
            options: {
                sourceUri: uri.toString(),
                diagramType: WORKFLOW_DIAGRAM_TYPE,
                queueTraceVisible: getQueueTraceVisible(),
                // Queue-trace visibility toggles only re-apply the queue-trace overlay (edge glow /
                // queue-depth args) onto the unchanged graph — no node/edge/position change — so this
                // redelivery can rebuild off the warm plan cache and skip the RequestBounds round-trip
                // via the agent-context-only fast path. Callers that may change the source (rename) or
                // want a fresh re-plan (the generic refresh command) leave this unset and pay the full
                // reload, which re-acquires and re-runs bounds as required for correctness.
                ...(opts?.agentContextOnly ? { agentContextOnly: true } : {}),
                ...(opts?.workflowName ? { networkName: opts.workflowName } : refreshContext?.networkName ? { networkName: refreshContext.networkName } : {}),
                ...(refreshContext?.navTrail ? { [NAV_TRAIL_ARG]: refreshContext.navTrail } : {})
            }
        });
        connector.dispatchAction(refreshAction, clientId);
    };

    // The setAgentToolConfig / getAgentToolConfig commands are registered by the
    // CliRunDriver (see below), which now owns the per-entity override state.

    // Command: Open diagram for current file
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.openDiagram, async (arg?: DiagramOpenTargetArg) => {
            const sourceUri = await resolveDiagramOpenTarget(arg, {
                getActiveWorkflowUri,
                openTextDocument: vscode.workspace.openTextDocument,
                workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            });
            if (!sourceUri) {
                vscode.window.showWarningMessage('Please open a .py file first, or pass a .py path/URI to the command.');
                return;
            }
            const requestedNetwork = readRequestedNetworkName(arg);
            const canOpen = profile.canOpenSource
                ? await profile.canOpenSource(sourceUri, { requestedName: requestedNetwork })
                : undefined;
            if (decideDiagramOpen(canOpen, false) === 'text-fallback') {
                await vscode.window.showTextDocument(sourceUri, {
                    preview: true,
                    preserveFocus: false
                });
                return;
            }
            // Stash the requested graph the same way a drill-down does, so the
            // initial model request picks it up. `vscode.openWith` carries no
            // arbitrary data, so this side channel is the only way a name known
            // before the editor exists can reach the model source.
            if (requestedNetwork) {
                putPending(state.pendingNetworkBySourceUri, sourceUri.toString(), requestedNetwork);
            }
            // Open the source file with the workflow diagram editor
            await vscode.commands.executeCommand(
                'vscode.openWith',
                sourceUri,
                profile.customEditorViewType
            );
        })
    );

    // Command: Open diagram in split view
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.openDiagramSplit, async (arg?: DiagramOpenTargetArg) => {
            const sourceUri = await resolveDiagramOpenTarget(arg, {
                getActiveWorkflowUri,
                openTextDocument: vscode.workspace.openTextDocument,
                workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            });
            if (!sourceUri) {
                vscode.window.showWarningMessage('Please open a .py file first, or pass a .py path/URI to the command.');
                return;
            }
            const requestedNetwork = readRequestedNetworkName(arg);
            const canOpen = profile.canOpenSource
                ? await profile.canOpenSource(sourceUri, { requestedName: requestedNetwork })
                : undefined;
            if (decideDiagramOpen(canOpen, false) === 'text-fallback') {
                await vscode.window.showTextDocument(sourceUri, {
                    preview: true,
                    preserveFocus: false,
                    viewColumn: vscode.ViewColumn.Beside
                });
                return;
            }
            // Open the source file with the network diagram editor in a split view
            if (requestedNetwork) {
                putPending(state.pendingNetworkBySourceUri, sourceUri.toString(), requestedNetwork);
            }
            await vscode.commands.executeCommand(
                'vscode.openWith',
                sourceUri,
                profile.customEditorViewType,
                vscode.ViewColumn.Beside
            );
        })
    );

    // Command: Layout diagram
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.layoutDiagram, async () => {
            // Clear existing edge routes before auto-layout so ELK can compute fresh routing.
            // This avoids persisting stale bendpoints that can create odd dog-legs after layout.
            dispatchToActiveDiagram({ kind: 'dialogram.resetEdgeRoutes' } as any);

            // Trigger a (server-side) layout run for the active diagram.
            dispatchToActiveDiagram(TriggerLayoutAction.create());
        })
    );

    // Command: Refresh active diagram model
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.refreshDiagramModel, async (args?: { sourceUri?: string; workflowName?: string }) => {
            await refreshActiveDiagramModel({ sourceUri: args?.sourceUri, workflowName: args?.workflowName });
        })
    );

    // Command: Rename entity/symbol by name (chat-friendly command surface)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            profile.commands.renameEntityByName,
            async (args?: { oldName?: string; newName?: string; sourceUri?: string }) => {
                const sourceUri = args?.sourceUri ? vscode.Uri.parse(args.sourceUri) : getActiveWorkflowUri();
                if (!sourceUri || !sourceUri.fsPath.endsWith('.py')) {
                    const message = 'No active .py source found. Focus a workflow diagram or .py editor and try again.';
                    void vscode.window.showWarningMessage(message);
                    return { ok: false, message };
                }

                const document = await vscode.workspace.openTextDocument(sourceUri);

                const providedOldName = typeof args?.oldName === 'string' ? args.oldName.trim() : '';
                const oldName = providedOldName || (await vscode.window.showInputBox({
                    title: 'Rename Entity',
                    prompt: 'Current entity/symbol name',
                    ignoreFocusOut: true
                }))?.trim() || '';
                if (!oldName) {
                    return { ok: false, message: 'Rename canceled: missing current name.' };
                }

                const providedNewName = typeof args?.newName === 'string' ? args.newName.trim() : '';
                const newName = providedNewName || (await vscode.window.showInputBox({
                    title: 'Rename Entity',
                    prompt: `New name for ${oldName}`,
                    ignoreFocusOut: true,
                    validateInput: (value) => {
                        const v = value.trim();
                        if (!v) {
                            return 'Name is required.';
                        }
                        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) {
                            return 'Name must be a valid identifier.';
                        }
                        return undefined;
                    }
                }))?.trim() || '';
                if (!newName) {
                    return { ok: false, message: 'Rename canceled: missing new name.' };
                }

                if (oldName === newName) {
                    return { ok: false, message: 'Rename skipped: names are identical.' };
                }

                const edit = await resolveRenameEdit(document, oldName, newName);
                if (!edit) {
                    const message = `Could not find a renameable symbol named '${oldName}' in ${path.basename(sourceUri.fsPath)}.`;
                    void vscode.window.showWarningMessage(message);
                    return { ok: false, message };
                }

                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    const message = 'Rename failed while applying workspace edits.';
                    void vscode.window.showErrorMessage(message);
                    return { ok: false, message };
                }

                await refreshActiveDiagramModel({ sourceUri: sourceUri.toString() });
                const message = `Renamed '${oldName}' to '${newName}'.`;
                return { ok: true, message };
            }
        )
    );

    // Command: Undo / Redo (server-side command stack)
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.undo, async () => {
            connector.dispatchAction(UndoAction.create());
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.redo, async () => {
            connector.dispatchAction(RedoAction.create());
        })
    );

    // Command: Fit diagram to viewport
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.fitToScreen, async () => {
            dispatchToActiveDiagram(FitToScreenAction.create([], {
                animate: true
            }));
        })
    );

    // Command: Center diagram
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.center, async () => {
            dispatchToActiveDiagram(CenterAction.create([], {
                animate: true
            }));
        })
    );

    // Command: Export diagram as SVG
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.exportSvg, async () => {
            connector.dispatchAction(RequestExportSvgAction.create());
        })
    );

    // Command: Toggle grid background (client-side CSS class) for manual layout polish.
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.toggleGrid, async () => {
            const current = context.globalState.get<boolean>(gridStateKey, false);
            const next = !current;
            await context.globalState.update(gridStateKey, next);

            const action = { kind: SHOW_GRID_ACTION_KIND, show: next } as any;

            // Prefer dispatching to the diagram client associated with the active Workflow diagram tab.
            // This avoids relying on the webview being the active panel at dispatch time.
            const provider = editorProvider;
            const uri = getActiveWorkflowDiagramUri();
            const clientId = uri ? provider?.getClientIdForDocumentUri(uri) : undefined;

            if (process.env.GLSP_DEBUG === 'true') {
                // eslint-disable-next-line no-console
                console.log('[cal][grid] toggle', { next, uri: uri?.toString(), clientId });
            }

            if (!clientId) {
                vscode.window.showWarningMessage('No active Workflow diagram found. Focus an open diagram tab and try again.');
                // Fallback: dispatch to active client (requires webview focus).
                connector.dispatchAction(action);
                return;
            }

            // Send directly to the client to avoid clientActions gating (showGrid is client-only).
            const message: ActionMessage = { clientId, action };
            (connector as any).sendMessageToClient(clientId, message);
        })
    );

    // Command: toggle queue overlay visibility and refresh active diagram model.
    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.setQueueTraceVisible, async (args?: { visible?: boolean; sourceUri?: string; workflowName?: string }) => {
            const current = getQueueTraceVisible();
            const next = typeof args?.visible === 'boolean' ? args.visible : !current;
            await context.globalState.update(queueTraceVisibleStateKey(profile), next);
            // Overlay-only change (edge visibility): rebuild off the cached graph without a CLI
            // re-acquire or bounds round-trip.
            await refreshActiveDiagramModel({ sourceUri: args?.sourceUri, workflowName: args?.workflowName, agentContextOnly: true });
            return true;
        })
    );

    // Run driver: the CLI run/stop commands, the 400ms live-overlay polling, the
    // read-only SSE agent stream, and the per-entity agent-tool override state
    // are a profile-supplied capability (the toolkit's CliRunDriver for
    // external-tool-backed profiles). Core owns only the neutral host seams the driver
    // needs: the diagram refresh dispatch, the execution-overlay sink, the run
    // output channel, and the live-overlay signature hookup. Absent runDriver
    // (read-only profiles) => no run commands and no driver-fed glow.
    if (profile.runDriver) {
        const runOutput = vscode.window.createOutputChannel(`${profile.chat?.fullName ?? profile.displayName} Run`);
        context.subscriptions.push(runOutput);

        // The driver never holds the connector. It calls this with a source URI +
        // refresh kind + the run's networkName; core builds the EXACT
        // RequestModelAction the in-core run machinery did — request-id prefixes
        // `refresh-during-run-*` / `refresh-agent-ctx-*` preserved (diagram-server's
        // WorkflowRequestModelActionHandler matches on them).
        const requestRunRefresh = (sourceUriStr: string, kind: 'full' | 'agentContextOnly', networkName?: string): void => {
            const uri = vscode.Uri.parse(sourceUriStr);
            const clientId = editorProvider.getClientIdForDocumentUri(uri);
            if (!clientId) {
                runOutput.appendLine(`[wf-lang live] SKIP ${kind === 'agentContextOnly' ? 'agent-ctx' : 'full'} refresh: provider=true clientId=undefined`);
                return;
            }
            const refreshAction = RequestModelAction.create({
                requestId: (kind === 'agentContextOnly' ? 'refresh-agent-ctx-' : 'refresh-during-run-') + Date.now(),
                options: {
                    sourceUri: uri.toString(),
                    diagramType: WORKFLOW_DIAGRAM_TYPE,
                    ...(kind === 'agentContextOnly' ? { agentContextOnly: true } : {}),
                    queueTraceVisible: getQueueTraceVisible(),
                    ...(networkName ? { networkName } : {})
                }
            });
            runOutput.appendLine(`[wf-lang live] dispatching ${kind === 'agentContextOnly' ? 'agent-ctx-only refresh' : 'full refresh'}`);
            connector.dispatchAction(refreshAction, clientId);
        };

        // Live-execution glow: the driver publishes each watched diagram's overlay
        // signature; the provider refreshes on change. Always-on (independent of a
        // driver-managed run) so externally-started runs still glow. The driver
        // registers its source through the host so core does not hold the driver.
        const host: DiagramRunHost = {
            overlay: executionOverlay,
            requestRefresh: requestRunRefresh,
            output: runOutput,
            useLiveOverlaySignatureSource: (source) => {
                editorProvider.setLiveOverlaySignatureSource(source);
                context.subscriptions.push({ dispose: () => editorProvider.setLiveOverlaySignatureSource(undefined) });
            }
        };

        context.subscriptions.push(profile.runDriver(context, host));
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(profile.commands.layoutDiagramIfNeeded, async (sourceUriStr?: string) => {
            const sourceUri = sourceUriStr ? vscode.Uri.parse(sourceUriStr) : getActiveWorkflowDiagramUri();
            if (!sourceUri) {
                return false;
            }
            const provider = editorProvider;
            const clientId = provider?.getClientIdForDocumentUri(sourceUri);
            if (!provider || !clientId) {
                return false;
            }
            connector.dispatchAction(TriggerLayoutAction.create(), clientId);
            return true;
        })
    );
}

