/**
 * The unified chat runtime: bridges the ACP/opencode client to a consumer-owned
 * webview chat panel over a postMessage-style transport, without requiring the
 * GLSP diagram platform. This is the single runtime behind both
 * `DialogramApi.activateChatProfile` (the mlir-viewer path) and the diagram
 * profile's chat (the former legacy ChatBackend), driven entirely by a
 * {@link ChatRuntimeConfig}.
 *
 * Messages arrive as `{ type, data }` payloads (the consumer forwards them
 * with the owning document URI) and replies go back through the consumer's
 * `postToWebview(uri, payload)` sink. Sessions are per-file. MCP tools are
 * served in-process over loopback HTTP (see McpHttpServer) and/or as
 * config-supplied stdio servers, reading live host-side state through the
 * config's tool handlers.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ACPClientService } from '../acp-client.js';
import { SessionManager } from '../session-manager.js';
import type { ChatMessageSink, ChatPayload, InProcessChatTool } from '../../api';
import { SlashCommandRegistry, type ChatCommandContribution } from './slash-commands';
import { attachAcpEventForwarding } from './acp-event-forwarding';
import type { StdioMcpDescriptor } from './edit-capability';
import { LEGACY_KEYS, readStateWithFallback } from '../legacy-settings-compat';

/**
 * Everything project-specific the unified chat runtime needs. Both the chat-only
 * (mlir) profile and the diagram profile's chat contribution are expressed as
 * this data — the runtime carries no product/tool vocabulary of its own.
 */
export interface ChatRuntimeConfig {
    /** Short unique key, e.g. 'mlir' — names the MCP server and log scope. */
    key: string;
    /** Human-readable name, used for the output channel ("<name> Chat"). */
    displayName: string;
    /** Settings section read for `opencodePath` and `enableMcpTools`. */
    settingsSection: string;
    /** Domain primer injected into each session's context. */
    skill?: string;
    /** MIME type of the edited source, forwarded to the agent for context. */
    sourceMimeType?: string;
    /** Compact graph/structure rendering, injected with the file (mtime-deduped). */
    graphContextProvider?: (file: string) => Promise<string | undefined> | string | undefined;
    /** Extra ACP content blocks injected on EVERY turn (receives the selection). */
    turnContextProvider?: (file: string, selectedNodeIds: string[]) => Promise<any[]> | any[];
    /**
     * Per-turn selection injection. Enabled by default (`false` disables it);
     * pass an object with `render` to customize the injected text.
     */
    selectionContext?: false | { render?: (file: string, selectedNodeIds: string[]) => string };
    /** In-process MCP tools served over loopback HTTP. */
    tools?: InProcessChatTool[];
    /** stdio MCP servers (arrive pre-gated from the edit backend). */
    stdioMcpServers?: (file: string) => StdioMcpDescriptor[];
    /** Slash commands contributed to the registry (with optional handlers). */
    slashCommands?: ChatCommandContribution[];
    /** Runs after a free-text turn (e.g. diagram VIEW ops the prompt asked for). */
    postTurnHook?: (file: string, text: string) => Promise<void>;
}

export class ChatRuntime {
    private readonly acp = new ACPClientService();
    private readonly sessions: SessionManager;
    private readonly registry: SlashCommandRegistry;
    private context: vscode.ExtensionContext;
    private started = false;
    private startPromise: Promise<void> | undefined;
    /** In-process HTTP MCP server (started lazily when the tools are enabled). */
    private mcpHttp: import('./mcp-http-server.js').McpHttpServer | undefined;
    /** sessionId -> the webview URI (string) that owns it, for routing ACP events. */
    private readonly sessionUri = new Map<string, string>();
    /** Every URI whose chat panel is live, so connection events reach panels that
     *  have no session yet. */
    private readonly activeUris = new Set<string>();
    /** Mode/model the user picked before any session existed; applied on create. */
    private pendingMode: 'plan' | 'build' | undefined;
    private pendingModel: string | undefined;
    /** Latest diagram selection (node ids) per file, fed to the turn context. */
    private readonly selectionByFile = new Map<string, string[]>();
    private readonly output: vscode.OutputChannel;
    /** Tears down the ACP -> webview event forwarding registered in the ctor. */
    private readonly acpForwardingDisposer: () => void;
    /** Pending stuck-connection watchdog (armed on the panel handshake). */
    private connectWatchdog: ReturnType<typeof setTimeout> | undefined;
    /** The watchdog dialog fires at most once per runtime — no per-diagram nagging. */
    private connectWarned = false;

    constructor(
        context: vscode.ExtensionContext,
        private readonly config: ChatRuntimeConfig,
        private readonly postToWebview: ChatMessageSink
    ) {
        this.context = context;
        this.registry = new SlashCommandRegistry(config.slashCommands ?? []);
        this.sessions = new SessionManager(this.acp, context.workspaceState);
        // Restore persisted sessions so the picker is populated across reloads.
        void this.sessions.initialize();

        if (config.skill) {
            this.acp.setChatSkill(config.skill);
        }
        if (config.sourceMimeType) {
            this.acp.setSourceMimeType(config.sourceMimeType);
        }
        if (config.graphContextProvider) {
            this.acp.setWorkflowGraphProvider(file => Promise.resolve(config.graphContextProvider!(file)));
        }
        this.acp.setTurnContextBlocksProvider(async file => {
            const blocks: any[] = [];
            if (file && this.config.selectionContext !== false) {
                const selected = this.selectionByFile.get(file) ?? [];
                if (selected.length > 0) {
                    const rendered = this.config.selectionContext?.render?.(file, selected);
                    blocks.push({
                        type: 'text',
                        text:
                            rendered ??
                            `The user currently has ${selected.length} node(s) selected in the diagram: ` +
                            `${selected.slice(0, 20).join(', ')}. When they say "this"/"the selected node(s)", ` +
                            'they mean these.'
                    });
                }
            }
            if (file && this.config.turnContextProvider) {
                try {
                    const extra = await this.config.turnContextProvider(file, this.selectionByFile.get(file) ?? []);
                    if (Array.isArray(extra)) blocks.push(...extra);
                } catch {
                    // Best-effort.
                }
            }
            return blocks;
        });

        this.output = vscode.window.createOutputChannel(`${config.displayName} Chat`);
        // Surface a per-profile setting for the opencode binary path; the ACP
        // client resolves it from the env var (then ~/.opencode/bin, PATH, …).
        const override = vscode.workspace
            .getConfiguration(config.settingsSection)
            .get<string>('opencodePath');
        if (override) {
            process.env.WORKFLOW_OPENCODE_PATH = override;
        }
        this.setupMcpProvider();
        this.acpForwardingDisposer = attachAcpEventForwarding(this.acp, {
            postToSession: (sessionId, payload) => this.post(sessionId, payload),
            broadcast: payload => this.broadcast(payload),
            onTurnComplete: ({ sessionId, text, thinking, model }) => {
                this.sessions.addMessageToSession(sessionId, {
                    role: 'assistant',
                    content: text ?? '',
                    timestamp: Date.now(),
                    thinking,
                    provider: model
                });
                this.post(sessionId, { type: 'chat.turnEnd', data: { sessionId } });
                // Resolve the just-sent user message's opencode id so its revert
                // affordance appears without rebuilding the timeline.
                void this.postLiveMessageIds(sessionId);
            }
        });
        // A successful connection (from any path) stands down the watchdog.
        this.acp.on('connected', () => this.clearConnectWatchdog());
    }

    // --- lifecycle ---------------------------------------------------------

    /** How long after the panel handshake before a stuck connection surfaces as a dialog. */
    private static readonly CONNECT_WATCHDOG_MS = 30_000;

    /**
     * Arm the stuck-connection watchdog. The eager connect on `chat.ready` is
     * silent by design (background errors no longer auto-open the chat drawer),
     * so a connection that never comes up would otherwise be invisible until
     * the user opens the chat. If opencode is still not connected 30 s after
     * the diagram's handshake, surface one VS Code dialog with escape hatches.
     */
    private armConnectWatchdog(): void {
        if (this.connectWarned || this.connectWatchdog || this.acp.isClientConnected()) {
            return;
        }
        this.connectWatchdog = setTimeout(() => {
            this.connectWatchdog = undefined;
            if (this.connectWarned || this.acp.isClientConnected()) {
                return;
            }
            this.connectWarned = true;
            this.output.appendLine('connect watchdog: still disconnected after 30 s — surfacing dialog');
            void vscode.window
                .showWarningMessage(
                    `${this.config.displayName} chat could not connect to opencode within 30 seconds. ` +
                        'The agent may not be installed or on PATH.',
                    'Show Log',
                    'Run Diagnostics'
                )
                .then(choice => {
                    if (choice === 'Show Log') {
                        this.showLog();
                    } else if (choice === 'Run Diagnostics') {
                        void this.runDiagnostics();
                    }
                });
        }, ChatRuntime.CONNECT_WATCHDOG_MS);
    }

    private clearConnectWatchdog(): void {
        if (this.connectWatchdog) {
            clearTimeout(this.connectWatchdog);
            this.connectWatchdog = undefined;
        }
    }

    private async ensureStarted(cwd: string): Promise<void> {
        if (this.started) return;
        if (!this.startPromise) {
            this.startPromise = this.acp
                .start(cwd)
                .then(async () => {
                    // Stand up the HTTP tool server before any session is created,
                    // so mcpServersProvider can attach it synchronously.
                    await this.ensureMcpServer();
                    this.started = true;
                })
                .catch(err => {
                    this.startPromise = undefined;
                    throw err;
                });
        }
        await this.startPromise;
    }

    private mcpEnabled(): boolean {
        return vscode.workspace
            .getConfiguration(this.config.settingsSection)
            .get<boolean>('enableMcpTools', true);
    }

    /**
     * Start the in-process HTTP MCP server (once) when tools are supplied and
     * enabled, so mcpServersProvider can hand each session its URL
     * synchronously. Failure is non-fatal: the tools are simply not attached
     * and the chat still works.
     */
    private async ensureMcpServer(): Promise<void> {
        const tools = this.config.tools ?? [];
        if (tools.length === 0 || !this.mcpEnabled() || this.mcpHttp) return;
        try {
            const { McpHttpServer } = await import('./mcp-http-server.js');
            const server = new McpHttpServer(this.config.key, tools);
            await server.start();
            this.mcpHttp = server;
        } catch (err) {
            this.output.appendLine(`MCP HTTP server failed to start: ${String(err)}`);
        }
    }

    private setupMcpProvider(): void {
        this.acp.setMcpServersProvider((file?: string) => {
            if (!file) return [];
            const servers: any[] = [];
            if (this.mcpEnabled() && this.mcpHttp) {
                servers.push({ type: 'http', name: this.config.key, url: this.mcpHttp.urlFor(file), headers: [] } as any);
            }
            for (const d of this.config.stdioMcpServers?.(file) ?? []) {
                servers.push({ name: d.name, command: d.command, args: d.args, env: d.env });
            }
            return servers;
        });
    }

    // --- ACP -> webview ----------------------------------------------------

    private post(sessionId: string, payload: ChatPayload): void {
        const uri = this.sessionUri.get(sessionId);
        if (uri) this.postToWebview(uri, payload);
    }

    private broadcast(payload: ChatPayload): void {
        const uris = new Set([...this.activeUris, ...this.sessionUri.values()]);
        for (const uri of uris) this.postToWebview(uri, payload);
    }

    // --- webview -> host ---------------------------------------------------

    /** Entry point: the consumer forwards chat payloads here with the URI. */
    async handleMessage(uri: string, payload: ChatPayload): Promise<void> {
        this.activeUris.add(uri);
        try {
            await this.route(uri, payload);
        } catch (err) {
            this.output.appendLine(`chat error: ${String(err)}`);
            this.postToWebview(uri, { type: 'chat.error', data: { message: String(err) } });
        }
    }

    /** Push the current diagram selection for a file (also settable via the
     *  `chat.selection` webview message). */
    setSelection(uri: string, selectedNodeIds: string[]): void {
        this.selectionByFile.set(this.fileFor(uri), selectedNodeIds.map(String));
    }

    /** Start opencode (once per runtime) and report the outcome to the
     *  requesting panel. Errors surface instead of a silent "Disconnected". */
    private async connectAndReport(uri: string, cwd: string): Promise<boolean> {
        // Already connected: the immediate `chat.ready` status and the ACP
        // 'connected' event already inform the panel — re-posting here would
        // double the handshake and loop the panel's status-triggered refetch.
        if (this.acp.isClientConnected()) {
            return true;
        }
        try {
            await this.ensureStarted(cwd);
            this.clearConnectWatchdog();
            this.postToWebview(uri, { type: 'chat.connectionStatus', data: { connected: true } });
            return true;
        } catch (err) {
            const message = `Could not start opencode: ${String(err)}`;
            this.output.appendLine(message);
            this.postToWebview(uri, {
                type: 'chat.connectionStatus',
                data: { connected: false, reason: String(err) }
            });
            this.postToWebview(uri, { type: 'chat.error', data: { message } });
            return false;
        }
    }

    /** Connect, warm the model catalog (needs a probe session), then send the list. */
    private async connectAndSendModels(uri: string, cwd: string): Promise<void> {
        if (!(await this.connectAndReport(uri, cwd))) return;
        await this.acp.warmUpModelCatalog().catch(() => undefined);
        await this.sendModels(uri);
    }

    private fileFor(uri: string): string {
        return vscode.Uri.parse(uri).fsPath;
    }

    private cwdFor(file: string): string {
        return (
            vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ??
            path.dirname(file)
        );
    }

    private async route(uri: string, payload: ChatPayload): Promise<void> {
        const { type, data } = payload;
        const file = this.fileFor(uri);
        const cwd = this.cwdFor(file);

        switch (type) {
            case 'chat.ready':
            case 'chat.getStatus': {
                // Post the current status immediately: the integrated panel's 5 s
                // handshake must not wait out an opencode spawn.
                this.postToWebview(uri, {
                    type: 'chat.connectionStatus',
                    data: { connected: this.acp.isClientConnected() }
                });
                this.armConnectWatchdog();
                this.sendSessions(uri, file);
                // Eagerly connect on panel open so the panel shows Connected
                // without needing a first message.
                await this.connectAndSendModels(uri, cwd);
                return;
            }
            case 'chat.log':
                this.output.appendLine(`webview: ${String(data?.message ?? '')}`);
                return;
            case 'chat.getSessions':
                this.sendSessions(uri, file);
                return;
            case 'chat.getProviders':
                // Do NOT re-report connectionStatus here: the panel re-requests
                // providers whenever it sees a connected status, so echoing one
                // per request would ping-pong forever (status → getProviders →
                // status → …) and flood the channel. Only `chat.ready` reports.
                if (this.acp.isClientConnected()) {
                    await this.sendModels(uri);
                } else {
                    await this.connectAndSendModels(uri, cwd);
                }
                return;
            case 'chat.getCommands': {
                const mode: 'plan' | 'build' = data?.mode === 'plan' ? 'plan' : 'build';
                this.postToWebview(uri, {
                    type: 'chat.commands',
                    data: { mode, commands: this.registry.listForMode(mode) }
                });
                return;
            }
            case 'chat.createSession': {
                await this.ensureStarted(cwd);
                // Collect the name via a native input box (webview prompt() is
                // blocked). Cancelling drops the panel's spinner.
                let name: string | undefined = data?.name;
                if (!name) {
                    const existing = this.sessions.getSessionsForWorkflow(file).length;
                    name = await vscode.window.showInputBox({
                        title: 'New Chat Session',
                        prompt: 'Name for the new chat session',
                        value: `Session ${existing + 1}`,
                        ignoreFocusOut: true
                    });
                    if (!name) {
                        this.postToWebview(uri, { type: 'chat.sessionCreateAborted' });
                        return;
                    }
                }
                const session = await this.sessions.createSession(
                    file,
                    name,
                    data?.mode ?? this.pendingMode ?? 'build'
                );
                this.sessionUri.set(session.id, uri);
                this.sessions.setCurrentSession(session.id);
                await this.applyPending(session.id);
                this.postToWebview(uri, { type: 'chat.sessionCreated', data: { session } });
                this.sendSessions(uri, file);
                return;
            }
            case 'chat.loadSession': {
                if (!data?.sessionId) return;
                await this.ensureStarted(cwd);
                const loaded = await this.sessions.loadSession(data.sessionId);
                if (!loaded) {
                    this.postToWebview(uri, {
                        type: 'chat.error',
                        data: {
                            message: `Could not restore session ${data.sessionId}. It may have expired — start a new chat.`
                        }
                    });
                    return;
                }
                this.sessionUri.set(data.sessionId, uri);
                this.sessions.setCurrentSession(data.sessionId);
                await this.postHistory(uri, data.sessionId, {
                    mode: this.acp.getSessionMode(data.sessionId) ?? loaded.mode,
                    model: this.acp.getSessionModel(data.sessionId) ?? loaded.provider
                });
                return;
            }
            case 'chat.revert': {
                if (!data?.sessionId || !data?.messageId) return;
                await this.acp.revertToMessage(data.sessionId, data.messageId);
                await this.postHistory(uri, data.sessionId);
                return;
            }
            case 'chat.unrevert': {
                if (!data?.sessionId) return;
                await this.acp.unrevert(data.sessionId);
                await this.postHistory(uri, data.sessionId);
                return;
            }
            case 'chat.deleteSession': {
                if (!data?.sessionId) return;
                const target = this.sessions.getSession(data.sessionId);
                const label = target?.name ?? data.sessionId;
                const choice = await vscode.window.showWarningMessage(
                    `Delete chat session "${label}"? This cannot be undone.`,
                    { modal: true },
                    'Delete'
                );
                if (choice !== 'Delete') return;
                // Pick the next session to fall back to (most-recent sibling).
                const siblings = this.sessions
                    .getSessionsForWorkflow(file)
                    .filter(s => s.id !== data.sessionId);
                const nextSessionId = siblings[0]?.id;
                await this.sessions.deleteSession(data.sessionId);
                this.sessionUri.delete(data.sessionId);
                if (nextSessionId) this.sessions.setCurrentSession(nextSessionId);
                this.postToWebview(uri, {
                    type: 'chat.sessionDeleted',
                    data: { sessionId: data.sessionId, nextSessionId }
                });
                this.sendSessions(uri, file);
                return;
            }
            case 'chat.renameSession': {
                if (!data?.sessionId) return;
                let name: string | undefined = data.name;
                if (!name) {
                    const current = this.sessions.getSession(data.sessionId);
                    name = await vscode.window.showInputBox({
                        title: 'Rename Chat Session',
                        prompt: 'New name for the chat session',
                        value: current?.name ?? '',
                        ignoreFocusOut: true
                    });
                    if (!name) return;
                }
                await this.sessions.renameSession(data.sessionId, name);
                this.postToWebview(uri, {
                    type: 'chat.sessionRenamed',
                    data: { sessionId: data.sessionId, name }
                });
                this.sendSessions(uri, file);
                return;
            }
            case 'chat.selection':
                // The panel pushes the current diagram selection; used as context.
                this.selectionByFile.set(
                    file,
                    Array.isArray(data?.selectedNodeIds) ? data.selectedNodeIds.map(String) : []
                );
                return;
            case 'chat.sendMessage': {
                if (Array.isArray(data?.selectedNodeIds)) {
                    this.selectionByFile.set(file, data.selectedNodeIds.map(String));
                }
                await this.ensureStarted(cwd);
                // Fall back to the current session if the panel didn't pass one.
                let sessionId: string | undefined =
                    data.sessionId || this.sessions.getCurrentSessionId() || undefined;
                if (!sessionId) {
                    const session = await this.sessions.createSession(
                        file,
                        undefined,
                        data.mode ?? this.pendingMode ?? 'build'
                    );
                    sessionId = session.id;
                    this.sessionUri.set(sessionId, uri);
                    this.sessions.setCurrentSession(sessionId);
                    await this.applyPending(sessionId);
                    this.postToWebview(uri, { type: 'chat.sessionCreated', data: { session } });
                    this.sendSessions(uri, file);
                }
                this.sessionUri.set(sessionId, uri);
                this.sessions.setCurrentSession(sessionId);
                // A session restored from storage (after a reload) isn't attached in
                // the freshly-started agent, so re-attach it before prompting — else
                // the agent has no context (file) for it.
                if (!this.acp.getSession(sessionId)) {
                    await this.sessions.loadSession(sessionId);
                }
                this.sessions.addMessageToSession(sessionId, {
                    role: 'user',
                    content: data.text,
                    timestamp: Date.now(),
                    mode: data.mode
                });
                const mode: 'plan' | 'build' = data.mode === 'plan' ? 'plan' : 'build';
                let resolved: { contribution: ChatCommandContribution; args: Record<string, any> } | null = null;
                try {
                    resolved = this.registry.resolve(String(data.text ?? ''), mode);
                } catch (err) {
                    this.postToWebview(uri, {
                        type: 'chat.message',
                        data: {
                            role: 'system',
                            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                            timestamp: Date.now(),
                            mode
                        }
                    });
                    return;
                }
                if (resolved && resolved.contribution.handler) {
                    const ctx = {
                        file,
                        uri,
                        sessionId,
                        selectedNodeIds: this.selectionByFile.get(file) ?? [],
                        mode
                    };
                    let result: { success: boolean; error?: string; info?: string };
                    try {
                        result = await resolved.contribution.handler(resolved.args, ctx);
                    } catch (err) {
                        result = { success: false, error: err instanceof Error ? err.message : String(err) };
                    }
                    this.postToWebview(uri, {
                        type: 'chat.message',
                        data: {
                            role: 'system',
                            content: result.success
                                ? (result.info ?? `✓ Executed: /${resolved.contribution.command}`)
                                : `Error: ${result.error}`,
                            timestamp: Date.now(),
                            mode
                        }
                    });
                    return;
                }
                // Pass-through slash suggestions and natural language both go to the agent.
                await this.acp.sendPrompt(sessionId, data.text);
                if (this.config.postTurnHook) {
                    await this.config.postTurnHook(file, String(data.text ?? '')).catch(() => undefined);
                }
                return;
            }
            case 'chat.cancel':
                if (!data?.sessionId) return;
                await this.acp.cancelPrompt(data.sessionId);
                return;
            case 'chat.setMode':
                // Chosen before any session exists: remember and apply on create.
                if (!data?.sessionId) {
                    this.pendingMode = data.mode;
                    return;
                }
                await this.acp.setSessionMode(data.sessionId, data.mode);
                this.sessions.setCurrentSession(data.sessionId);
                await this.sessions.updateSessionMode(data.mode);
                return;
            case 'chat.setProvider':
            case 'chat.setModel': {
                const modelId = data.modelId ?? data.providerId;
                if (!data?.sessionId) {
                    this.pendingModel = modelId;
                    return;
                }
                await this.acp.setProvider(data.sessionId, modelId);
                // Persist the choice as the preferred model for future sessions.
                void this.context.workspaceState.update(LEGACY_KEYS.preferredModel.current, modelId);
                this.postToWebview(uri, {
                    type: 'chat.providerChanged',
                    data: { provider: modelId }
                });
                return;
            }
            case 'chat.permissionResponse':
                this.acp.respondToPermission(data.requestId, data.optionId ?? null);
                return;
            default:
                return;
        }
    }

    /** The last model the user explicitly chose (migrated from the legacy key). */
    private getPreferredModel(): string | undefined {
        return readStateWithFallback<string | undefined>(
            this.context.workspaceState,
            LEGACY_KEYS.preferredModel.current,
            LEGACY_KEYS.preferredModel.legacy,
            undefined
        );
    }

    /** Apply the preferred model first, then any pre-session mode/model the user
     *  picked before this session existed (an explicit pre-session choice wins). */
    private async applyPending(sessionId: string): Promise<void> {
        const preferred = this.getPreferredModel();
        if (preferred) {
            await this.acp.setProvider(sessionId, preferred).catch(() => undefined);
        }
        if (this.pendingMode) {
            await this.acp.setSessionMode(sessionId, this.pendingMode).catch(() => undefined);
        }
        if (this.pendingModel) {
            await this.acp.setProvider(sessionId, this.pendingModel).catch(() => undefined);
        }
    }

    // --- revert / history-with-ids ----------------------------------------

    /**
     * Map each stored user message (in order) to its opencode message id, by
     * aligning against opencode's authoritative message list. Matches by content
     * (exact or endsWith — the first prompt of a session has context text
     * prepended). Locally-only messages resolve to undefined without consuming
     * an opencode entry, so they don't shift the mapping.
     */
    private async alignUserMessageIds(
        sessionId: string,
        userContents: string[]
    ): Promise<Array<string | undefined>> {
        let oc: Array<{ id: string; text: string }> = [];
        try {
            const msgs = await this.acp.getMessagesWithIds(sessionId);
            oc = msgs
                .filter(m => (m as any)?.role === 'user' && typeof (m as any).id === 'string')
                .map(m => ({ id: (m as any).id, text: String((m as any).text ?? '').trim() }));
        } catch {
            return userContents.map(() => undefined);
        }
        const out: Array<string | undefined> = [];
        let i = 0;
        for (const raw of userContents) {
            const content = (raw ?? '').trim();
            if (
                i < oc.length &&
                content !== '' &&
                (oc[i].text === content || oc[i].text.endsWith(content))
            ) {
                out.push(oc[i].id);
                i++;
            } else {
                out.push(undefined);
            }
        }
        return out;
    }

    /** Post the full history with per-user-message opencode ids + revert state. */
    private async postHistory(
        uri: string,
        sessionId: string,
        extra?: { mode?: 'plan' | 'build'; model?: string }
    ): Promise<void> {
        const stored = this.sessions.getSessionMessages(sessionId);
        const userContents = stored.filter(m => m.role === 'user').map(m => m.content ?? '');
        const ids = await this.alignUserMessageIds(sessionId, userContents);
        let reverted = false;
        try {
            reverted = Boolean(await this.acp.getRevertState(sessionId));
        } catch {
            // HTTP API unavailable — render history without revert ids.
        }
        let k = 0;
        const messages = stored.map(m => {
            if (m.role !== 'user') return m;
            const messageId = ids[k++];
            return messageId ? { ...m, messageId } : m;
        });
        this.postToWebview(uri, {
            type: 'chat.sessionHistory',
            data: {
                sessionId,
                messages,
                mode: extra?.mode ?? this.acp.getSessionMode(sessionId),
                model: extra?.model ?? this.acp.getSessionModel(sessionId),
                reverted
            }
        });
    }

    /** After a turn, push resolved user-message ids (+ revert state) for the
     *  live timeline so just-sent messages gain their revert affordance. */
    private async postLiveMessageIds(sessionId: string): Promise<void> {
        const uri = this.sessionUri.get(sessionId);
        if (!uri) return;
        const stored = this.sessions.getSessionMessages(sessionId);
        const userContents = stored.filter(m => m.role === 'user').map(m => m.content ?? '');
        const ids = await this.alignUserMessageIds(sessionId, userContents);
        let reverted = false;
        try {
            reverted = Boolean(await this.acp.getRevertState(sessionId));
        } catch {
            // ignore
        }
        this.postToWebview(uri, { type: 'chat.messageIds', data: { sessionId, ids, reverted } });
    }

    private sendSessions(uri: string, file: string): void {
        const sessions = this.sessions
            .getSessionsForWorkflow(file)
            .map(s => ({ id: s.id, name: s.name }));
        this.postToWebview(uri, { type: 'chat.sessions', data: { sessions } });
    }

    private async sendModels(uri: string): Promise<void> {
        const providers = await this.acp.listProviders().catch(() => []);
        this.postToWebview(uri, {
            type: 'chat.providers',
            data: { providers }
        });
    }

    // --- diagnostics -------------------------------------------------------

    /** Append a line to this runtime's output channel (used by transport/capability). */
    logLine(message: string): void {
        this.output.appendLine(message);
    }

    showLog(): void {
        this.output.show(true);
    }

    async runDiagnostics(): Promise<void> {
        this.showLog();
        this.output.appendLine('──────── DIAGNOSTICS ────────');
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.output.appendLine(`workspace folder: ${workspaceRoot ?? '(none — open a folder)'}`);
        this.output.appendLine(`PATH: ${process.env.PATH ?? '(unset)'}`);
        this.output.appendLine(`acp connected: ${this.acp.isClientConnected()}`);
        if (!workspaceRoot) {
            this.output.appendLine('Cannot probe: no workspace folder open.');
            return;
        }
        try {
            await this.ensureStarted(workspaceRoot);
            const sessionId = await this.acp.createSession(workspaceRoot, 'diagnostic-probe', 'build');
            this.output.appendLine(`Probe session created: ${sessionId}`);
            const models = await this.acp.listProviders();
            this.output.appendLine(
                `Models available: ${models.length}` +
                    (models.length ? ` (e.g. ${models.slice(0, 3).map((m: any) => m.id).join(', ')})` : '')
            );
            this.output.appendLine('✅ Backend is functional. If the panel still shows "Connecting", the webview↔extension messages are not reaching it.');
        } catch (e) {
            this.output.appendLine(`Probe FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    dispose(): void {
        this.clearConnectWatchdog();
        this.acpForwardingDisposer();
        this.acp.stop();
        this.mcpHttp?.stop();
        this.output.dispose();
    }
}
