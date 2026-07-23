/**
 * CLI run driver: extracted verbatim from `extension-core`'s
 * `registerCalDiagramCommands`. Owns the configured `run`/`stop` commands, the
 * 400ms live-overlay file polling, and the read-only SSE agent stream.
 *
 * Seams (the driver never touches the GLSP connector, editor provider, or the
 * profile object directly):
 *  - refresh dispatch → {@link CliRunDriverHost.requestRefresh} (core builds the
 *    exact `RequestModelAction` and dispatches under the `refresh-during-run-*` /
 *    `refresh-agent-ctx-*` request ids the diagram-server matches on);
 *  - live SSE events → {@link CliRunDriverHost.overlay} (`ExecutionOverlaySink`);
 *  - profile values → {@link CliRunDriverConfig};
 *  - agent-tool overrides → owned by the driver: the `setAgentToolConfig` /
 *    `getAgentToolConfig` commands (ids from {@link CliRunDriverConfig.agentToolConfigCommands})
 *    mutate an in-memory map persisted through {@link CliRunDriverConfig.overrideState}
 *    (a memento-backed accessor the adapter builds from `context.workspaceState`),
 *    and the run command consumes the same map when building the CLI args.
 *
 * Drop+replay contract: the pre-extraction flush consulted the editor provider's
 * `getClientIdForDocumentUri` and retained batches for closed diagrams. The
 * driver cannot see the editor provider, so it publishes every batch to the
 * overlay sink unconditionally; the core host bridge drops events for a diagram
 * that is not open. This is lossless because `RunEventStreamClient` issues a
 * cursorless request to the run's SSE `/events` endpoint on every (re)connect,
 * so the server replays full history on initial connect and on connection
 * loss. NOTE: a webview reopened mid-run does NOT re-trigger an SSE connect,
 * so it may miss interim events until the stream reconnects — accepted; the
 * headline case (run started before the diagram opens) is fully covered.
 */
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionOverlaySink } from '@dialogram/shared';
import { requestWorkflowStop, spawnWorkflowProcess } from './process-control.js';
import { RunEventStreamClient, type RunStreamEvent } from './run-event-stream-client.js';

type RunWorkflowArgs = {
    sourceUri?: string;
    workflowName?: string;
    namespaceName?: string;
};

/**
 * Per-entity agent tool-calling settings, keyed by entity instance name.
 * Persisted (via {@link CliRunDriverConfig.overrideState}) so it survives VS
 * Code restarts.
 */
export type AgentToolEntitySettings = {
    enabled: boolean;
    auth: 'deny-all' | 'allow-all' | 'policy';
};

type RunLogEntry = {
    runId?: string;
    workflowName?: string;
    sourcePath?: string;
    startedAt?: string;
    finishedAt?: string;
    outDir?: string;
};

type ActiveWorkflowRun = {
    sourceUri: vscode.Uri;
    workflowName?: string;
    startedAtMs: number;
    child: cp.ChildProcessWithoutNullStreams;
    output: vscode.OutputChannel;
    stopRequested: boolean;
};

/** Profile-derived values the run machinery reads (all the configured settings
 *  keys, the settings namespace, the custom-editor viewType, and the
 *  two command ids the driver registers). */
export interface CliRunDriverConfig {
    settingsNamespace: string;
    customEditorViewType: string;
    cliCommandSettingKey: string;
    cliCommandDefault: string;
    cliPythonModule?: string;
    runOutputDirSettingKey: string;
    liveExecutionGlowSettingKey: string;
    agentToolsSettingKey: string;
    agentToolAuthSettingKey: string;
    agentToolPolicySettingKey: string;
    agentToolTimeoutMsSettingKey: string;
    agentToolRegistrySettingKey: string;
    agentMcpBridgeCmdSettingKey: string;
    runWorkflowCommandId: string;
    stopWorkflowCommandId: string;
    /** The two non-run config command ids the driver registers to mutate/read
     *  the per-entity agent-tool overrides (from the profile). */
    agentToolConfigCommands: { set: string; get: string };
    /** Memento-backed accessor for the persisted agent-tool overrides. The
     *  adapter builds this from `context.workspaceState` (the workspaceState KEY
     *  stays in the adapter); the driver owns the in-memory map and round-trips
     *  it through here. */
    overrideState: {
        get(): Record<string, AgentToolEntitySettings> | undefined;
        update(value: Record<string, AgentToolEntitySettings>): Thenable<void>;
    };
}

export interface CliRunDriverHost {
    /** Neutral execution-overlay sink; the SSE flush publishes batches here. */
    overlay: ExecutionOverlaySink;
    /** Core-owned diagram refresh (the driver must not hold the connector).
     *  Core builds the exact `RequestModelAction` for `kind` — request-id prefix
     *  `refresh-during-run-*` (full) / `refresh-agent-ctx-*` (agentContextOnly) —
     *  passing the run's `networkName` through so the dispatch stays byte-exact. */
    requestRefresh(sourceUri: string, kind: 'full' | 'agentContextOnly', networkName?: string): void;
    /** Run output channel, owned by core. */
    output: vscode.OutputChannel;
}

/** Subscription handle returned by the driver's live-overlay APIs. */
export interface LiveOverlaySubscription {
    dispose(): void;
}

export class CliRunDriver {
    private activeRun: ActiveWorkflowRun | undefined;
    /** Per-entity agent-tool overrides; mutated by the config commands and read
     *  when building run args. Persisted through `config.overrideState`. */
    private readonly agentToolOverrides = new Map<string, AgentToolEntitySettings>();

    /** Always-on live-overlay watch: the driver owns the knowledge of the
     *  `run.wf-viewer.live.json` file (name, schema, out-dir resolution) that the
     *  editor provider used to read directly. Consumers register a source URI via
     *  {@link watchLiveOverlay} and receive its signature through
     *  {@link onLiveOverlaySignature}. Runs independently of a driver-managed run
     *  so externally-started runs (a CLI run in a terminal writing to the run
     *  out-dir) still refresh the glow — as the provider's old passive poll did. */
    private readonly liveOverlayListeners = new Set<(sourceUri: string, signature: string | undefined) => void>();
    private readonly watchedLiveOverlayUris = new Map<string, vscode.Uri>();
    private liveOverlayWatchTimer: ReturnType<typeof setInterval> | undefined;
    private liveOverlayPollInFlight = false;

    /** Passive live-overlay poll cadence. Preserves the editor provider's old
     *  `PASSIVE_LIVE_REFRESH_POLL_MS` (distinct from the 400ms run poll). */
    private static readonly LIVE_OVERLAY_WATCH_POLL_MS = 500;

    constructor(
        private readonly config: CliRunDriverConfig,
        private readonly host: CliRunDriverHost
    ) {}

    registerCommands(context: vscode.ExtensionContext): void {
        // Restore persisted agent tool overrides.
        this.loadAgentToolOverrides();

        // Command: Stop currently running workflow process.
        context.subscriptions.push(
            vscode.commands.registerCommand(this.config.stopWorkflowCommandId, async () => this.stopWorkflow())
        );

        // Command: Run workflow (invokes the configured runtime CLI)
        context.subscriptions.push(
            vscode.commands.registerCommand(this.config.runWorkflowCommandId, async (args?: RunWorkflowArgs) => this.runWorkflow(args))
        );

        // Command: Set agent tool config (called from property panel webview)
        context.subscriptions.push(
            vscode.commands.registerCommand(
                this.config.agentToolConfigCommands.set,
                (payload: { entityName?: string; enabled: boolean; auth: string }) => {
                    if (!payload) { return; }
                    const { entityName, enabled, auth } = payload;
                    const authValue = (auth ?? 'allow-all') as AgentToolEntitySettings['auth'];
                    if (enabled && entityName) {
                        this.agentToolOverrides.set(entityName, { enabled: true, auth: authValue });
                    } else if (!enabled && entityName) {
                        this.agentToolOverrides.delete(entityName);
                    }
                    this.persistAgentToolOverrides();
                }
            )
        );

        // Command: Query agent tool config (called from property panel to render current state)
        context.subscriptions.push(
            vscode.commands.registerCommand(
                this.config.agentToolConfigCommands.get,
                (entityName: string): { enabled: boolean; auth: string } => {
                    const entry = typeof entityName === 'string'
                        ? this.agentToolOverrides.get(entityName)
                        : undefined;
                    return entry
                        ? { enabled: entry.enabled, auth: entry.auth }
                        : { enabled: false, auth: 'deny-all' };
                }
            )
        );
    }

    private loadAgentToolOverrides(): void {
        const saved = this.config.overrideState.get();
        if (saved && typeof saved === 'object') {
            this.agentToolOverrides.clear();
            for (const [k, v] of Object.entries(saved)) {
                if (v && typeof v.enabled === 'boolean' && typeof v.auth === 'string') {
                    this.agentToolOverrides.set(k, v);
                }
            }
        }
    }

    private persistAgentToolOverrides(): void {
        const obj: Record<string, AgentToolEntitySettings> = {};
        for (const [k, v] of this.agentToolOverrides) {
            obj[k] = v;
        }
        void this.config.overrideState.update(obj);
    }

    dispose(): void {
        // Command subscriptions are owned by the extension context; the run
        // output channel is owned by core. Release only the always-on watch timer.
        this.stopLiveOverlayWatchTimer();
    }

    /**
     * Subscribe to live-overlay signature updates. The listener fires once per
     * poll for every watched source URI with the URI it was registered under and
     * the current overlay signature (`undefined` when the overlay file is absent,
     * a stable string derived from the overlay content + mtime/size otherwise, or
     * `'unreadable'` on a non-ENOENT read/parse failure). The consumer decides
     * whether a change warrants a refresh.
     */
    onLiveOverlaySignature(
        listener: (sourceUri: string, signature: string | undefined) => void
    ): LiveOverlaySubscription {
        this.liveOverlayListeners.add(listener);
        return {
            dispose: () => {
                this.liveOverlayListeners.delete(listener);
            }
        };
    }

    /**
     * Register interest in a source URI's live overlay. While at least one URI is
     * watched, an always-on poll (500ms) publishes each URI's signature through
     * {@link onLiveOverlaySignature}. Non-`file` URIs are never polled (matching
     * the provider's old scheme guard). Dispose the returned handle to stop
     * watching; the poll timer stops once no URIs remain.
     */
    watchLiveOverlay(sourceUri: vscode.Uri): LiveOverlaySubscription {
        if (sourceUri.scheme !== 'file') {
            return { dispose: () => { /* non-file overlays are never polled */ } };
        }
        const key = sourceUri.toString();
        this.watchedLiveOverlayUris.set(key, sourceUri);
        this.ensureLiveOverlayWatchTimer();
        return {
            dispose: () => {
                this.watchedLiveOverlayUris.delete(key);
                if (this.watchedLiveOverlayUris.size === 0) {
                    this.stopLiveOverlayWatchTimer();
                }
            }
        };
    }

    private ensureLiveOverlayWatchTimer(): void {
        if (this.liveOverlayWatchTimer) {
            return;
        }
        this.liveOverlayWatchTimer = setInterval(() => {
            void this.pollWatchedLiveOverlays();
        }, CliRunDriver.LIVE_OVERLAY_WATCH_POLL_MS);
    }

    private stopLiveOverlayWatchTimer(): void {
        if (this.liveOverlayWatchTimer) {
            clearInterval(this.liveOverlayWatchTimer);
            this.liveOverlayWatchTimer = undefined;
        }
    }

    private async pollWatchedLiveOverlays(): Promise<void> {
        if (this.liveOverlayPollInFlight || this.watchedLiveOverlayUris.size === 0) {
            return;
        }
        this.liveOverlayPollInFlight = true;
        try {
            for (const [key, uri] of this.watchedLiveOverlayUris) {
                const signature = await this.computeLiveOverlaySignature(uri);
                this.emitLiveOverlaySignature(key, signature);
            }
        } finally {
            this.liveOverlayPollInFlight = false;
        }
    }

    private emitLiveOverlaySignature(sourceUri: string, signature: string | undefined): void {
        for (const listener of this.liveOverlayListeners) {
            try {
                listener(sourceUri, signature);
            } catch {
                // A misbehaving listener must not break the poll loop or starve
                // the other listeners.
            }
        }
    }

    /**
     * Compute the live-overlay signature for a source URI. Mirrors the editor
     * provider's former `readLiveOverlaySignature` byte-for-byte, except that an
     * absent overlay file maps to `undefined` (the provider's old `'missing'`
     * sentinel collapses into the caller's `previous === next` equality check).
     */
    private async computeLiveOverlaySignature(sourceUri: vscode.Uri): Promise<string | undefined> {
        const runOutDir = this.resolveLiveOverlayOutDir(sourceUri);
        if (!runOutDir) {
            return undefined;
        }

        const liveOverlayPath = path.join(runOutDir, 'run.wf-viewer.live.json');
        try {
            const [overlayText, overlayStat] = await Promise.all([
                fs.readFile(liveOverlayPath, 'utf-8'),
                fs.stat(liveOverlayPath)
            ]);
            const overlay = JSON.parse(overlayText) as {
                runId?: string;
                running?: boolean;
                active?: Array<{ entityInstanceName?: string; entityInstancePath?: string[]; fireCount?: number }> | { entityInstanceName?: string; entityInstancePath?: string[]; fireCount?: number };
                error?: { entityInstanceName?: string };
            };
            const activeEntries = Array.isArray(overlay?.active)
                ? overlay.active
                : (overlay?.active ? [overlay.active] : []);
            const activeName = activeEntries.map(e => e?.entityInstanceName ?? '').filter(Boolean).join(',');
            const activePath = activeEntries
                .map(e => Array.isArray(e?.entityInstancePath) ? e.entityInstancePath.join('>') : '')
                .filter(Boolean)
                .join('|');
            const fireCount = activeEntries.length > 0 ? (activeEntries[0]?.fireCount ?? -1) : -1;
            const errorName = overlay?.error?.entityInstanceName ?? '';
            const running = overlay?.running === true ? '1' : '0';
            const runId = overlay?.runId ?? '';
            return `${runId}|${running}|${activeName}|${activePath}|${fireCount}|${errorName}|${Math.trunc(overlayStat.mtimeMs)}|${overlayStat.size}`;
        } catch (error) {
            if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            return 'unreadable';
        }
    }

    /**
     * Resolve the run output directory for the live-overlay watch. URI-scoped
     * config read (mirrors the provider's old `resolveRunOutDir`), so folder-level
     * `runOutputDir` overrides are honored. Distinct from {@link resolveRunOutDir}
     * (the run command's non-scoped resolver), which stays unchanged.
     */
    private resolveLiveOverlayOutDir(forUri: vscode.Uri): string | undefined {
        const cfg = vscode.workspace.getConfiguration(this.config.settingsNamespace, forUri);
        const raw = cfg.get<string>(this.config.runOutputDirSettingKey, 'wf-out');
        if (path.isAbsolute(raw)) {
            return raw;
        }
        return path.resolve(path.dirname(forUri.fsPath), raw);
    }

    private getActiveWorkflowDiagramUri(): vscode.Uri | undefined {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input: any = tab?.input;
        // vscode.TabInputCustom has shape { viewType: string, uri: vscode.Uri }
        if (input && typeof input === 'object' && input.viewType === this.config.customEditorViewType && input.uri) {
            return input.uri as vscode.Uri;
        }
        return undefined;
    }

    private async resolveRunOutDir(forUri: vscode.Uri): Promise<string | undefined> {
        const cfg = vscode.workspace.getConfiguration(this.config.settingsNamespace);
        const raw = cfg.get<string>(this.config.runOutputDirSettingKey, 'wf-out');
        if (path.isAbsolute(raw)) {
            return raw;
        }

        const fileDir = path.dirname(forUri.fsPath);
        return path.resolve(fileDir, raw);
    }

    private async fileExists(p: string): Promise<boolean> {
        try {
            await fs.stat(p);
            return true;
        } catch {
            return false;
        }
    }

    private async resolveRunRoot(forUri: vscode.Uri): Promise<string | undefined> {
        const wsFolder = vscode.workspace.getWorkspaceFolder(forUri) ?? vscode.workspace.workspaceFolders?.[0];
        const base = wsFolder ? wsFolder.uri.fsPath : path.dirname(forUri.fsPath);
        const projectRoot = await this.findProjectRoot(base);
        return projectRoot ?? base;
    }

    private async findProjectRoot(startDir: string): Promise<string | undefined> {
        let current = startDir;
        for (;;) {
            const pkg = path.resolve(current, 'package.json');
            const gitDir = path.resolve(current, '.git');
            if (await this.fileExists(pkg) || await this.fileExists(gitDir)) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return undefined;
    }

    private async resolveCliInvocation(forUri: vscode.Uri, isPython: boolean): Promise<{ cmd: string; argsPrefix: string[]; cwd: string } | undefined> {
        const startDir = await this.resolveRunRoot(forUri);
        if (!startDir) {
            return undefined;
        }

        const cliCommandRaw = vscode.workspace
            .getConfiguration(this.config.settingsNamespace)
            .get<string>(this.config.cliCommandSettingKey, this.config.cliCommandDefault) ?? this.config.cliCommandDefault;

        const cliCommand = String(cliCommandRaw ?? '').trim();
        if (cliCommand === '') {
            return undefined;
        }

        const shouldUsePythonModuleFallback =
            isPython
            && !!this.config.cliPythonModule
            && /(^|\/)python(?:\d+(?:\.\d+)*)?$/i.test(cliCommand);

        if (shouldUsePythonModuleFallback) {
            return {
                cmd: cliCommand,
                argsPrefix: ['-m', this.config.cliPythonModule as string],
                cwd: startDir
            };
        }

        return { cmd: cliCommand, argsPrefix: [], cwd: startDir };
    }

    private async findLatestQueueTracePath(opts: {
        baseOutDir: string;
        sourcePath: string;
        startedAfterMs: number;
        workflowName?: string;
    }): Promise<string | undefined> {
        const runLogPath = path.join(opts.baseOutDir, 'run-log.jsonl');
        let content: string;
        try {
            content = await fs.readFile(runLogPath, 'utf-8');
        } catch {
            return undefined;
        }

        const lines = content
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0);

        let latest: RunLogEntry | undefined;
        let latestTs = -1;

        for (const line of lines) {
            let entry: RunLogEntry;
            try {
                entry = JSON.parse(line) as RunLogEntry;
            } catch {
                continue;
            }

            if (entry.sourcePath !== opts.sourcePath) {
                continue;
            }
            if (opts.workflowName && entry.workflowName !== opts.workflowName) {
                continue;
            }

            const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : NaN;
            const finishedMs = entry.finishedAt ? Date.parse(entry.finishedAt) : NaN;
            const ts = Number.isFinite(finishedMs) ? finishedMs : startedMs;
            if (!Number.isFinite(ts) || ts < opts.startedAfterMs) {
                continue;
            }
            if (ts > latestTs) {
                latest = entry;
                latestTs = ts;
            }
        }

        if (!latest?.outDir) {
            return undefined;
        }

        const queueTracePath = path.join(latest.outDir, 'run.wf-queues.json');
        if (!(await this.fileExists(queueTracePath))) {
            return undefined;
        }
        return queueTracePath;
    }

    private async runCli(
        inv: { cmd: string; args: string[]; cwd: string },
        output: vscode.OutputChannel,
        onSpawn?: (child: cp.ChildProcessWithoutNullStreams) => void,
        wasStopRequested?: () => boolean
    ): Promise<number> {
        return await new Promise<number>((resolve) => {
            const child = spawnWorkflowProcess(inv);

            if (child.stdout && child.stderr) {
                onSpawn?.(child as cp.ChildProcessWithoutNullStreams);
            }

            child.stdout.on('data', (d) => output.append(d.toString()));
            child.stderr.on('data', (d) => output.append(d.toString()));
            child.on('close', (code, signal) => {
                const exitSummary = `\n[wf-lang] Process exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})\n`;
                output.append(exitSummary);
                if (wasStopRequested?.()) {
                    output.append('[wf-lang] Run stopped by user request.\n');
                    resolve(130);
                    return;
                }
                if (typeof code === 'number' && code < 0) {
                    output.append('[wf-lang] Note: negative exit codes often indicate a spawn/system failure.\n');
                }
                resolve(code ?? 1);
            });
            child.on('error', (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                output.append(`[wf-lang] Spawn error: ${msg}\n`);
                resolve(1);
            });
        });
    }

    private async stopWorkflow(): Promise<{ ok: boolean; message: string }> {
        const active = this.activeRun;
        if (!active) {
            const message = 'No workflow run is currently active.';
            void vscode.window.showInformationMessage(message);
            return { ok: false, message };
        }

        requestWorkflowStop(active, () => this.activeRun === active);

        const message = 'Stop requested for workflow run.';
        void vscode.window.showInformationMessage(message);
        return { ok: true, message };
    }

    private async runWorkflow(args?: RunWorkflowArgs): Promise<unknown> {
        if (this.activeRun) {
            const runningLabel = this.activeRun.workflowName?.trim() || path.basename(this.activeRun.sourceUri.fsPath);
            const message = `A workflow run is already active (${runningLabel}). Stop it before starting another run.`;
            vscode.window.showWarningMessage(message);
            return { error: message };
        }

        const runStartedAtMs = Date.now();
        const sourceUriStr = args?.sourceUri;
        const sourceUri = sourceUriStr ? vscode.Uri.parse(sourceUriStr) : this.getActiveWorkflowDiagramUri();
        if (!sourceUri) {
            vscode.window.showWarningMessage('No active workflow diagram found. Focus an open diagram and try again.');
            return { error: 'No active workflow diagram found' };
        }

        const workflowName = typeof args?.workflowName === 'string' && args.workflowName.trim() ? args.workflowName.trim() : undefined;
        const namespaceName = typeof args?.namespaceName === 'string' && args.namespaceName.trim() ? args.namespaceName.trim() : undefined;

        const runOutDir = await this.resolveRunOutDir(sourceUri);
        if (!runOutDir) {
            vscode.window.showErrorMessage(`Cannot resolve ${this.config.settingsNamespace}.${this.config.runOutputDirSettingKey} (no workspace folder found).`);
            return { error: `Cannot resolve ${this.config.settingsNamespace}.${this.config.runOutputDirSettingKey} (no workspace folder found).` };
        }

        const isPython = sourceUri.fsPath.endsWith('.py');
        const cli = await this.resolveCliInvocation(sourceUri, isPython);
        if (!cli) {
            const cliLabel = `${this.config.settingsNamespace}.${this.config.cliCommandSettingKey}`;
            const message = `Cannot locate CLI command from ${cliLabel} (no workspace folder found).`;
            vscode.window.showErrorMessage(message);
            return { error: message };
        }

        const output = this.host.output;
        output.show(true);

        const cliArgs: string[] = [...cli.argsPrefix, 'run', sourceUri.fsPath, '--out-dir', runOutDir, '--keep-intermediates'];
        if (workflowName && namespaceName) {
            cliArgs.push('--workflow', `${namespaceName}.${workflowName}`);
        } else if (workflowName) {
            cliArgs.push('--workflow', workflowName);
        }
        if (namespaceName && !workflowName) {
            cliArgs.push('--namespace', namespaceName);
        }

        // Agent tool-calling settings (global settings + per-entity overrides from context menu).
        const wfConfig = vscode.workspace.getConfiguration(this.config.settingsNamespace, sourceUri);
        let effectiveToolsEnabled = wfConfig.get<boolean>(this.config.agentToolsSettingKey, false);
        let effectiveAuth = wfConfig.get<string>(this.config.agentToolAuthSettingKey, 'deny-all') ?? 'deny-all';

        // Per-entity overrides from "Configure Agent Tools..." context menu
        // take priority over global settings.
        const authPriority: Record<string, number> = { 'deny-all': 0, 'policy': 1, 'allow-all': 2 };
        for (const [, settings] of this.agentToolOverrides) {
            if (settings.enabled) {
                effectiveToolsEnabled = true;
                // Use the most permissive auth mode among all configured entities.
                if ((authPriority[settings.auth] ?? 0) > (authPriority[effectiveAuth] ?? 0)) {
                    effectiveAuth = settings.auth;
                }
            }
        }

        if (effectiveToolsEnabled) {
            cliArgs.push('--agent-tools');
            if (effectiveAuth !== 'deny-all') {
                cliArgs.push('--agent-tool-auth', effectiveAuth);
            }
        }
        const agentToolPolicy = wfConfig.get<string>(this.config.agentToolPolicySettingKey, '');
        if (agentToolPolicy) {
            cliArgs.push('--agent-tool-policy', agentToolPolicy);
        }
        const agentToolTimeout = wfConfig.get<number>(this.config.agentToolTimeoutMsSettingKey, 20000);
        if (agentToolTimeout && agentToolTimeout !== 20000) {
            cliArgs.push('--agent-tool-timeout-ms', String(agentToolTimeout));
        }
        const agentToolRegistry = wfConfig.get<string>(this.config.agentToolRegistrySettingKey, '');
        if (agentToolRegistry) {
            cliArgs.push('--agent-tool-registry', agentToolRegistry);
        }
        const agentMcpBridgeCmd = wfConfig.get<string>(this.config.agentMcpBridgeCmdSettingKey, '');
        if (agentMcpBridgeCmd) {
            cliArgs.push('--agent-mcp-bridge-cmd', agentMcpBridgeCmd);
        }

        const title = workflowName ? `Running workflow ${workflowName}` : 'Running workflow';
        const liveGlowEnabled = vscode.workspace
            .getConfiguration(this.config.settingsNamespace, sourceUri)
            .get<boolean>(this.config.liveExecutionGlowSettingKey, true);
        const liveOverlayPath = path.join(runOutDir, 'run.wf-viewer.live.json');
        const liveAgentContextPath = path.join(runOutDir, 'run.wf-agent-context.live.json');
        let lastOverlaySignature: string | undefined;
        let lastAgentCtxSignature: string | undefined;

        const refreshDiagram = async (force = false): Promise<void> => {
            try {
                if (!force) {
                    try {
                        const raw = await fs.readFile(liveOverlayPath, 'utf-8');
                        const overlay = JSON.parse(raw) as {
                            runId?: string;
                            running?: boolean;
                            active?: Array<{ entityInstanceName?: string; fireCount?: number }> | { entityInstanceName?: string; fireCount?: number };
                        };
                        const activeEntries = Array.isArray(overlay?.active)
                            ? overlay.active
                            : (overlay?.active ? [overlay.active] : []);
                        const activeName = activeEntries.map(e => e?.entityInstanceName ?? '').filter(Boolean).join(',');
                        const fireCount = activeEntries.length > 0 ? (activeEntries[0]?.fireCount ?? -1) : -1;
                        const running = overlay?.running === true ? '1' : '0';
                        const runId = overlay?.runId ?? '';
                        // Track overlay and agent context signatures separately
                        // so we can skip full model rebuild when only agent context changed.
                        const overlaySig = `${runId}|${running}|${activeName}|${fireCount}`;
                        let agentCtxSize = 0;
                        try {
                            const stat = await fs.stat(liveAgentContextPath);
                            agentCtxSize = stat.size;
                        } catch {
                            // ignore — file may not exist (no stateful agents)
                        }
                        const agentCtxSig = `${agentCtxSize}`;
                        const overlayChanged = lastOverlaySignature === undefined || overlaySig !== lastOverlaySignature;
                        const agentCtxChanged = lastAgentCtxSignature === undefined || agentCtxSig !== lastAgentCtxSignature;
                        lastOverlaySignature = overlaySig;
                        lastAgentCtxSignature = agentCtxSig;
                        if (!overlayChanged && !agentCtxChanged) {
                            return;
                        }
                        output.appendLine(`[wf-lang live] change detected: overlay=${overlayChanged} agentCtx=${agentCtxChanged} active=${activeName} fire=${fireCount}`);
                        // Fast path: only agent context changed → lightweight refresh.
                        if (!overlayChanged && agentCtxChanged) {
                            this.host.requestRefresh(sourceUri.toString(), 'agentContextOnly', workflowName);
                            return;
                        }
                    } catch (readErr) {
                        // Silently ignore ENOENT — the live overlay file may not exist yet
                        // (e.g. run just started, or no overlay has been written).
                        if (readErr && typeof readErr === 'object' && (readErr as NodeJS.ErrnoException).code === 'ENOENT') {
                            return;
                        }
                        // Log other transient file read failures during live polling.
                        output.appendLine(`[wf-lang live] overlay read error: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
                        return;
                    }
                }

                this.host.requestRefresh(sourceUri.toString(), 'full', workflowName);
            } catch (refreshErr) {
                output.appendLine(`[wf-lang live] refresh error: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
            }
        };

        let refreshTimer: ReturnType<typeof setInterval> | undefined;

        // Live agent message stream: connect (read-only) to the run's SSE endpoint
        // (advertised in run.wf-stream.live.json) and forward batched events to the
        // diagram client, which renders them in the read-only "Running agents" bar.
        // Best-effort; the file-polling overlay above remains the fallback.
        let streamClient: RunEventStreamClient | undefined;
        let streamBatch: RunStreamEvent[] = [];
        let streamFlushTimer: ReturnType<typeof setInterval> | undefined;
        let streamEventCount = 0;
        // Permanent, ungated host breadcrumbs (console.log so a webview/console
        // paste captures them — the extension host relays console.log). Every hop
        // of the run-stream pipeline logs, mirroring the client-side `[wf-lang
        // overlay]` breadcrumbs, so the dying hop is visible with zero inference.
        const hostLog = (message: string): void => {
            // eslint-disable-next-line no-console
            console.log(`[wf-lang overlay] host: ${message}`);
        };
        const flushStreamEvents = (): void => {
            if (streamBatch.length === 0) {
                return;
            }
            const events = streamBatch;
            streamBatch = [];
            hostLog(`flush ${events.length} events -> emitEvents(${sourceUri.toString()})`);
            // Route through the neutral execution-overlay seam; the core host bridge
            // resolves the target clientId and dispatches (dropping if the diagram is
            // closed — history is replayed on connect, see the file header).
            this.host.overlay.emitEvents(sourceUri.toString(), events);
        };
        const startStream = (): void => {
            const discoveryFilePath = path.join(runOutDir, 'run.wf-stream.live.json');
            hostLog(`constructing RunEventStreamClient discovery=${discoveryFilePath}`);
            streamClient = new RunEventStreamClient({
                discoveryFilePath,
                onEvent: (event) => {
                    streamBatch.push(event);
                    hostLog(`SSE event #${++streamEventCount} type=${String(event.type)}`);
                },
                onLog: (m) => {
                    hostLog(m);
                    output.appendLine(`[wf-lang ${m}`);
                },
            });
            streamClient.start();
            streamFlushTimer = setInterval(flushStreamEvents, 120);
        };
        const stopStream = (): void => {
            if (streamFlushTimer) {
                clearInterval(streamFlushTimer);
                streamFlushTimer = undefined;
            }
            flushStreamEvents();
            streamClient?.stop();
            streamClient = undefined;
        };

        const exitCode = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false
            },
            async () => {
                output.appendLine(`[wf-lang] cwd=${cli.cwd}`);
                output.appendLine(`[wf-lang] ${cli.cmd} ${cliArgs.map(a => JSON.stringify(a)).join(' ')}`);
                output.appendLine('');
                if (liveGlowEnabled) {
                    refreshTimer = setInterval(() => void refreshDiagram(), 400);
                }
                startStream();
                return await this.runCli(
                    { cmd: cli.cmd, args: cliArgs, cwd: cli.cwd },
                    output,
                    (child) => {
                        this.activeRun = {
                            sourceUri,
                            workflowName,
                            startedAtMs: runStartedAtMs,
                            child,
                            output,
                            stopRequested: false
                        };
                    },
                    () => this.activeRun?.stopRequested === true
                );
            }
        );

        const stopRequested = this.activeRun?.stopRequested === true;
        this.activeRun = undefined;

        if (refreshTimer) {
            clearInterval(refreshTimer);
        }
        stopStream();

        if (stopRequested) {
            vscode.window.showInformationMessage('Workflow run canceled.');
            return { ok: false, canceled: true };
        }

        if (exitCode !== 0) {
            const msg = `Workflow run failed (exit code ${exitCode}). See 'wf-lang Run' output.`;
            vscode.window.showErrorMessage(msg);
            return { error: msg };
        }

        // Refresh diagram so overlay decorations can pick up the new run artifacts.
        await refreshDiagram(true);

        const queueTracePath = await this.findLatestQueueTracePath({
            baseOutDir: runOutDir,
            sourcePath: sourceUri.fsPath,
            startedAfterMs: runStartedAtMs,
            workflowName
        });

        if (queueTracePath) {
            const openAction = 'Open Queue Trace';
            const selected = await vscode.window.showInformationMessage('Workflow run finished.', openAction);
            if (selected === openAction) {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(queueTracePath));
            }
        } else {
            vscode.window.showInformationMessage('Workflow run finished.');
        }
        return true;
    }
}
