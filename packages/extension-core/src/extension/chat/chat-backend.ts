/**
 * Chat backend (extension-host), shared across runtime profiles.
 *
 * Manages the ACP client, sessions, intent resolver, MCP authoring tools and the
 * message routing between the diagram webview and opencode. Everything that used
 * to be runtime-specific (the edit command, operation prefix, MCP server) is now
 * derived from the passed-in {@link DiagramProfile} (its `chat`/`editBackend`
 * carry-overs) + the extension context, so each extension just constructs a
 * `ChatBackend` and calls `initialize()`.
 *
 * VS Code command / sidebar registration intentionally lives in the per-extension
 * wrapper (not here) to avoid duplicate-command-id collisions when multiple runtime
 * extensions are installed together.
 */

import * as vscode from 'vscode';
import { MessageParticipant, NotificationType } from 'vscode-messenger-common';
import { ACPClientService } from '../acp-client.js';
import { SessionManager } from '../session-manager.js';
import { ChatBoxIntentResolver } from '../chatbox-intent-resolver.js';
import { OperationDispatcher } from '../operation-dispatcher.js';
import type { DiagramEditBackend } from '@dialogram/shared';
import type { DiagramProfile } from '../../api.js';
import type { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import type { WorkflowEditorProvider } from '../diagram/diagram-editor-provider.js';
import { handleWebviewChatMessage, setupACPEventForwarding } from './chatbox-webview-handler.js';
import { LEGACY_KEYS, getChatSetting, readStateWithFallback } from '../legacy-settings-compat.js';

/**
 * Chat travels over the GLSP `vscode-messenger` channel (the diagram webview's
 * raw postMessage is owned by GLSP and does not reach a plain
 * `webview.onDidReceiveMessage`). These method names MUST match the constants
 * in `diagram-client/src/chat-panel-integrated.ts`.
 */
interface ChatEnvelope {
    type: string;
    data: any;
}
const ChatToHost: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toHost' };
const ChatToClient: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toClient' };

const PREFERRED_MODEL_KEY = LEGACY_KEYS.preferredModel.current;

/**
 * Callbacks the chat backend uses to reach the GLSP side, without depending on
 * it directly. Wired by the caller (currently `profile-runtime.ts`) from the
 * `GlspIntegrationHandle` returned by `activateGlspIntegration`.
 */
export interface ChatBackendDeps {
    getConnector(): GlspVscodeConnector | undefined;
    getEditorProvider(): WorkflowEditorProvider | undefined;
    /**
     * The edit/graph/capability transport for the diagram chat. Core owns the
     * revision cache, conflict-refresh and auto-layout; this backend owns how a
     * named edit reaches the source file (the edit backend today). Built in the adapter
     * layer (`profile-runtime.ts`) from the runtime profile.
     */
    editBackend: DiagramEditBackend;
}

export class ChatBackend {
    private chatMessengerWired = false;

    /**
     * The vscode.Webview-shaped reply sink installed by {@link wireChatMessenger}.
     * Kept so ACP event forwarding can be (re)attached to it once the ACP client
     * exists — the transport is wired before the (slow) ACP spawn, so forwarding
     * cannot be set up in the same step.
     */
    private replySink: vscode.Webview | undefined;

    /**
     * Disposer for the currently-attached ACP event forwarding, so re-attaching
     * (after the ACP client is created) does not accumulate listeners on the
     * singleton ACP client. Undefined when nothing is attached.
     */
    private acpForwardingDisposer: (() => void) | undefined;

    private acpClient: ACPClientService | undefined;
    private sessionManager: SessionManager | undefined;
    private intentResolver: ChatBoxIntentResolver | undefined;
    private operationDispatcher: OperationDispatcher | undefined;
    private initError: string | undefined;

    private outputChannel: vscode.OutputChannel | undefined;
    private readonly channelName: string;

    private autoLayoutTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Last source `revision` the chat saw per workflow file, used for the opt-in
     * optimistic-concurrency check (`dialogram.chat.checkSourceRevision`). Updated from
     * every successful edit-backend mutation; passed back as `expectedRevision` so the edit backend
     * rejects an edit if the file changed underneath the chat (e.g. via the text editor).
     */
    private readonly sourceRevisionCache = new Map<string, string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly profile: DiagramProfile,
        private readonly deps: ChatBackendDeps,
        private readonly assetsUri?: vscode.Uri
    ) {
        this.channelName = `${profile.chat?.fullName ?? profile.displayName} Chat`;
    }

    /**
     * The user's last explicitly-selected model, applied as the default for newly
     * created sessions so the choice carries across sessions.
     */
    getPreferredModel(): string | undefined {
        return readStateWithFallback<string | undefined>(
            this.context.workspaceState,
            LEGACY_KEYS.preferredModel.current,
            LEGACY_KEYS.preferredModel.legacy,
            undefined,
        );
    }

    setPreferredModel(model: string): void {
        void this.context.workspaceState.update(PREFERRED_MODEL_KEY, model);
    }

    /**
     * Log a line to the chat output channel (View → Output) and the extension host
     * console. Use this to trace the chat lifecycle.
     */
    log(message: string): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(this.channelName);
        }
        const ts = new Date().toISOString().slice(11, 23);
        this.outputChannel.appendLine(`[${ts}] ${message}`);
        // eslint-disable-next-line no-console
        console.log(`[ChatBox] ${message}`);
    }

    /** Reveal the chat log channel (used by the diagnose command). */
    showLog(): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(this.channelName);
        }
        this.outputChannel.show(true);
    }

    /**
     * Initialize the chat backend for the given runtime profile. Idempotent guard:
     * starts the ACP client, session manager, intent resolver, MCP provider and the
     * messenger transport. Does NOT register VS Code commands (see module note).
     */
    async initialize(): Promise<void> {
        this.log(`initializeChatBox() called (profile=${this.profile.key})`);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this.initError = 'No workspace folder open (open a folder, not just a file)';
            this.log(`SKIP: ${this.initError}`);
            return;
        }
        this.log(`workspace root: ${workspaceRoot}`);

        try {
            this.initError = undefined;

            // Wire the chat transport FIRST — before the slow opencode spawn below.
            // A session-restored (or fast fresh) webview posts `chat.ready` inside
            // the spawn window; if the messenger isn't listening yet the host drops
            // it ("unknown method: dialogram/chat/toHost") and the panel times out on
            // "disconnected". The messenger only needs the GLSP connector, which the
            // profile runtime activates before constructing this backend. At this
            // point `getACPClient()` is undefined, so the early handshake correctly
            // reports connected:false; forwarding is (re)attached once ACP exists.
            this.wireChatMessenger();

            // Initialize ACP client
            this.acpClient = new ACPClientService();

            // Surface ACP lifecycle in the log channel.
            this.acpClient.on('connected', () => this.log('ACP: connected'));
            this.acpClient.on('disconnected', () => this.log('ACP: disconnected'));
            this.acpClient.on('error', (err) => this.log(`ACP error: ${err?.message ?? err}`));

            this.log('spawning opencode acp subprocess…');
            await this.acpClient.start(workspaceRoot);
            this.log(`ACP started; connected=${this.acpClient.isClientConnected()}`);

            // Warm up the model catalog in the background so the model selector is
            // populated by the time the diagram opens (opencode only exposes models
            // through a session, so without this the dropdown is empty until the
            // first message creates one).
            void this.acpClient
                .warmUpModelCatalog()
                .then(() => this.log('model catalog warmed up'))
                .catch(() => undefined);

            // Inject the runtime's domain "skill" (vocabulary + idiomatic component
            // template) into each session so the agent authors the right thing.
            this.acpClient.setChatSkill(this.profile.chat?.skill);
            this.acpClient.setSourceMimeType(this.profile.chat?.sourceMimeType);

            // Provide the resolved workflow graph for session context injection so
            // the agent understands the diagram's structure without searching.
            this.acpClient.setWorkflowGraphProvider(async (workflowFile) => {
                try {
                    const uri = vscode.Uri.file(workflowFile).toString();
                    // Warm + log the backend's declared capabilities (cached per binary).
                    void this.deps.editBackend.listCapabilities(uri).then((caps) => {
                        if (caps) {
                            this.log(
                                `backend capabilities (v${caps.protocolVersion}): ${caps.ops?.length ?? 0} ops; ` +
                                    `features=${JSON.stringify(caps.features)}`
                            );
                        } else {
                            this.log('backend capabilities: unavailable (pre-v2 backend) — gating disabled');
                        }
                    });
                    const graph = await this.deps.editBackend.exportGraph(uri);
                    if (graph) {
                        this.log(`workflow graph exported for context (${workflowFile})`);
                        return graph;
                    }
                    return undefined;
                } catch {
                    return undefined;
                }
            });

            // Attach the runtime's MCP server to each new session so the agent gets
            // first-class workflow tools (list/create task types, get graph, connect,
            // …) — the proper path for authoring brand-new tasks. The backend owns the
            // spawn descriptor (command/args/env) and the kill-switch; core only
            // supplies the per-file scope (network) + assets path and adapts the env
            // to the ACP `{ name, value }[]` shape.
            this.acpClient.setMcpServersProvider((workflowFile) => {
                if (!workflowFile) return [];
                const uri = vscode.Uri.file(workflowFile);
                const networkName = this.deps.getEditorProvider()?.getRefreshContext(uri)?.networkName ?? undefined;
                const assetsPath = (this.assetsUri ?? this.context.extensionUri).fsPath;
                const descriptors = this.deps.editBackend.mcpServers(uri.toString(), { networkName, assetsPath });
                if (descriptors.length) {
                    this.log(`attaching ${this.profile.key} MCP server for ${workflowFile}`);
                }
                return descriptors.map((descriptor) => ({
                    name: descriptor.name,
                    command: descriptor.command,
                    args: descriptor.args,
                    env: Object.entries(descriptor.env).map(([name, value]) => ({ name, value })),
                }));
            });

            // Initialize operation dispatcher and wire its mutating ops to the real
            // edit backend (the built-in handlers are stubs).
            this.operationDispatcher = new OperationDispatcher();
            this.wireEditBackendOperations(this.operationDispatcher);

            // Initialize session manager
            const workspaceStorage = {
                get: <T>(key: string, defaultValue: T): T => {
                    return this.context.workspaceState.get(key, defaultValue);
                },
                update: async (key: string, value: any): Promise<void> => {
                    await this.context.workspaceState.update(key, value);
                },
            };

            this.sessionManager = new SessionManager(this.acpClient, workspaceStorage);
            await this.sessionManager.initialize();

            // Persist each completed assistant reply to its session.
            this.acpClient.on('turnComplete', ({ sessionId, text, thinking, model }) => {
                if (text && this.sessionManager) {
                    this.sessionManager.addMessageToSession(sessionId, {
                        role: 'assistant',
                        content: text,
                        timestamp: Date.now(),
                        provider: model,
                        ...(thinking ? { thinking } : {}),
                    });
                }
            });

            const diagramContext = {
                getSelectedNodes: () => [],
                getCurrentWorkflowFile: () => vscode.window.activeTextEditor?.document.uri.fsPath || '',
            };

            this.intentResolver = new ChatBoxIntentResolver(
                this.acpClient,
                this.sessionManager,
                this.operationDispatcher,
                diagramContext,
                this.profile.chat
            );

            // ACP client now exists and is connected: (re)attach event forwarding
            // so the 'connected' event (and streamed updates) reach the panel. The
            // early wire above attached a no-op forwarder because ACP didn't exist
            // yet; this call replaces it (idempotent — the previous disposer runs).
            this.attachAcpForwarding();

            this.log('Initialized successfully');

            // Cleanup on deactivation
            this.context.subscriptions.push({
                dispose: () => {
                    if (this.acpClient) {
                        this.acpClient.stop();
                        this.acpClient = undefined;
                    }
                    this.dispose();
                },
            });
        } catch (error) {
            this.initError = error instanceof Error ? error.message : String(error);
            this.acpClient = undefined;
            this.log(`Failed to initialize: ${this.initError}`);
            if (error instanceof Error && error.stack) this.log(error.stack);
            vscode.window.showErrorMessage(
                `Chat box initialization failed: ${this.initError} — run the chat diagnose command for details`
            );
        }
    }

    /**
     * Release backend-owned resources that are not themselves VS Code disposables:
     * the auto-layout debounce timer and the output channel. Invoked from the
     * `context.subscriptions` disposer registered in {@link initialize}.
     */
    dispose(): void {
        if (this.acpForwardingDisposer) {
            this.acpForwardingDisposer();
            this.acpForwardingDisposer = undefined;
        }
        if (this.autoLayoutTimer) {
            clearTimeout(this.autoLayoutTimer);
            this.autoLayoutTimer = undefined;
        }
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = undefined;
        }
    }

    /**
     * Run an interactive self-test and write results to the log channel. Surfaces
     * exactly where the chat backend is failing.
     */
    async runDiagnostics(): Promise<void> {
        this.showLog();
        this.log('──────── DIAGNOSTICS ────────');
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.log(`workspace folder: ${workspaceRoot ?? '(none — open a folder)'}`);
        this.log(`PATH: ${process.env.PATH ?? '(unset)'}`);
        this.log(`acpClient exists: ${!!this.acpClient}`);
        this.log(`acpClient connected: ${this.acpClient?.isClientConnected() ?? false}`);
        this.log(`initError: ${this.initError ?? '(none)'}`);

        if (!this.acpClient) {
            this.log('No ACP client. Attempting a fresh start…');
            if (!workspaceRoot) {
                this.log('Cannot start: no workspace folder open.');
                return;
            }
            try {
                const client = new ACPClientService();
                client.on('error', (e) => this.log(`ACP error: ${e?.message ?? e}`));
                await client.start(workspaceRoot);
                this.acpClient = client;
                this.initError = undefined;
                this.log(`Fresh start OK; connected=${client.isClientConnected()}`);
            } catch (e) {
                this.log(`Fresh start FAILED: ${e instanceof Error ? e.message : String(e)}`);
                return;
            }
        }

        try {
            this.log('Creating a throwaway probe session…');
            const sessionId = await this.acpClient.createSession(workspaceRoot!, 'diagnostic-probe', 'build');
            this.log(`Session created: ${sessionId}`);
            const models = await this.acpClient.listProviders();
            this.log(`Models available: ${models.length}` + (models.length ? ` (e.g. ${models.slice(0, 3).map((m: any) => m.id).join(', ')})` : ''));
            this.log('✅ Backend is functional. If the panel still shows "Connecting", the webview↔extension messages are not reaching it.');
        } catch (e) {
            this.log(`Probe FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Wire the chat protocol onto the GLSP connector's vscode-messenger channel.
     *
     * Inbound webview notifications are routed to the chat handler; replies are sent
     * back to the diagram webview that last spoke to us. A "reply sink" that mimics
     * vscode.Webview is passed so the handlers (which call `webview.postMessage(...)`)
     * work unchanged.
     */
    private wireChatMessenger(attempt = 0): void {
        if (this.chatMessengerWired) return;

        const connector = this.deps.getConnector();
        if (!connector) {
            if (attempt < 20) {
                // The GLSP connector may not be registered yet; retry briefly.
                setTimeout(() => this.wireChatMessenger(attempt + 1), 250);
                return;
            }
            this.log('WARNING: GLSP connector not available; chat messenger not wired');
            return;
        }

        const messenger = connector.messenger;

        // Reply target: the diagram webview that last spoke to us.
        let chatTarget: MessageParticipant | undefined;

        const replySink = {
            postMessage: (msg: any) => {
                if (chatTarget) {
                    messenger.sendNotification(ChatToClient, chatTarget, { type: msg?.type, data: msg?.data });
                }
                return Promise.resolve(true);
            },
        } as unknown as vscode.Webview;

        messenger.onNotification(ChatToHost, (env, sender) => {
            chatTarget = sender;
            void handleWebviewChatMessage(this, replySink, env);
        });

        // Keep the sink so ACP event forwarding can (re)attach to it once the ACP
        // client exists (the transport is wired before the slow ACP spawn).
        this.replySink = replySink;

        // Attach ACP event forwarding now. At early-wire time the ACP client does
        // not exist yet, so this installs a one-shot disconnected post; it is
        // re-attached from initialize() via attachAcpForwarding() after ACP starts.
        this.attachAcpForwarding();

        this.chatMessengerWired = true;
        this.log('chat messenger wired to GLSP connector (vscode-messenger transport)');
    }

    /**
     * (Re)attach ACP event forwarding (status, streamed updates) onto the reply
     * sink installed by {@link wireChatMessenger}. Idempotent: it disposes any
     * previously-attached forwarding first, so it can be called both before the
     * ACP client exists (installs the disconnected placeholder) and again after
     * the ACP client is created (installs the live listeners that carry the
     * 'connected' event to the panel) without accumulating listeners on the
     * singleton ACP client. No-op until the reply sink exists.
     */
    private attachAcpForwarding(): void {
        if (!this.replySink) return;
        if (this.acpForwardingDisposer) {
            this.acpForwardingDisposer();
            this.acpForwardingDisposer = undefined;
        }
        this.acpForwardingDisposer = setupACPEventForwarding(this, this.replySink);
    }

    /**
     * Resolve the workflow file the chat operates on (current session, then active
     * editor/diagram tab).
     */
    private resolveChatWorkflowFile(): string | undefined {
        const fromSession = this.sessionManager?.getCurrentSession?.()?.workflowFile;
        if (fromSession) return fromSession;
        const fromEditor = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (fromEditor) return fromEditor;
        const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
        return input?.uri?.fsPath;
    }

    /**
     * Optionally re-layout the diagram after an agent structural edit (create/connect/…).
     *
     * Opt-in via `dialogram.chat.autoLayoutAfterEdits` (default off). When enabled, a single
     * debounced full layout runs after a burst of edits — useful when the agent builds a
     * diagram from a prompt. It is OFF by default because a full layout re-arranges the whole
     * diagram (it would disturb a hand-arranged one); the diagram server already places new
     * nodes incrementally on refresh without that side effect. The short delay lets the
     * `refreshModelFromDisk` reload settle before laying out.
     */
    private scheduleAutoLayout(uri: vscode.Uri): void {
        const enabled = getChatSetting<boolean>('autoLayoutAfterEdits', false);
        if (!enabled) return;
        if (this.autoLayoutTimer) clearTimeout(this.autoLayoutTimer);
        this.autoLayoutTimer = setTimeout(() => {
            this.autoLayoutTimer = undefined;
            void vscode.commands.executeCommand(this.profile.commands.layoutDiagramIfNeeded, uri.toString());
            this.log('auto-layout triggered after agent edits');
        }, 400);
    }

    /**
     * Replace the OperationDispatcher's stub handlers for mutating ops with real
     * edit-backend invocations, refreshing the diagram on success. Operation names are
     * profile-prefixed (`<prefix>.createNode`, …). Edit-backend errors surface to the
     * chat instead of silently "succeeding".
     */
    private wireEditBackendOperations(dispatcher: OperationDispatcher): void {
        const run = async (
            opName: string,
            buildArgs: (p: any, uri: vscode.Uri, network?: string) => Record<string, unknown>,
            params: any
        ) => {
            const file = this.resolveChatWorkflowFile();
            if (!file) {
                return { success: false, error: 'No active workflow — open a workflow diagram first.' };
            }
            const uri = vscode.Uri.file(file);
            // Capability gating: don't pretend an op works on a runtime that doesn't
            // implement it. The backend defaults to allowed when capabilities are
            // unknown (pre-v2 backend), so this is never more restrictive than before.
            if (!(await this.deps.editBackend.supportsOp(uri.toString(), opName))) {
                return {
                    success: false,
                    error: `'${opName}' isn't supported by the ${this.profile.displayName} runtime.`,
                };
            }
            const network = this.deps.getEditorProvider()?.getRefreshContext(uri)?.networkName;
            const builtArgs = buildArgs(params, uri, network);
            // Optimistic concurrency (opt-in): pass the revision the chat last saw for this
            // file so the backend rejects the edit if the file changed underneath us.
            const enforceRevision = getChatSetting<boolean>('checkSourceRevision', false);
            const knownRevision = this.sourceRevisionCache.get(file);
            const expectedRevision = enforceRevision && knownRevision ? knownRevision : undefined;
            const result = await this.deps.editBackend.applyNamedEdit(uri.toString(), opName, builtArgs, {
                expectedRevision,
            });
            if (!result.ok) {
                if (result.conflict) {
                    // The file changed since we last read it — reload and let the agent retry
                    // against fresh state.
                    this.deps.getEditorProvider()?.refreshModelFromDisk(uri);
                    this.sourceRevisionCache.set(file, String(result.conflict.actualRevision ?? ''));
                    this.log(`concurrent modification on ${file}; reloaded for retry`);
                    return {
                        success: false,
                        error: 'The workflow file changed since the chat last read it — the diagram was reloaded. Please retry.',
                    };
                }
                return { success: false, error: result.message ?? `The edit backend rejected ${opName}` };
            }
            // Remember the post-edit revision so the next edit can detect drift.
            if (result.revision) {
                this.sourceRevisionCache.set(file, String(result.revision));
            }
            // Reflect the source mutation in the open diagram.
            this.deps.getEditorProvider()?.refreshModelFromDisk(uri);
            this.scheduleAutoLayout(uri);
            return { success: true };
        };

        const withNetwork = (uri: vscode.Uri, extra: Record<string, unknown>, network?: string) => ({
            ...this.deps.editBackend.scopeArgs(uri.toString(), network),
            ...extra,
        });

        const prefix = this.profile.chat?.operationPrefix ?? '';
        dispatcher.register(`${prefix}.createNode`, (p) =>
            run('createNode', (params, uri, network) =>
                withNetwork(uri, { type: params.type ?? params.node_type, name: params.name, params: params.params ?? {} }, network), p)
        );
        dispatcher.register(`${prefix}.connect`, (p) =>
            run('connect', (params, uri, network) => withNetwork(uri, { source: params.source, target: params.target }, network), p)
        );
        dispatcher.register(`${prefix}.deleteNode`, (p) =>
            run('deleteNode', (params, uri, network) => withNetwork(uri, { name: params.name ?? params.nodeId }, network), p)
        );
        dispatcher.register(`${prefix}.renameNode`, (p) =>
            run('renameNode', (params, uri, network) => withNetwork(uri, { oldName: params.oldName, newName: params.newName }, network), p)
        );
        dispatcher.register(`${prefix}.updateNodeParameter`, (p) =>
            run('updateNodeParameter', (params, uri, network) => withNetwork(uri, { name: params.name, params: params.params ?? params }, network), p)
        );

        // `/layout` is a real diagram operation (not an edit-backend mutation): run the
        // profile's layout command so it actually re-lays-out the open diagram.
        dispatcher.register('layout', async () => {
            try {
                await vscode.commands.executeCommand(this.profile.commands.layoutDiagram);
                return { success: true };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        });
    }

    /** Current chat backend connection state, for the webview status indicator. */
    getStatus(): { connected: boolean; reason?: string } {
        if (this.acpClient?.isClientConnected()) {
            return { connected: true };
        }
        return {
            connected: false,
            reason: this.initError ?? (this.acpClient ? 'opencode not connected' : 'Chat backend not initialized'),
        };
    }

    /** Get ACP client instance */
    getACPClient(): ACPClientService | undefined {
        return this.acpClient;
    }

    /** Get session manager instance */
    getSessionManager(): SessionManager | undefined {
        return this.sessionManager;
    }

    /** Get intent resolver instance */
    getIntentResolver(): ChatBoxIntentResolver | undefined {
        return this.intentResolver;
    }

    /** The runtime profile the chat backend was initialized for. */
    getProfile(): DiagramProfile {
        return this.profile;
    }
}
