import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { OpencodeHttpClient, type OpencodeMessage } from "./opencode-http.js";

interface TerminalState {
  process: ChildProcess;
  output: string;
  byteLimit?: number;
  truncated: boolean;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
  exitWaiters: Array<
    (status: { exitCode?: number | null; signal?: string | null }) => void
  >;
}

/** Reject a promise after `ms` with an actionable message (used to guard ACP
 *  calls that can hang forever when an attached MCP server misbehaves). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface ModelOption {
  /** Opaque model id used as the config value, e.g. "deepseek/deepseek-chat". */
  id: string;
  /** Human-readable label, e.g. "DeepSeek/DeepSeek Chat". */
  name: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  mode: "plan" | "build";
  availableModes: string[];
  provider?: string;
  /** Currently selected model id for this session (the `model` config option). */
  model?: string;
  /** Absolute path of the workflow file this session is scoped to. */
  workflowFile?: string;
  /** mtime (ms) of the workflow content last injected as context, if any. */
  injectedWorkflowMtimeMs?: number;
}

/**
 * One ordered segment of an assistant turn: a run of streamed text, or a tool
 * call. Captured in stream order so a reloaded session renders text and tool
 * chips exactly where they occurred (no flattening into one text blob).
 */
export type TurnPart =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; title: string; status?: string };

export interface ACPClientEvents {
  sessionUpdate: (notification: SessionNotification) => void;
  modeChanged: (data: { sessionId: string; mode: "plan" | "build" }) => void;
  providerChanged: (data: { sessionId: string; provider: string }) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
  /** Fired when a prompt turn finishes, with the full assistant reply text and
   *  the ordered structure of the turn (text segments interleaved with tool
   *  calls) so it can be persisted and later restored faithfully. */
  turnComplete: (data: {
    sessionId: string;
    text: string;
    thinking?: string;
    model?: string;
    parts?: TurnPart[];
  }) => void;
  /** Fired when the agent asks the user to approve a tool call. */
  permissionRequest: (data: {
    requestId: string;
    title: string;
    kind?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
  }) => void;
}

export declare interface ACPClientService {
  on<K extends keyof ACPClientEvents>(
    event: K,
    listener: ACPClientEvents[K],
  ): this;
  emit<K extends keyof ACPClientEvents>(
    event: K,
    ...args: Parameters<ACPClientEvents[K]>
  ): boolean;
}

/**
 * ACP Client Service for communicating with opencode via ACP protocol.
 * Uses TypeScript SDK exclusively (no external-process fallback or CLI mode).
 */
export class ACPClientService extends EventEmitter {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sessions: Map<string, SessionInfo> = new Map();
  /**
   * Sessions already loaded into the agent on the CURRENT connection. Resuming a
   * session re-spawns its MCP servers (and their language subprocesses) — several
   * seconds — so once a session is live we skip the redundant re-attach when the
   * user switches back to it. Reset on disconnect, since a new connection starts
   * with no sessions resident.
   */
  private loadedSessionIds: Set<string> = new Set();
  private isConnected: boolean = false;

  /**
   * opencode's HTTP API, served by the same `opencode acp` process on a port we
   * pin at spawn time. Used for capabilities ACP doesn't expose (revert /
   * unrevert / message-id listing). Null until the process is spawned.
   */
  private http: OpencodeHttpClient | null = null;

  /**
   * Catalog of selectable models, captured from the most recent session's
   * `model` config option. opencode exposes models as a per-session config
   * option (the catalog is identical across sessions), so we cache it here to
   * answer model-list queries that arrive without a session context.
   */
  private modelOptions: ModelOption[] = [];

  /** Workspace cwd captured at start(), used to warm up the model catalog. */
  private workspaceCwd: string | undefined;

  /** Per-session accumulator for the in-progress assistant reply text. */
  private turnText: Map<string, string> = new Map();
  /** Accumulated assistant reasoning ("thinking") for the in-flight turn, per session. */
  private turnThinking: Map<string, string> = new Map();
  /** Ordered text/tool structure of the in-flight turn, per session (see TurnPart). */
  private turnParts: Map<string, TurnPart[]> = new Map();

  /** Pending permission requests awaiting a UI decision, keyed by requestId. */
  private pendingPermissions: Map<string, (optionId: string | null) => void> =
    new Map();
  private permissionCounter = 0;

  /** Terminals the agent has created via the ACP terminal capability. */
  private terminals: Map<string, TerminalState> = new Map();
  private terminalCounter = 0;

  /**
   * Optional provider that returns the resolved workflow graph (as a JSON
   * string) for a given workflow file. Supplied by the extension layer (which
   * knows how to invoke the edit backend). Injected into session context alongside
   * the source so the agent understands the workflow structure.
   */
  private workflowGraphProvider?: (
    workflowFile: string,
  ) => Promise<string | undefined>;

  /**
   * Domain "skill" injected into the session context — runtime vocabulary,
   * authoring workflow, and an idiomatic component template (profile-specific).
   */
  private chatSkill?: string;

  /**
   * Optional per-file provider that returns a diagram-tool usage hint (id /
   * sessionId semantics) to fold into the session context. Supplied by the
   * extension layer only when the diagram MCP server is actually advertised to
   * the agent, so the guidance appears iff the tools are reachable. Returns
   * undefined when there is nothing to add.
   */
  private glspToolHintProvider?: (workflowFile?: string) => string | undefined;

  /**
   * MIME type for the source file attached to each session's context, supplied by
   * the profile (an opaque, consumer-owned value). Falls back to `text/plain`.
   */
  private sourceMimeType?: string;

  /**
   * Largest source file injected into a session, in bytes.
   *
   * The file is attached whole on the first turn of every session. That is fine
   * for a hand-written diagram and fatal for a generated one: a 12 MB MLIR
   * module exhausts the context before the user's question is even read, and the
   * session dies with "too large to compact" — an error about the transport
   * rather than about anything the agent could have done differently. Past this
   * bound the head is sent with a note saying what was left out and how to get
   * it; the profile's own tools are the intended route to the rest.
   */
  private sourceMaxBytes = 256 * 1024;

  /**
   * Optional provider for the MCP servers to attach to a new session, so the
   * agent gets first-class workflow tools (list/create task types, validate,
   * connect, …). Supplied by the extension layer.
   */
  private mcpServersProvider?: (workflowFile?: string) => any[];

  /** Extra per-turn context blocks (injected every prompt, not mtime-deduped). */
  private turnContextBlocksProvider?: (
    workflowFile?: string,
  ) => Promise<any[]> | any[];

  /**
   * Start the ACP client and spawn the opencode subprocess
   */
  /**
   * Resolve the opencode executable and a PATH-augmented environment.
   *
   * Order of preference:
   *  1. WORKFLOW_OPENCODE_PATH env var (explicit override).
   *  2. A binary found in common install locations (notably ~/.opencode/bin,
   *     which is opencode's default and is rarely on a GUI app's PATH).
   *  3. Bare 'opencode' (resolved via the inherited PATH).
   *
   * In all cases the child's PATH is augmented with those install dirs so
   * opencode and anything it shells out to can be found.
   */
  private resolveOpencodeCommand(): {
    command: string;
    env: NodeJS.ProcessEnv;
  } {
    const home = os.homedir();
    const binName = process.platform === "win32" ? "opencode.cmd" : "opencode";
    const candidateDirs = [
      path.join(home, ".opencode", "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    const sep = process.platform === "win32" ? ";" : ":";
    const existingPath = env.PATH ?? env.Path ?? "";
    const merged = [...candidateDirs, existingPath].filter(Boolean).join(sep);
    env.PATH = merged;
    if ("Path" in env) env.Path = merged;

    const override = process.env.WORKFLOW_OPENCODE_PATH;
    if (override && existsSync(override)) {
      return { command: override, env };
    }

    for (const dir of candidateDirs) {
      const full = path.join(dir, binName);
      if (existsSync(full)) {
        return { command: full, env };
      }
    }

    return { command: binName, env };
  }

  async start(cwd: string): Promise<void> {
    if (this.isConnected) {
      throw new Error("ACP client is already connected");
    }
    this.workspaceCwd = cwd;

    try {
      // Resolve the opencode binary. The VS Code extension host frequently does
      // NOT inherit the user's shell PATH (e.g. when launched from a GUI), so a
      // bare 'opencode' can fail with ENOENT even though it works in a terminal.
      const { command, env } = this.resolveOpencodeCommand();

      // `opencode acp` also serves the full HTTP API. Pin it to a free port so
      // we can drive HTTP-only capabilities (revert/unrevert/message ids)
      // against the same process the ACP session uses.
      const httpPort = await this.findFreePort();
      this.http = new OpencodeHttpClient(`http://127.0.0.1:${httpPort}`);

      // Spawn opencode acp subprocess
      this.process = spawn(
        command,
        ["acp", "--hostname", "127.0.0.1", "--port", String(httpPort)],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        },
      );

      // Handle process errors
      this.process.on("error", (error) => {
        this.emit("error", error);
        this.handleDisconnect();
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          this.emit(
            "error",
            new Error(`OpenCode process exited with code ${code}`),
          );
        }
        this.handleDisconnect();
      });

      // Create bidirectional stream using ndjson format
      // Convert Node.js streams to Web API streams
      const stdoutWeb = Readable.toWeb(
        this.process.stdout!,
      ) as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
      const stdinWeb = Writable.toWeb(
        this.process.stdin!,
      ) as unknown as import("node:stream/web").WritableStream<Uint8Array>;
      const stream = ndJsonStream(stdinWeb, stdoutWeb);

      // Initialize client-side connection
      this.connection = new ClientSideConnection(
        (agent) => this.createClientHandler(agent),
        stream,
      );

      // Initialize with capabilities
      await this.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: "dialogram",
          version: "0.0.1",
        },
      });

      this.isConnected = true;
      this.emit("connected");
    } catch (error) {
      this.handleDisconnect();
      throw new Error(
        `Failed to start ACP client: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a new session
   */
  async createSession(
    cwd: string,
    name?: string,
    mode: "plan" | "build" = "build",
    workflowFile?: string,
  ): Promise<string> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    // newSession spawns/connects the session's MCP servers and waits for their
    // handshake; a misbehaving server would otherwise hang here forever, so
    // fail fast with an actionable error instead.
    const response = await withTimeout(
      this.connection.newSession({
        cwd,
        mcpServers: (this.mcpServersProvider?.(workflowFile) ?? []) as any,
      }),
      30000,
      "Timed out creating the chat session (an MCP tool server may have failed to start). " +
        "Disable the chat MCP tools in settings if this persists.",
    );
    const sessionId = response.sessionId;

    const sessionInfo: SessionInfo = {
      id: sessionId,
      name: name || `Session ${this.sessions.size + 1}`,
      cwd,
      createdAt: Date.now(),
      mode,
      availableModes: ["plan", "build"],
      provider: undefined,
      workflowFile,
    };

    this.sessions.set(sessionId, sessionInfo);
    // A newly created session is already resident (with its MCP servers) on this
    // connection — no need to re-attach if the user later switches back to it.
    this.loadedSessionIds.add(sessionId);

    // opencode 1.17+ returns the available modes and models as `configOptions`
    // on the session response (the old top-level `modes` field is gone).
    this.applyConfigOptions(sessionInfo, (response as any).configOptions);

    // Align the session with the requested mode if it differs from the default.
    if (
      sessionInfo.mode !== mode &&
      sessionInfo.availableModes.includes(mode)
    ) {
      await this.setSessionMode(sessionId, mode);
    }

    return sessionId;
  }

  /**
   * Update a session's mode/model state from an ACP `configOptions` array
   * (as returned by session/new and session/set_config_option). Also refreshes
   * the cached model catalog. Tolerant of missing/empty input.
   */
  private applyConfigOptions(
    session: SessionInfo,
    configOptions: any[] | null | undefined,
  ): void {
    if (!Array.isArray(configOptions)) return;

    const modeOption = configOptions.find(
      (o) => o?.id === "mode" || o?.category === "mode",
    );
    if (modeOption) {
      const values = (modeOption.options || [])
        .map((o: any) => o?.value)
        .filter((v: any): v is string => typeof v === "string");
      if (values.length) session.availableModes = values;
      if (
        modeOption.currentValue === "plan" ||
        modeOption.currentValue === "build"
      ) {
        session.mode = modeOption.currentValue;
      }
    }

    const modelOption = configOptions.find(
      (o) => o?.id === "model" || o?.category === "model",
    );
    if (modelOption) {
      if (typeof modelOption.currentValue === "string") {
        session.model = modelOption.currentValue;
      }
      const options: ModelOption[] = (modelOption.options || [])
        .filter((o: any) => typeof o?.value === "string")
        .map((o: any) => ({ id: o.value, name: o.name || o.value }));
      if (options.length) this.modelOptions = options;
    }
  }

  /**
   * Set the mode for a session (plan or build)
   */
  async setSessionMode(
    sessionId: string,
    mode: "plan" | "build",
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.availableModes.includes(mode)) {
      throw new Error(`Mode '${mode}' is not available for this session`);
    }

    // opencode 1.17+ drives mode through the generic config-option API.
    const response = await this.connection.setSessionConfigOption({
      sessionId,
      configId: "mode",
      value: mode,
    });
    this.applyConfigOptions(session, (response as any)?.configOptions);

    session.mode = mode;
    this.emit("modeChanged", { sessionId, mode });
  }

  /**
   * Get the current mode for a session
   */
  getSessionMode(sessionId: string): "plan" | "build" {
    const session = this.sessions.get(sessionId);
    return session?.mode || "build";
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<SessionInfo[]> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    const response = await this.connection.listSessions({});
    return response.sessions.map((s) => {
      const existing = this.sessions.get(s.sessionId);
      if (existing) {
        return existing;
      }

      // Create session info for sessions we didn't create
      const sessionInfo: SessionInfo = {
        id: s.sessionId,
        name: s.title || `Session ${s.sessionId.slice(0, 8)}`,
        cwd: s.cwd,
        createdAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.now(),
        mode: "build",
        availableModes: ["plan", "build"],
      };
      this.sessions.set(s.sessionId, sessionInfo);
      return sessionInfo;
    });
  }

  /**
   * Load an existing session
   */
  async loadSession(
    sessionId: string,
    cwd?: string,
    workflowFile?: string,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    // Already resident on this connection — re-attaching would re-spawn its MCP
    // servers (and their language subprocesses), a multi-second cost, for no gain.
    if (this.loadedSessionIds.has(sessionId)) {
      return;
    }

    let session = this.sessions.get(sessionId);

    // After an extension restart our in-memory map is empty (it's only filled by
    // createSession). Sync with the agent so sessions created in a prior process
    // are known again before we try to load one.
    if (!session) {
      try {
        await this.listSessions();
        session = this.sessions.get(sessionId);
      } catch {
        // session/list may be unsupported; fall back to the caller-provided cwd.
      }
    }

    const loadCwd = session?.cwd ?? cwd;
    if (!loadCwd) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const wf = session?.workflowFile ?? workflowFile;

    // Re-attach the same MCP servers (e.g. the runtime's MCP server) the session was
    // created with — otherwise a resumed session loses its tools.
    await withTimeout(
      this.connection.loadSession({
        sessionId,
        cwd: loadCwd,
        mcpServers: (this.mcpServersProvider?.(wf) ?? []) as any,
      }),
      30000,
      "Timed out restoring the chat session (an MCP tool server may have failed to start). " +
        "Disable the chat MCP tools in settings if this persists.",
    );
    // Resident now — subsequent switches back to this session skip the re-attach.
    this.loadedSessionIds.add(sessionId);

    // Make sure the session is tracked locally so later mode/model/prompt calls
    // can find it.
    if (!session) {
      this.sessions.set(sessionId, {
        id: sessionId,
        name: `Session ${sessionId.slice(0, 8)}`,
        cwd: loadCwd,
        createdAt: Date.now(),
        mode: "build",
        availableModes: ["plan", "build"],
        workflowFile: wf,
      });
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    await this.connection.deleteSession({ sessionId });
    this.sessions.delete(sessionId);
    this.loadedSessionIds.delete(sessionId);
  }

  /** Pick a free localhost TCP port for opencode's HTTP server. */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() =>
          port ? resolve(port) : reject(new Error("Could not allocate a port")),
        );
      });
    });
  }

  // ── Revert / unrevert (opencode HTTP API) ──────────────────────────────────

  /** List a session's messages with their opencode ids (for revert targeting). */
  async getMessagesWithIds(sessionId: string): Promise<OpencodeMessage[]> {
    if (!this.http) {
      return [];
    }
    return this.http.listMessages(sessionId);
  }

  /**
   * Revert the session to before `messageID` — undoes that message, all later
   * messages, and their file changes.
   */
  async revertToMessage(sessionId: string, messageID: string): Promise<void> {
    if (!this.http) {
      throw new Error("opencode HTTP API is not available");
    }
    await this.http.revert(sessionId, messageID);
  }

  /** Restore whatever the most recent revert undid. */
  async unrevert(sessionId: string): Promise<void> {
    if (!this.http) {
      throw new Error("opencode HTTP API is not available");
    }
    await this.http.unrevert(sessionId);
  }

  /** Whether the session is currently in a reverted state (drives redo UI). */
  async getRevertState(sessionId: string): Promise<boolean> {
    if (!this.http) {
      return false;
    }
    return this.http.isReverted(sessionId);
  }

  /**
   * Send a prompt to the agent
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    const blocks: any[] = [];
    const contextBlocks = await this.buildWorkflowContextBlocks(sessionId);
    blocks.push(...contextBlocks);
    if (this.turnContextBlocksProvider) {
      try {
        const turnBlocks = await this.turnContextBlocksProvider(
          this.sessions.get(sessionId)?.workflowFile,
        );
        if (Array.isArray(turnBlocks)) {
          blocks.push(...turnBlocks);
        }
      } catch {
        // Per-turn context is best-effort.
      }
    }
    blocks.push({ type: "text", text: prompt });

    // Reset the assistant turn buffers so we can capture the full reply +
    // reasoning + ordered part structure for this turn.
    this.turnText.set(sessionId, "");
    this.turnThinking.set(sessionId, "");
    this.turnParts.set(sessionId, []);

    await this.connection.prompt({
      sessionId,
      prompt: blocks,
    });

    // The turn is complete; emit the accumulated assistant text + thinking for persistence.
    const text = this.turnText.get(sessionId) ?? "";
    const thinking = this.turnThinking.get(sessionId) ?? "";
    const parts = this.turnParts.get(sessionId) ?? [];
    this.turnText.delete(sessionId);
    this.turnThinking.delete(sessionId);
    this.turnParts.delete(sessionId);
    const model = this.sessions.get(sessionId)?.model;
    this.emit("turnComplete", {
      sessionId,
      text,
      thinking: thinking || undefined,
      model,
      parts,
    });
  }

  /**
   * Build ACP content blocks that load the session's workflow file into the
   * agent's context, so it can answer questions about "this workflow" without
   * searching the project. The content is embedded once per session and
   * re-injected only when the file changes (tracked by mtime), to keep the
   * agent's view fresh without re-sending unchanged content every turn.
   */
  private async buildWorkflowContextBlocks(sessionId: string): Promise<any[]> {
    const session = this.sessions.get(sessionId);
    if (!session?.workflowFile) return [];

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(session.workflowFile);
    } catch {
      return [];
    }

    if (session.injectedWorkflowMtimeMs === stat.mtimeMs) {
      return []; // unchanged since last injection
    }

    // Nothing is read when the attachment is off: the point of disabling it is a
    // file too big to hold, so reading it to throw it away is the same mistake.
    if (this.sourceMaxBytes === 0) {
      session.injectedWorkflowMtimeMs = stat.mtimeMs;
      return this.sourceOmittedBlocks(session.workflowFile, stat.size);
    }

    let content: string;
    try {
      content = await fs.readFile(session.workflowFile, "utf-8");
    } catch {
      return [];
    }

    // Truncated at the head: the top of a diagram source is its declarations —
    // the module, its symbols, its imports — which is the orientation the rest of
    // this block is for. The note names the cost and the alternative, so the
    // agent's next move is a tool call rather than a read of the same file.
    let truncationNote = "";
    if (Buffer.byteLength(content, "utf-8") > this.sourceMaxBytes) {
      const shown = content.slice(0, this.sourceMaxBytes);
      const totalMb = (stat.size / (1024 * 1024)).toFixed(1);
      truncationNote =
        `\n\nNOTE: "${path.basename(session.workflowFile)}" is ${totalMb} MB; only its first ` +
        `${Math.round(this.sourceMaxBytes / 1024)} KB is attached above. Do NOT read the file to ` +
        `see the rest — it will exhaust the context. Use the diagram tools, or read only the ` +
        `specific line range you need.`;
      content = shown;
    }

    const reinjected = session.injectedWorkflowMtimeMs !== undefined;
    const reinjectedFlag = reinjected;
    session.injectedWorkflowMtimeMs = stat.mtimeMs;
    const name = path.basename(session.workflowFile);

    // Generic framing + the runtime's domain "skill" (profile-specific). Falls
    // back to the default wording only if no skill was supplied, to preserve behavior.
    const framing =
      `Context for this conversation: the user is editing the file "${name}" ` +
      `(${session.workflowFile}) in a visual diagram editor. The file below and the ` +
      `resolved graph are the authoritative definition of the diagram — when the user ` +
      `refers to "this", "the workflow/network", or asks about its nodes, treat them as ` +
      `the source of truth and do not search other files unless explicitly asked.`;
    const skill =
      this.chatSkill ??
      `You also have MCP tools: read tools (list_task_types, get_graph, validate_workflow) and, ` +
        `when the diagram MCP server is available, GLSP diagram tools (create-task-type, create-nodes, ` +
        `create-edges, modify-nodes, delete-elements). For STRUCTURAL edits prefer the GLSP tools when ` +
        `present — their edits go through the editor's undo stack. To add a BRAND-NEW task: call ` +
        `create-task-type to scaffold it, then edit the generated @task class to implement its ` +
        `behavior, and verify with get_graph.`;

    // A diagram-tool usage hint, present only when the extension layer says the
    // diagram MCP server is advertised to the agent.
    const toolHint = this.glspToolHintProvider?.(session.workflowFile);

    const blocks: any[] = [
      {
        type: "text",
        text:
          `${framing}\n\n${skill}` +
          (toolHint ? `\n\n${toolHint}` : "") +
          (reinjectedFlag ? "\n\n(Updated file content follows.)" : ""),
      },
      {
        type: "resource",
        resource: {
          uri: `file://${session.workflowFile}`,
          mimeType: this.sourceMimeType ?? "text/plain",
          text: content,
        },
      },
    ];
    if (truncationNote) {
      blocks.push({ type: "text", text: truncationNote });
    }

    // Attach the resolved graph (nodes/edges/ports/agents) when available, so
    // the agent sees the concrete structure, not just the source.
    if (this.workflowGraphProvider) {
      try {
        const graphJson = await this.workflowGraphProvider(
          session.workflowFile,
        );
        if (graphJson) {
          blocks.push({
            type: "text",
            text:
              "The resolved workflow graph (the exact nodes, edges and ports rendered in the " +
              "diagram) follows as JSON. Prefer it when reasoning about connectivity and structure.",
          });
          blocks.push({
            type: "resource",
            resource: {
              uri: `file://${session.workflowFile}.graph.json`,
              mimeType: "application/json",
              text: graphJson,
            },
          });
        }
      } catch {
        // Graph is best-effort; the source file alone is still useful.
      }
    }

    return blocks;
  }

  /**
   * Supply a resolver for the workflow graph JSON (used for context injection).
   */
  setWorkflowGraphProvider(
    provider: (workflowFile: string) => Promise<string | undefined>,
  ): void {
    this.workflowGraphProvider = provider;
  }

  /**
   * Supply the runtime's chat "skill" (domain vocabulary + idiomatic component
   * template) injected into each session's context.
   */
  setChatSkill(skill?: string): void {
    this.chatSkill = skill;
  }

  /**
   * Supply a per-file diagram-tool usage hint folded into the session context.
   * The extension layer returns text only when the diagram MCP server is
   * advertised to the agent (and undefined otherwise).
   */
  setGlspToolHintProvider(
    provider?: (workflowFile?: string) => string | undefined,
  ): void {
    this.glspToolHintProvider = provider;
  }

  /** Supply the source-file MIME type attached to each session's context. */
  /**
   * What stands in for the source when it is not attached: what the file is, how
   * big, and where to get the parts of it that matter.
   */
  private sourceOmittedBlocks(workflowFile: string, size: number): any[] {
    const megabytes = (size / (1024 * 1024)).toFixed(1);
    return [
      {
        type: "text",
        text:
          `Context for this conversation: the user is editing "${path.basename(workflowFile)}" ` +
          `(${workflowFile}) in a visual diagram editor. The file itself is NOT attached: it is ` +
          `${megabytes} MB, and reading it whole exhausts the context before anything is answered. ` +
          `Use the diagram tools for structure, and read only specific line ranges when you need ` +
          `the source text.` +
          (this.chatSkill ? `\n\n${this.chatSkill}` : ""),
      },
    ];
  }

  /** 0 disables the attachment entirely; undefined keeps the default bound. */
  setSourceMaxBytes(maxBytes?: number): void {
    if (typeof maxBytes === "number" && maxBytes >= 0) {
      this.sourceMaxBytes = maxBytes;
    }
  }

  setSourceMimeType(mimeType?: string): void {
    this.sourceMimeType = mimeType;
  }

  /**
   * Supply the MCP servers to attach to new sessions (agent workflow tools).
   */
  /**
   * Supply extra content blocks injected on EVERY turn (unlike the mtime-deduped
   * workflow context) — e.g. the current diagram selection.
   */
  setTurnContextBlocksProvider(
    provider: (workflowFile?: string) => Promise<any[]> | any[],
  ): void {
    this.turnContextBlocksProvider = provider;
  }

  setMcpServersProvider(provider: (workflowFile?: string) => any[]): void {
    this.mcpServersProvider = provider;
  }

  /**
   * Accumulate the assistant turn from a session/update notification so it can be
   * persisted when the turn completes: reasoning into the thinking buffer, answer
   * text into the text buffer, and — critically — the ordered part structure
   * (text runs interleaved with tool calls) into {@link turnParts} so a reloaded
   * session renders tool chips and text boundaries exactly where they occurred.
   */
  private accumulateTurnText(notification: SessionNotification): void {
    const update: any = (notification as any)?.update;
    const kind = update?.sessionUpdate;
    const sessionId = (notification as any)?.sessionId;
    if (!sessionId) return;

    if (kind === "tool_call" || kind === "tool_call_update") {
      this.recordTurnToolPart(sessionId, update);
      return;
    }

    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk")
      return;
    const content = update.content;
    const text =
      content?.type === "text" && typeof content.text === "string"
        ? content.text
        : "";
    if (!text) return;
    // Reasoning chunks go to the thinking buffer; the answer goes to the text buffer.
    const buffer =
      kind === "agent_thought_chunk" ? this.turnThinking : this.turnText;
    buffer.set(sessionId, (buffer.get(sessionId) ?? "") + text);
    // Reasoning is rendered as its own block, so only answer text contributes to
    // the ordered part structure; append to the trailing text run (or start one).
    if (kind === "agent_message_chunk") {
      const parts = this.turnParts.get(sessionId) ?? [];
      const last = parts[parts.length - 1];
      if (last && last.type === "text") {
        last.text += text;
      } else {
        parts.push({ type: "text", text });
      }
      this.turnParts.set(sessionId, parts);
    }
  }

  /** Upsert a tool-call part (by id) into the in-flight turn's part structure. */
  private recordTurnToolPart(sessionId: string, update: any): void {
    const id = String(
      update?.toolCallId ??
        update?.id ??
        `tc_${this.turnParts.get(sessionId)?.length ?? 0}`,
    );
    // The tool name arrives on the initial tool_call; later status-only updates
    // omit the title, so only overwrite when a title is actually present (else a
    // completed/failed update would drop the name back to the generic fallback).
    const rawTitle = update?.title || update?.kind;
    const title = rawTitle ? String(rawTitle) : undefined;
    const status =
      typeof update?.status === "string" ? update.status : undefined;
    const parts = this.turnParts.get(sessionId) ?? [];
    const existing = parts.find(
      (p): p is Extract<TurnPart, { type: "tool" }> =>
        p.type === "tool" && p.id === id,
    );
    if (existing) {
      if (title !== undefined) existing.title = title;
      if (status !== undefined) existing.status = status;
    } else {
      parts.push({ type: "tool", id, title: title ?? "tool call", status });
    }
    this.turnParts.set(sessionId, parts);
  }

  /**
   * Resolve a pending permission request from the UI. Pass the chosen optionId,
   * or null to cancel/deny.
   */
  respondToPermission(requestId: string, optionId: string | null): void {
    const resolver = this.pendingPermissions.get(requestId);
    if (resolver) {
      resolver(optionId);
    }
  }

  /**
   * Cancel an ongoing prompt
   */
  async cancelPrompt(sessionId: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    await this.connection.cancel({ sessionId });
  }

  /**
   * List available models. opencode exposes models as the per-session `model`
   * config option, so the catalog is empty until a session exists. If we have
   * none yet, warm it up from a throwaway session so the model selector can
   * populate immediately (e.g. on diagram open, before any message is sent).
   */
  async listProviders(): Promise<ModelOption[]> {
    if (!this.modelOptions.length) {
      await this.warmUpModelCatalog();
    }
    return this.modelOptions;
  }

  /**
   * Populate the model catalog from a throwaway session that is created, read,
   * and immediately deleted (so it does not pollute the user's session list).
   * No-op if the catalog is already known or the client is not connected.
   */
  async warmUpModelCatalog(): Promise<void> {
    if (this.modelOptions.length || !this.connection || !this.workspaceCwd) {
      return;
    }
    try {
      const response = await this.connection.newSession({
        cwd: this.workspaceCwd,
        mcpServers: [],
      });
      const probe: SessionInfo = {
        id: response.sessionId,
        name: "catalog-probe",
        cwd: this.workspaceCwd,
        createdAt: Date.now(),
        mode: "build",
        availableModes: ["plan", "build"],
      };
      this.applyConfigOptions(probe, (response as any).configOptions);
      // Clean up — we only needed the model catalog.
      try {
        await this.connection.deleteSession({ sessionId: response.sessionId });
      } catch {
        // best effort
      }
    } catch {
      // Catalog will populate on the first real session instead.
    }
  }

  /**
   * Currently selected model id for a session, if known.
   */
  getSessionModel(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.model;
  }

  /**
   * Set the model for a session via the `model` config option.
   * `providerId` here is the model id (e.g. "deepseek/deepseek-chat").
   */
  async setProvider(sessionId: string, providerId: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP client is not connected");
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const response = await this.connection.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: providerId,
    });
    this.applyConfigOptions(session, (response as any)?.configOptions);

    session.provider = providerId;
    session.model = providerId;
    this.emit("providerChanged", { sessionId, provider: providerId });
  }

  /**
   * Stop the ACP client and clean up
   */
  stop(): void {
    this.handleDisconnect();
  }

  /**
   * Check if the client is connected
   */
  isClientConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Create the client handler for processing agent requests
   */
  private createClientHandler(_agent: Agent): Client {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        this.accumulateTurnText(notification);
        this.emit("sessionUpdate", notification);
      },

      requestPermission: async (
        request: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const options = request.options ?? [];

        // No UI is listening (e.g. headless) → fall back to auto-approve so the
        // agent is never blocked.
        if (
          this.listenerCount("permissionRequest") === 0 ||
          options.length === 0
        ) {
          const allow =
            options.find((o) => o.name.toLowerCase().includes("allow")) ||
            options[0];
          return allow
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }

        const requestId = `perm_${++this.permissionCounter}`;
        const choice = await new Promise<string | null>((resolve) => {
          this.pendingPermissions.set(requestId, resolve);
          this.emit("permissionRequest", {
            requestId,
            title:
              (request.toolCall as any)?.title ??
              (request.toolCall as any)?.rawInput?.command ??
              "Tool call",
            kind: (request.toolCall as any)?.kind,
            options: options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: (o as any).kind,
            })),
          });
        });
        this.pendingPermissions.delete(requestId);

        return choice
          ? { outcome: { outcome: "selected", optionId: choice } }
          : { outcome: { outcome: "cancelled" } };
      },

      readTextFile: async (
        request: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        try {
          const content = await fs.readFile(request.path, "utf-8");
          return {
            content,
          };
        } catch (error) {
          throw new Error(
            `Failed to read file ${request.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      writeTextFile: async (
        request: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        try {
          // Ensure directory exists
          const dir = path.dirname(request.path);
          await fs.mkdir(dir, { recursive: true });

          await fs.writeFile(request.path, request.content, "utf-8");
          return {};
        } catch (error) {
          throw new Error(
            `Failed to write file ${request.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      createTerminal: async (
        request: CreateTerminalRequest,
      ): Promise<CreateTerminalResponse> => {
        const terminalId = `term_${++this.terminalCounter}`;
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const e of (request as any).env ?? []) {
          if (e?.name) env[e.name] = e.value;
        }
        const cwd = (request as any).cwd ?? this.workspaceCwd ?? process.cwd();
        const args: string[] = (request as any).args ?? [];
        // If no explicit args, run the command through a shell so a full command
        // line works; otherwise spawn the executable with its argument list.
        const child = spawn(request.command, args, {
          cwd,
          env,
          shell: args.length === 0,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const state: TerminalState = {
          process: child,
          output: "",
          byteLimit: (request as any).outputByteLimit ?? undefined,
          truncated: false,
          exitWaiters: [],
        };
        const append = (chunk: Buffer) => {
          state.output += chunk.toString();
          if (state.byteLimit && state.output.length > state.byteLimit) {
            state.output = state.output.slice(
              state.output.length - state.byteLimit,
            );
            state.truncated = true;
          }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        const settle = (status: {
          exitCode?: number | null;
          signal?: string | null;
        }) => {
          if (state.exitStatus) return;
          state.exitStatus = status;
          state.exitWaiters.forEach((w) => w(status));
          state.exitWaiters = [];
        };
        child.on("close", (code, signal) =>
          settle({ exitCode: code, signal: signal ?? null }),
        );
        child.on("error", (err) => {
          append(Buffer.from(`\n[terminal error] ${err.message}\n`));
          settle({ exitCode: 1, signal: null });
        });

        this.terminals.set(terminalId, state);
        return { terminalId };
      },

      terminalOutput: async (
        request: TerminalOutputRequest,
      ): Promise<TerminalOutputResponse> => {
        const t = this.terminals.get(request.terminalId);
        if (!t) return { output: "", truncated: false };
        return {
          output: t.output,
          truncated: t.truncated,
          exitStatus: t.exitStatus ?? null,
        };
      },

      waitForTerminalExit: async (
        request: WaitForTerminalExitRequest,
      ): Promise<WaitForTerminalExitResponse> => {
        const t = this.terminals.get(request.terminalId);
        if (!t) return {};
        const status =
          t.exitStatus ??
          (await new Promise<{
            exitCode?: number | null;
            signal?: string | null;
          }>((resolve) => t.exitWaiters.push(resolve)));
        return {
          exitCode: status.exitCode ?? null,
          signal: status.signal ?? null,
        };
      },

      killTerminal: async (
        request: KillTerminalRequest,
      ): Promise<KillTerminalResponse> => {
        try {
          this.terminals.get(request.terminalId)?.process.kill();
        } catch {
          // already gone
        }
        return {};
      },

      releaseTerminal: async (
        request: ReleaseTerminalRequest,
      ): Promise<ReleaseTerminalResponse> => {
        const t = this.terminals.get(request.terminalId);
        if (t) {
          try {
            t.process.kill();
          } catch {
            // already gone
          }
          this.terminals.delete(request.terminalId);
        }
        return {};
      },
    };
  }

  /**
   * Handle disconnection and cleanup
   */
  private handleDisconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    if (this.connection) {
      this.connection = null;
    }

    // A new connection starts with no sessions resident, so nothing is "already
    // loaded" anymore — force a real re-attach on the next loadSession.
    this.loadedSessionIds.clear();

    this.http = null;
    this.isConnected = false;
    this.emit("disconnected");
  }
}
