/**
 * CLI run driver. Owns the configured `run`/`stop` commands, the 400ms
 * live-overlay file polling, and the read-only SSE agent stream.
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
import { noCliCommandMessage, resolveCliInvocation } from './cli-invocation.js';
import { cliProcessEnv, type CliFolderListVariable } from './server/sidecar-runtime-config.js';
import { fileExists } from './server/source-files';
import * as cp from 'node:child_process';
import { realpathSync, unlinkSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as readline from 'node:readline';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionOverlaySink } from '@dialogram/shared';
import { resumeStepFor } from './resume-at-step.js';
import { appendTail, failureHeadline, failureWhere, fixTask, type FixTask, type RunFailure } from './run-failure.js';
import { requestWorkflowStop, spawnWorkflowProcess, type WorkflowCliInvocation } from './process-control.js';
import { RunStreamForwarder, streamListening } from './run-stream-forwarder.js';

type RunWorkflowArgs = {
    sourceUri?: string;
    workflowName?: string;
    namespaceName?: string;
    /** Resume the run in this directory instead of starting a new one. */
    resumeFrom?: string;
    /** With `resumeFrom`: the step of its queue trace to resume at. */
    atStep?: number;
    /** With `resumeFrom`: resume at the step before this node's last firing. */
    resumeAtActor?: string;
    /** With `resumeFrom`: resume at its last completed step -- where it failed. */
    resumeAtLastStep?: boolean;
    /** Values for the workflow's inputs, as the person would type them; an input
     *  named here is not asked for. An empty value gives that input no token. */
    inputs?: Record<string, string>;
    /** Ask for the inputs `inputs` leaves out (default true). A caller that
     *  cannot wait on a person (the chat's tool) passes false: those inputs get no token. */
    askInputs?: boolean;
    /** The plan its caller already made (the chat's run checks the inputs against it), so the
     *  file is not planned twice. */
    planned?: PlannedRun;
};

/** What a run of a file needs to know before it starts, from the plan the diagram is drawn from. */
export interface PlannedRun {
    /** The workflow the plan shows for the file: what a run of the diagram runs. */
    workflowName?: string;
    /** Its inputs, each a value the run asks for. */
    inputs: Array<{ name: string; type?: string }>;
}

/** The plan's run of a file: its workflow (the graph's id, `wf:<name>`) and its root inputs. */
export function plannedRunOf(graph: unknown): PlannedRun | undefined {
    const g = graph as { id?: unknown; nodes?: Array<{ kind?: string; label?: string; scope?: string; ports?: Array<{ name?: string; type?: string }> }>; subgraphs?: Array<{ id?: string; kind?: string }> } | undefined;
    if (!g || typeof g !== 'object' || !Array.isArray(g.nodes)) {
        return undefined;
    }
    const root = g.subgraphs?.find(scope => scope.kind === 'root')?.id;
    const inputs = g.nodes
        .filter(node => node.kind === 'wf-input' && (!root || !node.scope || node.scope === root))
        .map(node => ({ name: String(node.ports?.[0]?.name ?? node.label ?? ''), type: node.ports?.[0]?.type }))
        .filter(input => input.name !== '');
    const id = typeof g.id === 'string' ? g.id.replace(/^wf:/, '').trim() : '';
    return { ...(id ? { workflowName: id } : {}), inputs };
}

/** An input's value as `--input` takes it: text stays text even when it reads as a number. */
export function runInputValue(value: string, type: string | undefined): string {
    const bare = (type ?? '').trim();
    if ((bare === 'str' || bare === 'string') && !value.startsWith('"')) {
        return JSON.stringify(value);
    }
    return value;
}

/** The command the chat's `run_workflow` tool runs (see `CliRunDriver.runFromChat`). */
export function runFromChatCommandId(runWorkflowCommandId: string): string {
    return `${runWorkflowCommandId}.fromChat`;
}

/** How a run ended, for a caller waiting on it. */
type RunEnd =
    | { kind: 'clean'; runDir?: string }
    | { kind: 'failed'; headline: string; runDir?: string }
    | { kind: 'stopped' };

/** What the chat's `run_workflow` tool passes: the file, and optionally the workflow, its inputs and how long to wait. */
export interface RunFromChatArgs {
    file?: string;
    workflowName?: string;
    inputs?: Record<string, unknown>;
    waitSeconds?: number;
}

/** The command the chat's `resume_failed_run` tool runs (see `CliRunDriver.resumeFailedRun`). */
export function resumeFailedRunCommandId(runWorkflowCommandId: string): string {
    return `${runWorkflowCommandId}.resumeFailed`;
}

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
    /** Variables a run is given from the product's settings (`CliFolderListVariable`). */
    cliEnvironment?: readonly CliFolderListVariable[];
    runOutputDirSettingKey: string;
    liveExecutionGlowSettingKey: string;
    agentToolsSettingKey: string;
    agentToolAuthSettingKey: string;
    agentToolPolicySettingKey: string;
    agentToolTimeoutMsSettingKey: string;
    agentToolRegistrySettingKey: string;
    agentMcpBridgeCmdSettingKey: string;
    /** The ACP connector a run's agents spawn when they name none (the runtime's
     *  `--acp-connector`) and what their permission
     *  requests get when no user answers (`--agent-cli-acp-permissions`); both
     *  optional, a shell without them passes nothing. */
    acpConnectorSettingKey?: string;
    acpPermissionsSettingKey?: string;
    /** Host the run's questions on a Unix socket (`--elicit-socket`): an
     *  agent's `ask_user` question or, over ACP, a permission request reaches
     *  {@link CliRunDriverHost.askUser}, or a VS Code prompt when the host has
     *  none. Default true; never on Windows, where the runtime's side is AF_UNIX. */
    elicitSocket?: boolean;
    runWorkflowCommandId: string;
    stopWorkflowCommandId: string;
    /** The run arguments that resume the run in `runDir` at `step` (the
     *  product's syntax). Without it a run cannot be resumed at a step. */
    cliResumeArgs?: (runDir: string, step: number) => string[];
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
    /** The plan's run of a file, for the workflow named or, when none is, the one
     *  the diagram shows; `undefined` when the plan cannot say. Without it a run
     *  names only the workflow its caller named, and asks for no input. */
    planRun?: (sourceUri: vscode.Uri, workflowName: string | undefined) => Promise<PlannedRun | undefined>;
}

/** A question a running agent puts to the user (the runtime's elicitation channel,
 *  one JSON object a line on the socket; `SocketElicitationHandler` in the runtime
 *  documents the wire format). A permission request over ACP arrives as one:
 *  the tool call's title as the question, the agent's options as the choices. */
export interface RunQuestion {
    id: number;
    agent: string;
    model?: string;
    runId?: string;
    question: string;
    context?: string | null;
    choices?: string[] | null;
    timeoutMs?: number;
}

/** The user's answer: one of the choices (or free text), or a refusal. */
export interface RunAnswer {
    answer?: string;
    declined?: boolean;
    reason?: string;
}

export interface CliRunDriverHost {
    /** Neutral execution-overlay sink; the SSE flush publishes batches here. */
    overlay: ExecutionOverlaySink;
    /** Answers a running agent's question for the diagram at `sourceUri`.
     *  Optional, and may resolve `undefined` (no one there to ask, e.g. no chat
     *  open on that diagram): then, as without it, the driver asks through a
     *  VS Code quick pick (choices) or input box (free text). */
    askUser?(question: RunQuestion, sourceUri: string): Promise<RunAnswer | undefined>;
    /** Core-owned diagram refresh (the driver must not hold the connector).
     *  Core builds the exact `RequestModelAction` for `kind` — request-id prefix
     *  `refresh-during-run-*` (full) / `refresh-agent-ctx-*` (agentContextOnly) —
     *  passing the run's `networkName` through so the dispatch stays byte-exact. */
    requestRefresh(sourceUri: string, kind: 'full' | 'agentContextOnly', networkName?: string): void;
    /** Run output channel, owned by core. */
    output: vscode.OutputChannel;
    /** Starts a task in the chat on the diagram at `sourceUri` (a new session in
     *  `task.mode`, its first message `task.prompt`); `false` when no chat can.
     *  Without it a failed run is reported, and nothing is offered. */
    startChatTask?(task: FixTask, sourceUri: string): Promise<boolean>;
    /** Asks the person to confirm in the chat session on the diagram at
     *  `sourceUri` (`choices` as buttons): the button pressed, none when
     *  declined, `undefined` when no chat can ask -- then a VS Code prompt does. */
    confirmInChat?(confirm: { title: string; text: string; choices: string[] }, sourceUri: string): Promise<{ choice?: string } | undefined>;
}

/** Subscription handle returned by the driver's live-overlay APIs. */
export interface LiveOverlaySubscription {
    dispose(): void;
}

/** What a run's `run.wf-stream.live.json` says about its stream. */
interface StreamDiscovery {
    runId?: string;
    sourcePath?: string;
    host?: string;
    port: number;
}

async function readStreamDiscovery(filePath: string): Promise<StreamDiscovery | undefined> {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Partial<StreamDiscovery>;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.port !== 'number') {
            return undefined;
        }
        return {
            runId: typeof parsed.runId === 'string' && parsed.runId ? parsed.runId : undefined,
            sourcePath: typeof parsed.sourcePath === 'string' ? parsed.sourcePath : undefined,
            host: typeof parsed.host === 'string' && parsed.host ? parsed.host : undefined,
            port: parsed.port,
        };
    } catch {
        return undefined; // not written yet, removed at the run's end, or half-written
    }
}

/** Whether a run's `sourcePath` is this file (a symlinked folder included). */
function sameFile(sourcePath: string | undefined, fsPath: string): boolean {
    if (!sourcePath) {
        return false;
    }
    const real = (p: string): string => {
        try {
            return realpathSync.native(p);
        } catch {
            return path.resolve(p);
        }
    };
    return path.resolve(sourcePath) === path.resolve(fsPath) || real(sourcePath) === real(fsPath);
}

export class CliRunDriver {
    private activeRun: ActiveWorkflowRun | undefined;
    /** The last failed run of each workflow file (by fsPath), until it runs clean. */
    private readonly failedRuns = new Map<string, { sourceUri: vscode.Uri; workflowName?: string; runDir: string; failure?: RunFailure }>();
    private lastFailedFile: string | undefined;
    /** Per-entity agent-tool overrides; mutated by the config commands and read
     *  when building run args. Persisted through `config.overrideState`. */
    private readonly agentToolOverrides = new Map<string, AgentToolEntitySettings>();
    /** The value last given to each input, by file, workflow and input: the next run offers it. */
    private readonly lastInputValues = new Map<string, string>();
    /** A run is asking for its inputs: another waits for it. */
    private askingForInputs = false;
    /** Told once when the run in progress ends: the chat's run waits on it. */
    private readonly runEndListeners = new Set<(end: RunEnd) => void>();
    /** Told when a run's process has started: the chat's run times its wait from there. */
    private readonly runStartListeners = new Set<() => void>();

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
    /** The agent stream of a run of a watched diagram's file that the IDE did not
     *  start (a run of the CLI in a terminal writing to the same out dir), forwarded to
     *  the diagram as the IDE's own run's is: keyed by the diagram's source URI. */
    private readonly followedRuns = new Map<string, { runId: string; forwarder: RunStreamForwarder; checking: boolean }>();
    /** Runs whose stream is gone: a killed run leaves its discovery file behind. */
    private readonly goneRunIds = new Set<string>();

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

        // Command: resume the last failed run, at the user's word -- what the
        // chat's `resume_failed_run` tool runs once the agent's fix is in.
        context.subscriptions.push(
            vscode.commands.registerCommand(
                resumeFailedRunCommandId(this.config.runWorkflowCommandId),
                async (args?: { file?: string }) => this.resumeFailedRun(args?.file)
            )
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(
                runFromChatCommandId(this.config.runWorkflowCommandId),
                async (args?: RunFromChatArgs) => this.runFromChat(args ?? {})
            )
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
        // output channel is owned by core. Release only the always-on watch timer,
        // and the runs it was following.
        this.stopLiveOverlayWatchTimer();
        for (const key of [...this.followedRuns.keys()]) {
            this.stopFollowedRun(key);
        }
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
                this.stopFollowedRun(key, 'the diagram closed');
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
                try {
                    await this.followExternalRun(key, uri);
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.log(`[wf-lang overlay] host: following ${uri.fsPath} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        } finally {
            this.liveOverlayPollInFlight = false;
        }
    }

    /**
     * Follow the agent stream of a run of this diagram's file that the IDE did not
     * start: a run of the CLI in a terminal writes the same `run.wf-stream.live.json`
     * in the out dir, naming its file (`sourcePath`), its run id and where its
     * stream listens, and removes it when the run ends. The diagram then shows the
     * run's agents as it does the IDE's own run's. Following stops when the file
     * goes or names another run, when the stream is gone, when the diagram closes,
     * and when the IDE starts a run of its own.
     */
    private async followExternalRun(key: string, uri: vscode.Uri): Promise<void> {
        const outDir = this.resolveLiveOverlayOutDir(uri);
        if (!outDir) {
            return;
        }
        const discoveryFilePath = path.join(outDir, 'run.wf-stream.live.json');
        const discovery = await readStreamDiscovery(discoveryFilePath);
        const ideRun = (): boolean => this.activeRun !== undefined && this.activeRun.sourceUri.toString() === key;
        const runId = discovery?.runId;
        const followable = discovery !== undefined && runId !== undefined && !ideRun()
            && sameFile(discovery.sourcePath, uri.fsPath) && !this.goneRunIds.has(runId);
        const followed = this.followedRuns.get(key);
        if (followed && (!followable || followed.runId !== runId)) {
            this.stopFollowedRun(key);
        }
        if (!followable || this.followedRuns.has(key)) {
            return;
        }
        const host = discovery.host ?? '127.0.0.1';
        if (!(await streamListening(host, discovery.port))) {
            this.goneRunIds.add(runId);
            return;
        }
        // Things may have moved while the stream was asked.
        if (!this.watchedLiveOverlayUris.has(key) || this.followedRuns.has(key) || ideRun()) {
            return;
        }
        const forwarder = new RunStreamForwarder({
            discoveryFilePath,
            emit: (events) => this.host.overlay.emitEvents(key, events),
            onDisconnect: () => void this.checkFollowedRun(key, runId, host, discovery.port),
        });
        this.followedRuns.set(key, { runId, forwarder, checking: false });
        // eslint-disable-next-line no-console
        console.log(`[wf-lang overlay] host: following run ${runId} of ${uri.fsPath}, started outside the IDE`);
        // The diagram keeps the last run's agents until a run starts, and the stream
        // replays only its recent history, which a long run's start is not in.
        this.host.overlay.emitEvents(key, [{ type: 'run.started', runId }]);
        forwarder.start();
    }

    /** A followed run's connection dropped: stop following when its stream is gone. */
    private async checkFollowedRun(key: string, runId: string, host: string, port: number): Promise<void> {
        const followed = this.followedRuns.get(key);
        if (!followed || followed.runId !== runId || followed.checking) {
            return;
        }
        followed.checking = true;
        try {
            if (!(await streamListening(host, port))) {
                this.goneRunIds.add(runId);
                if (this.followedRuns.get(key) === followed) {
                    this.stopFollowedRun(key);
                }
            }
        } finally {
            followed.checking = false;
        }
    }

    private stopFollowedRun(key: string, reason?: string): void {
        const followed = this.followedRuns.get(key);
        if (!followed) {
            return;
        }
        this.followedRuns.delete(key);
        followed.forwarder.stop(reason);
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

    private elicitSourceUri: string | undefined;
    private elicitServer: net.Server | undefined;
    private elicitSocketPath: string | undefined;

    /** Listen for the run's questions on a fresh Unix socket; returns its path
     *  for `--elicit-socket`. One connection per run, one question at a time
     *  (the runtime serializes them); each is answered on the same connection as one
     *  JSON line, `{id, answer}` or `{id, declined, reason}`. */
    private async startElicitSocket(sourceUri: string): Promise<string | undefined> {
        this.stopElicitSocket();
        this.elicitSourceUri = sourceUri;
        // AF_UNIX paths are short (108 bytes on Linux): the tmp dir, not the run dir.
        const socketPath = path.join(os.tmpdir(), `acp-elicit-${process.pid}-${Date.now().toString(36)}.sock`);
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            const lines = readline.createInterface({ input: conn });
            let chain: Promise<void> = Promise.resolve();
            lines.on('line', (line) => {
                chain = chain.then(async () => {
                    let question: RunQuestion;
                    try {
                        question = JSON.parse(line) as RunQuestion;
                    } catch {
                        this.host.output.appendLine(`[wf-lang ask] not JSON: ${line.slice(0, 200)}`);
                        return;
                    }
                    if ((question as { type?: string }).type !== 'question' && typeof question.question !== 'string') {
                        return;
                    }
                    const answer = await this.answerQuestion(question);
                    const reply = answer.declined || answer.answer === undefined
                        ? { id: question.id, declined: true, reason: answer.reason ?? 'declined' }
                        : { id: question.id, answer: answer.answer };
                    if (!conn.destroyed) {
                        conn.write(JSON.stringify(reply) + '\n');
                    }
                });
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        }).catch((err: unknown) => {
            this.host.output.appendLine(`[wf-lang ask] no socket: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        });
        if (!server.listening) {
            return undefined;
        }
        this.elicitServer = server;
        this.elicitSocketPath = socketPath;
        return socketPath;
    }

    private stopElicitSocket(): void {
        const server = this.elicitServer;
        const socketPath = this.elicitSocketPath;
        this.elicitServer = undefined;
        this.elicitSocketPath = undefined;
        if (server) {
            server.close();
        }
        if (socketPath) {
            try {
                unlinkSync(socketPath);
            } catch {
                // already gone
            }
        }
    }

    /** The host's `askUser`, else a VS Code prompt: a quick pick over the
     *  choices, an input box otherwise; dismissing either declines. */
    private async answerQuestion(question: RunQuestion): Promise<RunAnswer> {
        const who = question.agent ? `Agent ${question.agent}` : 'An agent';
        this.host.output.appendLine(`[wf-lang ask] ${who}: ${question.question}`
            + (question.choices?.length ? ` [${question.choices.join(' | ')}]` : ''));
        let answer: RunAnswer | undefined;
        try {
            if (this.host.askUser) {
                answer = await this.host.askUser(question, this.elicitSourceUri ?? '');
            }
            if (answer) {
                // answered by the host
            } else if (question.choices && question.choices.length > 0) {
                const picked = await vscode.window.showQuickPick(question.choices, {
                    title: `${who} asks`,
                    placeHolder: question.question,
                    ignoreFocusOut: true
                });
                answer = picked === undefined ? { declined: true, reason: 'dismissed' } : { answer: picked };
            } else {
                const typed = await vscode.window.showInputBox({
                    title: `${who} asks`,
                    prompt: question.question,
                    placeHolder: question.context ?? undefined,
                    ignoreFocusOut: true
                });
                answer = typed === undefined ? { declined: true, reason: 'dismissed' } : { answer: typed };
            }
        } catch (err: unknown) {
            answer = { declined: true, reason: err instanceof Error ? err.message : String(err) };
        }
        this.host.output.appendLine(`[wf-lang ask] -> ${answer.declined ? `declined (${answer.reason ?? ''})` : answer.answer}`);
        return answer;
    }

    /** The directory of the latest run of this workflow that started after `startedAfterMs`. */
    private async findLatestRunDir(opts: {
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

        return latest?.outDir;
    }

    private async findLatestQueueTracePath(opts: {
        baseOutDir: string;
        sourcePath: string;
        startedAfterMs: number;
        workflowName?: string;
    }): Promise<string | undefined> {
        const runDir = await this.findLatestRunDir(opts);
        if (!runDir) {
            return undefined;
        }

        const queueTracePath = path.join(runDir, 'run.wf-queues.json');
        if (!(await fileExists(queueTracePath))) {
            return undefined;
        }
        return queueTracePath;
    }

    private async spawnRun(
        inv: WorkflowCliInvocation,
        output: vscode.OutputChannel,
        onSpawn?: (child: cp.ChildProcessWithoutNullStreams) => void,
        wasStopRequested?: () => boolean,
        onStderr?: (text: string) => void
    ): Promise<number> {
        return await new Promise<number>((resolve) => {
            const child = spawnWorkflowProcess(inv);

            if (child.stdout && child.stderr) {
                onSpawn?.(child as cp.ChildProcessWithoutNullStreams);
            }

            child.stdout.on('data', (d) => output.append(d.toString()));
            child.stderr.on('data', (d) => {
                const text = d.toString();
                output.append(text);
                onStderr?.(text);
            });
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

    /**
     * Resume the last failed run of `file`'s workflow from where it failed, if
     * the person agrees. Returns what happened, in words, for the agent that
     * asked: it proposed this after fixing the failure.
     *
     * `file` is the chat session's file. Navigating a hierarchy in place that
     * can be a nested workflow's file, not the root that ran; then the last run
     * that failed is the one meant.
     */
    async resumeFailedRun(file?: string): Promise<string> {
        if (!this.config.cliResumeArgs) {
            return 'This runtime cannot resume a run; ask the user to run the workflow again.';
        }
        const failed = (file ? this.failedRuns.get(file) : undefined)
            ?? (this.lastFailedFile ? this.failedRuns.get(this.lastFailedFile) : undefined);
        if (!failed) {
            return 'There is no failed run to resume: the workflow has run clean since, or has not failed in this session.';
        }
        if (this.activeRun) {
            return 'A run is already in progress; the failed run can be resumed once it ends.';
        }
        const RESUME = 'Resume';
        const NOT_NOW = 'Not now';
        const where = failureWhere(failed.failure);
        const text = `Resume the run${failed.workflowName ? ` of ${failed.workflowName}` : ''} from where it failed${where ? ` (${where})` : ''}? `
            + 'What ran before is replayed, not run again.';
        // Asked in the chat that made the fix, where the person is; a VS Code
        // prompt only when no chat can ask.
        const answer = this.host.confirmInChat
            ? await this.host.confirmInChat({ title: 'Resume the failed run', text, choices: [RESUME, NOT_NOW] }, failed.sourceUri.toString())
            : undefined;
        const choice = answer
            ? answer.choice
            : await vscode.window.showInformationMessage(`The chat's fix is in. ${text}`, RESUME, NOT_NOW);
        if (choice !== RESUME) {
            return 'The user chose not to resume the run now.';
        }
        // Not awaited: a run can outlast a tool call. Its outcome shows on the
        // diagram, and a new failure is offered for fixing again.
        void this.runWorkflow({
            sourceUri: failed.sourceUri.toString(),
            workflowName: failed.workflowName,
            resumeFrom: failed.runDir,
            resumeAtLastStep: true
        });
        return 'The run is resuming from where it failed. Its result will show on the diagram; if it fails again, the user is offered a new fix.';
    }

    /** The error a run recorded, if its record has one. */
    private async readRunFailure(runDir: string): Promise<RunFailure | undefined> {
        try {
            const record = JSON.parse(await fs.readFile(path.join(runDir, 'run.wf-run.json'), 'utf-8'));
            const error = record?.error;
            if (!error || typeof error !== 'object') {
                return undefined;
            }
            return {
                ...(typeof error.message === 'string' ? { message: error.message } : {}),
                ...(typeof error.entityInstanceName === 'string' ? { entityInstanceName: error.entityInstanceName } : {}),
                ...(Array.isArray(error.entityInstancePath)
                    ? { entityInstancePath: error.entityInstancePath.filter((p: unknown): p is string => typeof p === 'string') }
                    : {})
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Tell the person the run failed, and where. With a chat behind the
     * diagram, offer to have the chat find the cause and propose a fix: a new
     * session in plan mode, its first message the failure.
     */
    private async reportFailure(opts: {
        sourceUri: vscode.Uri;
        workflowName?: string;
        failure: RunFailure | undefined;
        exitCode: number;
        stderrTail: string;
        runDir?: string;
        output: vscode.OutputChannel;
    }): Promise<void> {
        const headline = failureHeadline(opts.failure, opts.exitCode);
        const FIX = 'Fix with AI';
        const OUTPUT = 'Show Output';
        const actions = this.host.startChatTask ? [FIX, OUTPUT] : [OUTPUT];
        const choice = await vscode.window.showErrorMessage(headline, ...actions);
        if (choice === OUTPUT) {
            opts.output.show(true);
            return;
        }
        if (choice !== FIX || !this.host.startChatTask) {
            return;
        }
        const task: FixTask = fixTask({
            workflowName: opts.workflowName,
            sourceFile: opts.sourceUri.fsPath,
            failure: opts.failure,
            exitCode: opts.exitCode,
            stderrTail: opts.stderrTail,
            runDir: opts.runDir,
            canResume: !!this.config.cliResumeArgs && !!opts.runDir
        });
        const started = await this.host.startChatTask(task, opts.sourceUri.toString());
        if (!started) {
            void vscode.window.showWarningMessage('Open the chat on this diagram to have the failure looked at.');
        }
    }

    private tellRunEnd(end: RunEnd): void {
        for (const listener of [...this.runEndListeners]) {
            listener(end);
        }
    }

    /**
     * The chat's `run_workflow`: the IDE's own run of the file, so the diagram
     * shows it running and the chat's Run tab its log, where a run the agent
     * starts in its shell shows nowhere. A workflow with inputs is not started
     * until each has a value: the agent is told which, to ask the person. The
     * call waits for the run to end, up to `waitSeconds`, and says how it ended
     * and where its outputs are; a run of the file already going is waited on,
     * not started again.
     */
    async runFromChat(args: RunFromChatArgs): Promise<string> {
        if (!args.file) {
            return 'Name the workflow file to run.';
        }
        const sourceUri = vscode.Uri.file(args.file);
        const waitMs = Math.min(Math.max(Number(args.waitSeconds ?? 60) || 0, 0), 600) * 1000;
        if (this.activeRun) {
            if (this.activeRun.sourceUri.fsPath !== sourceUri.fsPath) {
                return `Another workflow is running (${path.basename(this.activeRun.sourceUri.fsPath)}); this one can run once it ends.`;
            }
            // Read before the wait: the run is no longer active once it has ended.
            const runningName = this.activeRun.workflowName;
            return this.describeRunEnd(await this.nextRunEnd(waitMs), runningName, waitMs);
        }
        if (this.askingForInputs) {
            return 'A run is waiting for the person to give its inputs in the editor.';
        }
        let workflowName = typeof args.workflowName === 'string' && args.workflowName.trim() ? args.workflowName.trim() : undefined;
        const inputs: Record<string, string> = Object.fromEntries(
            Object.entries(args.inputs ?? {}).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)])
        );
        if (!this.config.planRun && Object.keys(inputs).length > 0) {
            // Only a run whose inputs the plan names hands them on: dropped, they would start a
            // run with no tokens that "finishes" with nothing to show.
            return 'Not started: runs here take no inputs from the chat. Start it again without `inputs`.';
        }
        let planned: PlannedRun | undefined;
        if (this.config.planRun) {
            planned = await this.config.planRun(sourceUri, workflowName).catch(() => undefined);
            if (!planned && Object.keys(inputs).length > 0) {
                // The plan names the inputs; without it the run would drop them all.
                return 'Not started: the workflow could not be planned, so its inputs cannot be handed on. '
                    + 'Call validate_workflow to see why, and fix that first.';
            }
            workflowName ??= planned?.workflowName;
            const unknown = planned ? Object.keys(inputs).filter(name => !planned.inputs.some(input => input.name === name)) : [];
            if (unknown.length > 0) {
                const known = planned!.inputs.map(input => input.name).join(', ') || 'none';
                return `Not started: ${workflowName ?? 'the workflow'} has no input ${unknown.map(name => `'${name}'`).join(', ')}; its inputs are ${known}.`;
            }
            const missing = (planned?.inputs ?? []).filter(input => inputs[input.name] === undefined);
            if (missing.length > 0) {
                const list = missing.map(input => `${input.name}${input.type ? ` (${input.type})` : ''}`).join(', ');
                return `Not started: ${workflowName ?? 'the workflow'} takes the input${missing.length > 1 ? 's' : ''} ${list}. `
                    + 'Pass a value for each in `inputs` (text as it is, a number as digits, a File as a path; "" gives that input no token), '
                    + 'and ask the user for any you do not know.';
            }
        }
        // The wait is timed from the run's start, not from the call: planning and resolving the
        // CLI take their own time, and a run that never started is not "still going".
        let ended: Promise<RunEnd | undefined> | undefined;
        let onStart: (() => void) | undefined;
        const begun = new Promise<void>(resolve => {
            onStart = (): void => {
                this.runStartListeners.delete(onStart!);
                ended = this.nextRunEnd(waitMs);
                resolve();
            };
            this.runStartListeners.add(onStart);
        });
        const started = this.runWorkflow({ sourceUri: sourceUri.toString(), workflowName, inputs, askInputs: false, planned });
        const early = await Promise.race([
            begun.then(() => undefined),
            started.then(result => (result && typeof result === 'object' && 'error' in result
                ? String((result as { error: unknown }).error)
                : 'it ended before its process started.'))
        ]);
        if (!ended) {
            this.runStartListeners.delete(onStart!);
            return `The run did not start: ${early ?? 'it ended before its process started.'}`;
        }
        return this.describeRunEnd(await ended, workflowName, waitMs);
    }

    /** The end of the run in progress or the next one, or `undefined` after `waitMs`. */
    private nextRunEnd(waitMs: number): Promise<RunEnd | undefined> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.runEndListeners.delete(listener);
                resolve(undefined);
            }, waitMs);
            const listener = (end: RunEnd): void => {
                clearTimeout(timer);
                this.runEndListeners.delete(listener);
                resolve(end);
            };
            this.runEndListeners.add(listener);
        });
    }

    private async describeRunEnd(end: RunEnd | undefined, workflowName: string | undefined, waitMs: number): Promise<string> {
        const which = workflowName ? `The run of ${workflowName}` : 'The run';
        if (!end) {
            return `${which} is still going after ${Math.round(waitMs / 1000)} s: the diagram shows it as it runs, and the chat's Run tab its log. `
                + 'Call run_workflow again on the file to wait for it to end.';
        }
        if (end.kind === 'stopped') {
            return `${which} was stopped.`;
        }
        if (end.kind === 'failed') {
            return `${which} failed: ${end.headline}${end.runDir ? ` Its records are in ${end.runDir}.` : ''} `
                + 'The user is offered to have it looked at; after a fix, resume_failed_run resumes it from where it failed.';
        }
        const outputs = end.runDir ? await this.runOutputs(end.runDir) : [];
        if (!end.runDir) {
            return `${which} finished.`;
        }
        return outputs.length > 0
            ? `${which} finished. Its outputs, one file per workflow output:\n${outputs.map(file => `- ${file}`).join('\n')}`
            : `${which} finished, but made no output: an input without a token, or a node that never fired. Its records are in ${end.runDir}.`;
    }

    /** The files a run made for the workflow's outputs: its directory less the run's own records. */
    private async runOutputs(runDir: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(runDir, { withFileTypes: true });
            return entries
                .filter(entry => entry.isFile() && !entry.name.startsWith('run.'))
                .map(entry => path.join(runDir, entry.name))
                .sort();
        } catch {
            return [];
        }
    }

    private inputMemoryKey(sourceUri: vscode.Uri, workflowName: string | undefined, input: string): string {
        return `${sourceUri.toString()}#${workflowName ?? ''}#${input}`;
    }

    /**
     * Ask for the value of one input of the run: a file for a `File` input, text
     * otherwise, offering the value given last time. `undefined` when the person
     * cancelled the run; an empty string runs it with no token on that input.
     */
    private async askRunInput(
        sourceUri: vscode.Uri,
        workflowName: string | undefined,
        input: { name: string; type?: string },
        index: number,
        count: number
    ): Promise<string | undefined> {
        const last = this.lastInputValues.get(this.inputMemoryKey(sourceUri, workflowName, input.name));
        const title = `Run ${workflowName ?? path.basename(sourceUri.fsPath)}: input ${index + 1} of ${count}`;
        if (/(^|\.)File$/.test((input.type ?? '').trim())) {
            const picked = await vscode.window.showOpenDialog({
                title: `${title}, '${input.name}' (a file)`,
                openLabel: `Use as ${input.name}`,
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                defaultUri: last ? vscode.Uri.file(last) : vscode.Uri.file(path.dirname(sourceUri.fsPath))
            });
            return picked?.[0]?.fsPath;
        }
        return vscode.window.showInputBox({
            title,
            prompt: `The value of '${input.name}'${input.type ? ` (${input.type})` : ''}. Empty: no token on that input.`,
            value: last ?? '',
            ignoreFocusOut: true
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

        let workflowName = typeof args?.workflowName === 'string' && args.workflowName.trim() ? args.workflowName.trim() : undefined;
        const namespaceName = typeof args?.namespaceName === 'string' && args.namespaceName.trim() ? args.namespaceName.trim() : undefined;

        // A new run (a resumed one replays its own): the workflow the diagram
        // shows when the caller named none -- the command palette names none,
        // and a file that imports a workflow defines two -- and a value for
        // each of its inputs, asked for, since a run without them makes no
        // token there and "finishes" with nothing to show.
        const inputArgs: string[] = [];
        const resuming = typeof args?.resumeFrom === 'string' && args.resumeFrom.trim() !== '';
        // A namespace's run is not the diagram's workflow: its inputs are not the plan's.
        const namespaceOnly = Boolean(namespaceName) && !workflowName;
        if (!resuming && !namespaceOnly && this.config.planRun) {
            if (this.askingForInputs) {
                const message = 'A run is waiting for its inputs: answer or cancel it first.';
                void vscode.window.showWarningMessage(message);
                return { error: message };
            }
            this.askingForInputs = true;
            try {
                const planned = args?.planned ?? await this.config.planRun(sourceUri, workflowName).catch(() => undefined);
                if (!workflowName && !namespaceName && planned?.workflowName) {
                    workflowName = planned.workflowName;
                }
                const inputs = planned?.inputs ?? [];
                for (const [index, input] of inputs.entries()) {
                    const given = args?.inputs?.[input.name];
                    const value = given !== undefined
                        ? String(given)
                        : args?.askInputs === false
                            ? ''
                            : await this.askRunInput(sourceUri, workflowName, input, index, inputs.length);
                    if (value === undefined) {
                        return { error: `Run cancelled: no value was given for the input '${input.name}'.` };
                    }
                    if (value !== '') {
                        this.lastInputValues.set(this.inputMemoryKey(sourceUri, workflowName, input.name), value);
                        inputArgs.push('--input', `${input.name}=${runInputValue(value, input.type)}`);
                    }
                }
            } finally {
                this.askingForInputs = false;
            }
        }

        const runOutDir = await this.resolveRunOutDir(sourceUri);
        if (!runOutDir) {
            vscode.window.showErrorMessage(`Cannot resolve ${this.config.settingsNamespace}.${this.config.runOutputDirSettingKey} (no workspace folder found).`);
            return { error: `Cannot resolve ${this.config.settingsNamespace}.${this.config.runOutputDirSettingKey} (no workspace folder found).` };
        }

        const isPython = sourceUri.fsPath.endsWith('.py');
        // The run root and the CLI by the rules `runCli` starts a product's CLI by too (`cli-invocation.ts`).
        const leftOut: string[] = [];
        const cli = await resolveCliInvocation(this.config, sourceUri, isPython, message => leftOut.push(message));
        if (!cli) {
            const message = noCliCommandMessage(this.config);
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
        cliArgs.push(...inputArgs);

        // Resume a run at a step the stepper shows, or before a node's last
        // firing: the firings up to it are replayed by the runtime, not run.
        const resumeFrom = typeof args?.resumeFrom === 'string' && args.resumeFrom.trim() ? args.resumeFrom.trim() : undefined;
        if (resumeFrom) {
            if (!this.config.cliResumeArgs) {
                const message = 'This runtime cannot resume a run at a step.';
                vscode.window.showErrorMessage(message);
                return { error: message };
            }
            const resolved = await resumeStepFor(resumeFrom, {
                atStep: args?.atStep,
                atLastStep: args?.resumeAtLastStep === true,
                actor: typeof args?.resumeAtActor === 'string' && args.resumeAtActor.trim() ? args.resumeAtActor.trim() : undefined
            });
            if ('error' in resolved) {
                vscode.window.showErrorMessage(resolved.error);
                return { error: resolved.error };
            }
            cliArgs.push(...this.config.cliResumeArgs(resumeFrom, resolved.step));
            output.appendLine(`[wf-lang] Resuming ${path.basename(resumeFrom)} at step ${resolved.step}`);
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

        // The ACP connector and the permission policy, from the shell's settings.
        if (this.config.acpConnectorSettingKey) {
            const connector = (wfConfig.get<string>(this.config.acpConnectorSettingKey, '') ?? '').trim();
            if (connector) {
                cliArgs.push('--acp-connector', connector);
            }
        }
        if (this.config.acpPermissionsSettingKey) {
            const permissions = (wfConfig.get<string>(this.config.acpPermissionsSettingKey, '') ?? '').trim();
            if (permissions) {
                cliArgs.push('--agent-cli-acp-permissions', permissions);
            }
        }

        // The human port: the run's questions come in on a Unix socket this
        // driver listens on, and go to the host's `askUser` or a VS Code prompt.
        const elicitSocketPath = this.config.elicitSocket !== false && process.platform !== 'win32'
            ? await this.startElicitSocket(sourceUri.toString())
            : undefined;
        if (elicitSocketPath) {
            cliArgs.push('--elicit-socket', elicitSocketPath);
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
        // Best-effort; the file-polling overlay above remains the fallback. A stopped
        // (killed) or crashed run never closes its own stream, and the diagram's chat
        // would show its agents streaming for good: the forwarder closes it for them.
        let streamForwarder: RunStreamForwarder | undefined;
        let streamEventCount = 0;
        // Permanent, ungated host breadcrumbs (console.log so a webview/console
        // paste captures them — the extension host relays console.log). Every hop
        // of the run-stream pipeline logs, mirroring the client-side `[wf-lang
        // overlay]` breadcrumbs, so the dying hop is visible with zero inference.
        const hostLog = (message: string): void => {
            // eslint-disable-next-line no-console
            console.log(`[wf-lang overlay] host: ${message}`);
        };
        const startStream = (): void => {
            // A run of this diagram's that the IDE was following from a terminal gives way.
            this.stopFollowedRun(sourceUri.toString(), 'a run started from the IDE');
            const discoveryFilePath = path.join(runOutDir, 'run.wf-stream.live.json');
            hostLog(`constructing RunEventStreamClient discovery=${discoveryFilePath}`);
            streamForwarder = new RunStreamForwarder({
                discoveryFilePath,
                // Route through the neutral execution-overlay seam; the core host bridge
                // resolves the target clientId and dispatches (dropping if the diagram is
                // closed — history is replayed on connect, see the file header).
                emit: (events) => {
                    hostLog(`flush ${events.length} events -> emitEvents(${sourceUri.toString()})`);
                    this.host.overlay.emitEvents(sourceUri.toString(), events);
                },
                onEvent: (event) => hostLog(`SSE event #${++streamEventCount} type=${String(event.type)}`),
                onLog: (m) => {
                    hostLog(m);
                    output.appendLine(`[wf-lang ${m}`);
                },
            });
            streamForwarder.start();
        };
        const stopStream = (): void => {
            streamForwarder?.stop();
            streamForwarder = undefined;
            this.stopElicitSocket();
        };

        // The end of what the run wrote to stderr -- its traceback, when it fails.
        let stderrTail = '';
        const exitCode = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false
            },
            async () => {
                output.appendLine(`[wf-lang] cwd=${cli.cwd}`);
                for (const [name, value] of Object.entries(cli.variables ?? {})) {
                    output.appendLine(`[wf-lang] ${name}=${value}`);
                }
                for (const message of leftOut) {
                    output.appendLine(`[wf-lang] ${message}`);
                }
                output.appendLine(`[wf-lang] ${cli.cmd} ${cliArgs.map(a => JSON.stringify(a)).join(' ')}`);
                output.appendLine('');
                if (liveGlowEnabled) {
                    refreshTimer = setInterval(() => void refreshDiagram(), 400);
                }
                startStream();
                return await this.spawnRun(
                    { cmd: cli.cmd, args: cliArgs, cwd: cli.cwd, env: cliProcessEnv(cli.variables) },
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
                        for (const listener of [...this.runStartListeners]) {
                            listener();
                        }
                    },
                    () => this.activeRun?.stopRequested === true,
                    (text) => {
                        stderrTail = appendTail(stderrTail, text);
                    }
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
            this.tellRunEnd({ kind: 'stopped' });
            vscode.window.showInformationMessage('Workflow run canceled.');
            return { ok: false, canceled: true };
        }

        if (exitCode !== 0) {
            // Show where it failed on the diagram, then say so -- and, with a
            // chat behind the diagram, offer to have it looked at.
            await refreshDiagram(true);
            const runDir = await this.findLatestRunDir({
                baseOutDir: runOutDir,
                sourcePath: sourceUri.fsPath,
                startedAfterMs: runStartedAtMs,
                workflowName
            });
            const failure = runDir ? await this.readRunFailure(runDir) : undefined;
            if (runDir) {
                // What the agent's fix resumes (`resume_failed_run`).
                this.failedRuns.set(sourceUri.fsPath, { sourceUri, workflowName, runDir, failure });
                this.lastFailedFile = sourceUri.fsPath;
            }
            this.tellRunEnd({ kind: 'failed', headline: failureHeadline(failure, exitCode), runDir });
            void this.reportFailure({ sourceUri, workflowName, failure, exitCode, stderrTail, runDir, output });
            return { error: failureHeadline(failure, exitCode) };
        }

        // Refresh diagram so overlay decorations can pick up the new run artifacts.
        await refreshDiagram(true);
        // It ran clean: nothing left to resume for it.
        this.failedRuns.delete(sourceUri.fsPath);

        const queueTracePath = await this.findLatestQueueTracePath({
            baseOutDir: runOutDir,
            sourcePath: sourceUri.fsPath,
            startedAfterMs: runStartedAtMs,
            workflowName
        });
        if (this.runEndListeners.size > 0) {
            this.tellRunEnd({
                kind: 'clean',
                runDir: await this.findLatestRunDir({ baseOutDir: runOutDir, sourcePath: sourceUri.fsPath, startedAfterMs: runStartedAtMs, workflowName })
            });
        }

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
