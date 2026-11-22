/**
 * The unified chat runtime: bridges the ACP/opencode client to a consumer-owned
 * webview chat panel over a postMessage-style transport, without requiring the
 * GLSP diagram platform. This is the single runtime behind the diagram
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
import * as path from "node:path";
import * as vscode from "vscode";
import { CORE_CHAT_SECTION } from "./edit-capability";
import { ACPClientService, type AcpAgentSpec, type TurnPart } from "../acp-client.js";
import type { DiagramChatConfirm, DiagramChatConfirmAnswer, DiagramRunAnswer, DiagramRunQuestion } from "../../api";
import { SessionManager, type MessageData } from "../session-manager.js";
import { FileSessionStore, chatSessionRoot } from "../session-store.js";
import type {
  ChatMessageSink,
  ChatPayload,
  InProcessChatTool,
} from "../../api";
import {
  SlashCommandRegistry,
  type ChatCommandContribution,
} from "./slash-commands";
import { attachAcpEventForwarding } from "./acp-event-forwarding";
import { copySessionId, openSessionNatively, type NativeSession } from "./native-session.js";
import { KNOWN_CONNECTORS } from "./acp-connectors.js";
import { readChatImages, type SurfaceSelectionSummary } from "@dialogram/shared";

/**
 * A surface's selection as the chat's turn context says it, by default: what
 * it is, its ids, its rows. The rows are what the property panel shows; the
 * agent reads the same thing the person does.
 */
export function surfaceSelectionText(selection: SurfaceSelectionSummary): string {
  const what = selection.kind ? `${selection.kind} "${selection.title}"` : `"${selection.title}"`;
  const lines = [
    `The user currently has ${what} selected in the diagram` +
      (selection.ids.length > 0 ? ` (id${selection.ids.length === 1 ? "" : "s"}: ${selection.ids.slice(0, 20).join(", ")})` : "") +
      ". When they say \"this\"/\"the selection\", they mean it.",
  ];
  let section: string | undefined;
  for (const row of selection.rows) {
    if (row.section && row.section !== section) {
      section = row.section;
      lines.push(`${section}:`);
    }
    lines.push(`- ${row.label}: ${row.value}`);
  }
  return lines.join("\n");
}

/**
 * The surface selection a webview message carries, checked: the webview is
 * the platform's own, but a message is still data from another process.
 */
export function readSurfaceSelection(raw: unknown): SurfaceSelectionSummary | undefined {
  const candidate = raw as Partial<SurfaceSelectionSummary> | null | undefined;
  if (!candidate || typeof candidate !== "object" || typeof candidate.title !== "string") {
    return undefined;
  }
  const rows = Array.isArray(candidate.rows)
    ? candidate.rows
        .filter((row) => row && typeof row.label === "string")
        .slice(0, 40)
        .map((row) => ({
          ...(typeof row.section === "string" ? { section: row.section } : {}),
          label: row.label,
          value: String(row.value ?? ""),
        }))
    : [];
  return {
    ids: Array.isArray(candidate.ids) ? candidate.ids.slice(0, 50).map(String) : [],
    title: candidate.title,
    ...(typeof candidate.kind === "string" && candidate.kind !== "" ? { kind: candidate.kind } : {}),
    rows,
  };
}

/** Core chat settings section (shared by every profile, not namespaced). */
/** workspaceState key of the last model the user explicitly chose. */
const PREFERRED_MODEL_STATE_KEY = "dialogram.chat.preferredModel";

/** What the panel says of a chat another window deleted. */
const DELETED_ELSEWHERE = "This chat was deleted in another window. Create or select a session to continue.";
const DELETED_HERE = "This chat was deleted. Create or select a session to continue.";

/**
 * Everything project-specific the unified chat runtime needs. The diagram
 * profile's chat contribution is expressed as this data — the runtime carries
 * no product/tool vocabulary of its own.
 */
export interface ChatRuntimeConfig {
  /** Short unique key, e.g. 'mlir' — names the MCP server and log scope. */
  key: string;
  /** Human-readable name, used for the output channel ("<name> Chat"). */
  displayName: string;
  /**
   * The ACP agent the chat spawns for a workspace; undefined (or no hook)
   * means opencode. A rejection is the connect error the panel shows.
   */
  acpAgent?: (cwd: string) => Promise<AcpAgentSpec | undefined>;
  /**
   * A named connector's `resume` template as a workspace sees it (for a run's
   * agents, which name their connector); undefined (or no hook) falls back to
   * the known connectors'.
   */
  connectorResume?: (connector: string, cwd: string) => string | undefined;
  /** Settings section read for `opencodePath` and `enableMcpTools`. */
  settingsSection: string;
  /** Domain primer injected into each session's context. */
  skill?: string;
  /** MIME type of the edited source, forwarded to the agent for context. */
  sourceMimeType?: string;
  /** Cap on the source attached to a session; 0 attaches none. See AcpClient. */
  sourceMaxBytes?: number;
  /** Compact graph/structure rendering, injected with the file (mtime-deduped). */
  graphContextProvider?: (
    file: string,
  ) => Promise<string | undefined> | string | undefined;
  /** Extra ACP content blocks injected on EVERY turn (receives the selection). */
  turnContextProvider?: (
    file: string,
    selectedNodeIds: string[],
    surfaceSelection?: SurfaceSelectionSummary,
  ) => Promise<any[]> | any[];
  /**
   * Per-turn selection injection. Enabled by default (`false` disables it);
   * pass an object with `render` to customize the injected text.
   */
  selectionContext?:
    false | {
      render?: (
        file: string,
        selectedNodeIds: string[],
        surfaceSelection?: SurfaceSelectionSummary,
      ) => string;
    };
  /** In-process MCP tools served over loopback HTTP. */
  tools?: InProcessChatTool[];
  /**
   * The GLSP-MCP loopback URL announced by the in-host diagram server when the
   * profile opts into GLSP-MCP. Handed to opencode as an http MCP descriptor
   * (see {@link glspMcpEnabled}).
   */
  mcpServerUrl?: string;
  /**
   * `true` when the diagram profile enabled GLSP-MCP (`profile.mcp.enabled`).
   * The coarse gate for advertising {@link mcpServerUrl} to the agent; a
   * per-user `<ns>.chat.useGlspMcp` setting is the finer rollback lever.
   */
  glspMcpEnabled?: boolean;
  /** Slash commands contributed to the registry (with optional handlers). */
  slashCommands?: ChatCommandContribution[];
  /** Runs after a free-text turn (e.g. diagram VIEW ops the prompt asked for). */
  postTurnHook?: (file: string, text: string) => Promise<void>;
}

/** One step of the trail from the root workflow down to the view on screen. */
export interface ViewCrumb {
  sourceUri?: string;
  workflowName: string;
  workflowInstanceName?: string;
}

/**
 * Tell the agent which nested workflow the diagram is showing.
 *
 * The chat session is the root's for the whole hierarchy: the agent reads the
 * root file and its graph. Navigating in place, the diagram can show a nested
 * workflow, possibly defined in another file -- and the selected node ids are
 * that view's. Nothing when the root itself is on screen.
 */
export function viewContextText(trail: ViewCrumb[] | undefined): string | undefined {
  if (!trail || trail.length < 2) {
    return undefined;
  }
  const path = trail
    .map((crumb, i) =>
      i === 0
        ? crumb.workflowName
        : `${crumb.workflowInstanceName ?? crumb.workflowName} (${crumb.workflowName})`,
    )
    .join(" › ");
  const shown = trail[trail.length - 1];
  const file = shown.sourceUri ? decodeURIComponent(shown.sourceUri.replace(/^file:\/\//, "")) : undefined;
  return (
    `The diagram is showing a nested workflow, not the root: ${path}.` +
    (file ? ` It is defined in ${file}.` : "") +
    " Selected nodes belong to this view, and the diagram tools act on its file."
  );
}

export class ChatRuntime {
  private readonly acp = new ACPClientService();
  private readonly sessions: SessionManager;
  private readonly registry: SlashCommandRegistry;
  private context: vscode.ExtensionContext;
  private started = false;
  private startPromise: Promise<void> | undefined;
  /** In-process HTTP MCP server (started lazily when the tools are enabled). */
  private mcpHttp: import("./mcp-http-server.js").McpHttpServer | undefined;
  /** sessionId -> the webview URI (string) that owns it, for routing ACP events. */
  private readonly sessionUri = new Map<string, string>();
  /** Every URI whose chat panel is live, so connection events reach panels that
   *  have no session yet. */
  private readonly activeUris = new Set<string>();
  /** Mode/model the user picked before any session existed; applied on create. */
  private pendingMode: "plan" | "build" | undefined;
  private pendingModel: string | undefined;
  /** Latest diagram selection (node ids) per file, fed to the turn context. */
  private readonly selectionByFile = new Map<string, string[]>();
  /** Latest diagram surface selection per file, fed to the turn context beside the nodes. */
  private readonly surfaceSelectionByFile = new Map<string, SurfaceSelectionSummary>();
  /** The nested view on screen per file, when it is not the root (see `viewContextText`). */
  private readonly viewTrailByFile = new Map<string, ViewCrumb[]>();
  private readonly output: vscode.OutputChannel;
  /** Whether a store failure has been put to the person yet. */
  private storeErrorShown = false;
  private readErrorShown = false;
  /** Sessions deleted in this window: one that answers meanwhile is not
   *  said to be deleted in another. */
  private deletedHere = new Set<string>();
  /** Tears down the ACP -> webview event forwarding registered in the ctor. */
  private readonly acpForwardingDisposer: () => void;
  /** Pending stuck-connection watchdog (armed on the panel handshake). */
  private connectWatchdog: ReturnType<typeof setTimeout> | undefined;
  /** The watchdog dialog fires at most once per runtime — no per-diagram nagging. */
  private connectWarned = false;

  /** A running agent's question, waiting for the panel's `chat.runAnswer`. */
  private readonly pendingRunQuestions = new Map<
    string,
    { resolve: (answer: DiagramRunAnswer) => void; timer?: ReturnType<typeof setTimeout> }
  >();

  /** A confirmation put to the person in a session, waiting for the panel's `chat.confirmAnswer`. */
  private readonly pendingConfirms = new Map<string, (answer: DiagramChatConfirmAnswer) => void>();
  private nextConfirmId = 1;

  constructor(
    context: vscode.ExtensionContext,
    private readonly config: ChatRuntimeConfig,
    private readonly postToWebview: ChatMessageSink,
    /** Whether the sink can reach a panel for a URI; absent means "assume so". */
    private readonly canReach?: (uri: string) => boolean,
  ) {
    this.context = context;
    this.registry = new SlashCommandRegistry(config.slashCommands ?? []);
    // Chats are kept beside the agent, on the machine this extension host
    // runs on, so a local window and a Remote-SSH one share them; those an
    // older Dialogram kept in workspaceState move there once.
    this.sessions = new SessionManager(
      this.acp,
      new FileSessionStore(chatSessionRoot(config.key)),
      context.workspaceState,
      (error, failed) => this.reportStoreError(error, failed),
    );
    void this.sessions.initialize();

    if (config.skill) {
      this.acp.setChatSkill(config.skill);
    }
    this.acp.setSourceMaxBytes(config.sourceMaxBytes);
    if (config.sourceMimeType) {
      this.acp.setSourceMimeType(config.sourceMimeType);
    }
    if (config.graphContextProvider) {
      this.acp.setWorkflowGraphProvider((file) =>
        Promise.resolve(config.graphContextProvider!(file)),
      );
    }
    this.acp.setTurnContextBlocksProvider(async (file) => {
      const blocks: any[] = [];
      const view = file ? viewContextText(this.viewTrailByFile.get(file)) : undefined;
      if (view) {
        blocks.push({ type: "text", text: view });
      }
      // A surface's selection rides as an extra argument, and only when there
      // is one: a profile without a surface is called exactly as before.
      const surface = file ? this.surfaceSelectionByFile.get(file) : undefined;
      const withSurface = surface ? [surface] as const : ([] as const);
      if (file && this.config.selectionContext !== false) {
        const selected = this.selectionByFile.get(file) ?? [];
        if (selected.length > 0) {
          const rendered = this.config.selectionContext?.render?.(
            file,
            selected,
            ...withSurface,
          );
          blocks.push({
            type: "text",
            text:
              rendered ??
              `The user currently has ${selected.length} node(s) selected in the diagram: ` +
                `${selected.slice(0, 20).join(", ")}. When they say "this"/"the selected node(s)", ` +
                "they mean these.",
          });
        } else if (surface) {
          const rendered = this.config.selectionContext?.render?.(file, [], surface);
          blocks.push({ type: "text", text: rendered || surfaceSelectionText(surface) });
        }
      }
      if (file && this.config.turnContextProvider) {
        try {
          const extra = await this.config.turnContextProvider(
            file,
            this.selectionByFile.get(file) ?? [],
            ...withSurface,
          );
          if (Array.isArray(extra)) blocks.push(...extra);
        } catch {
          // Best-effort.
        }
      }
      return blocks;
    });

    this.output = vscode.window.createOutputChannel(
      `${config.displayName} Chat`,
    );
    // Surface a per-profile setting for the opencode binary path; the ACP
    // client resolves it from the env var (then ~/.opencode/bin, PATH, …).
    const override = vscode.workspace
      .getConfiguration(config.settingsSection)
      .get<string>("opencodePath");
    if (override) {
      process.env.WORKFLOW_OPENCODE_PATH = override;
    }
    this.setupMcpProvider();
    this.acpForwardingDisposer = attachAcpEventForwarding(this.acp, {
      postToSession: (sessionId, payload) => this.post(sessionId, payload),
      broadcast: (payload) => this.broadcast(payload),
      onTurnComplete: ({ sessionId, text, thinking, model, parts }) => {
        this.persistAssistantTurn(sessionId, { text, thinking, model, parts });
        this.post(sessionId, { type: "chat.turnEnd", data: { sessionId } });
        // Resolve the just-sent user message's opencode id so its revert
        // affordance appears without rebuilding the timeline.
        void this.postLiveMessageIds(sessionId);
        void this.sayIfDeletedWhileAnswering(sessionId);
      },
    });
    // A successful connection (from any path) stands down the watchdog.
    this.acp.on("connected", () => this.clearConnectWatchdog());
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
    if (
      this.connectWarned ||
      this.connectWatchdog ||
      this.acp.isClientConnected()
    ) {
      return;
    }
    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = undefined;
      if (this.connectWarned || this.acp.isClientConnected()) {
        return;
      }
      this.connectWarned = true;
      this.output.appendLine(
        "connect watchdog: still disconnected after 30 s — surfacing dialog",
      );
      void vscode.window
        .showWarningMessage(
          `${this.config.displayName} chat could not connect to its agent (${this.acp.agent}) within 30 seconds. ` +
            "The agent may not be installed or on PATH.",
          "Show Log",
          "Run Diagnostics",
        )
        .then((choice) => {
          if (choice === "Show Log") {
            this.showLog();
          } else if (choice === "Run Diagnostics") {
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
      this.startPromise = Promise.resolve(this.config.acpAgent?.(cwd))
        .then((agent) => this.acp.start(cwd, agent))
        .then(async () => {
          // Stand up the HTTP tool server before any session is created,
          // so mcpServersProvider can attach it synchronously.
          await this.ensureMcpServer();
          this.started = true;
        })
        .catch((err) => {
          this.startPromise = undefined;
          throw err;
        });
    }
    await this.startPromise;
  }

  private mcpEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(this.config.settingsSection)
      .get<boolean>("enableMcpTools", true);
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
      const { McpHttpServer } = await import("./mcp-http-server.js");
      const server = new McpHttpServer(this.config.key, tools);
      await server.start();
      this.mcpHttp = server;
    } catch (err) {
      this.output.appendLine(`MCP HTTP server failed to start: ${String(err)}`);
    }
  }

  /**
   * The per-user rollback lever for the GLSP-MCP parallel-run path
   * (`dialogram.chat.useGlspMcp`, default on). Turning it off makes the chat
   * fall back to the read-only registry MCP server only.
   *
   * Read from the core `dialogram.chat` section like the sibling core chat
   * setting `autoLayoutAfterEdits`. Reading it off the
   * per-profile `settingsSection` (`<ns>.chat`) would be wrong: this is a
   * core-runtime rollback lever, not profile behaviour.
   */
  private useGlspMcp(): boolean {
    return vscode.workspace.getConfiguration(CORE_CHAT_SECTION).get<boolean>("useGlspMcp", true);
  }

  /**
   * Whether the in-host diagram (GLSP-MCP) server is actually advertised to
   * the agent: the profile opted in, a loopback URL exists, and the per-user
   * rollback lever is on. The single source of truth for both the MCP
   * descriptor and the context usage hint.
   */
  private glspAdvertised(): boolean {
    return Boolean(
      this.config.glspMcpEnabled &&
      this.config.mcpServerUrl &&
      this.useGlspMcp(),
    );
  }

  /**
   * The concise, product-neutral usage hint that teaches agents the diagram
   * MCP tools' id / sessionId semantics. Folded into the session context only
   * when {@link glspAdvertised} — see the constructor wiring. Kept short and
   * free of product vocabulary (neutrality gate 1).
   */
  private glspToolHint(): string {
    const name = `${this.config.key}-glsp`;
    return (
      `Diagram MCP tools (${name}): get the sessionId from the session-info tool. ` +
      "To add and wire a node you do NOT need to dump the model: create-nodes returns a " +
      "confirmation listing the new node's port names, then create-edges accepts " +
      'args.source / args.target as "nodeName.portName" (resolved server-side) — so the ' +
      "usual flow is create-nodes -> read the listed ports -> create-edges with " +
      "nodeName.portName, with no query-elements/diagram-model round-trips. Raw element-id " +
      "addressing still works: element IDs must come from query-elements or diagram-model — " +
      "IDs embedded in diagram-svg / diagram-png output carry a '<clientId>_' prefix and are " +
      "NOT valid tool arguments. For ALL graph changes (adding nodes, connections, deletions) " +
      "use create-nodes / create-edges / modify-* / delete-elements, and whatever further " +
      "diagram tools are listed — do NOT edit the source " +
      "file directly for changes these tools can express: tool edits go through the " +
      "editor's undo stack, direct file edits do not. " +
      "To see the diagram as the editor draws it (a layout, what an edit looks like), call " +
      "diagram-png: it returns a picture of what is in view. " +
      "Diagram edits are undoable by the user via the editor's undo — do not attempt " +
      "tool-based undo / redo and do not hand-revert files after your own diagram edits " +
      "unless asked."
    );
  }

  private setupMcpProvider(): void {
    // Fold the diagram-tool usage hint into the session context, but only
    // while the GLSP-MCP server is genuinely advertised to the agent.
    this.acp.setGlspToolHintProvider(() =>
      this.glspAdvertised() ? this.glspToolHint() : undefined,
    );
    this.acp.setMcpServersProvider((file?: string) => {
      if (!file) return [];
      const servers: any[] = [];
      // GLSP-MCP: advertise the in-host diagram server's loopback URL to
      // opencode, gated by the profile opt-in and the per-user rollback
      // setting. `headers` is an ARRAY here (the opencode http descriptor shape).
      if (this.glspAdvertised()) {
        servers.push({
          type: "http",
          name: `${this.config.key}-glsp`,
          url: this.config.mcpServerUrl,
          headers: [],
        } as any);
      }
      if (this.mcpEnabled() && this.mcpHttp) {
        servers.push({
          type: "http",
          name: this.config.key,
          url: this.mcpHttp.urlFor(file),
          headers: [],
        } as any);
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
      this.postToWebview(uri, {
        type: "chat.error",
        data: { message: String(err) },
      });
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
      this.postToWebview(uri, {
        type: "chat.connectionStatus",
        data: { connected: true, agent: this.acp.agent, images: this.acp.takesImages() },
      });
      return true;
    } catch (err) {
      const message = `Could not start the chat agent (${this.acp.agent}): ${String(err)}`;
      this.output.appendLine(message);
      this.postToWebview(uri, {
        type: "chat.connectionStatus",
        data: { connected: false, reason: String(err), agent: this.acp.agent },
      });
      this.postToWebview(uri, { type: "chat.error", data: { message } });
      return false;
    }
  }

  /** Connect, warm the model catalog (needs a probe session), then send the list. */
  private async connectAndSendModels(uri: string, cwd: string): Promise<void> {
    if (!(await this.connectAndReport(uri, cwd))) return;
    await this.acp.warmUpModelCatalog().catch(() => undefined);
    await this.sendModels(uri);
  }

  /** A diagram surface's selection for the file, or none (`readSurfaceSelection`). */
  private setSurfaceSelection(file: string, raw: unknown): void {
    const selection = readSurfaceSelection(raw);
    if (selection) {
      this.surfaceSelectionByFile.set(file, selection);
    } else {
      this.surfaceSelectionByFile.delete(file);
    }
  }

  private setViewTrail(file: string, raw: unknown): void {
    const trail = Array.isArray(raw)
      ? raw.filter((c: any) => c && typeof c.workflowName === "string")
      : [];
    if (trail.length > 1) {
      this.viewTrailByFile.set(file, trail as ViewCrumb[]);
    } else {
      this.viewTrailByFile.delete(file);
    }
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
    // A session this window has not read yet (a panel that kept it across a
    // restart of the extension host): the file's sessions are read first, so
    // it is sent to, opened or deleted as kept.
    const named = typeof data?.sessionId === "string" ? data.sessionId : undefined;
    if (named && !this.sessions.getSession(named) && !(await this.sessions.isGone(named))) {
      await this.sessions.refresh(file).catch((error) => this.reportStoreError(error, "read"));
      // Still not there: deleted, if it left the mark (then it is gone).
      if (!this.sessions.getSession(named)) await this.sessions.isGone(named, file);
    }

    switch (type) {
      case "chat.ready": {
        // Post the current status immediately: the integrated panel's 5 s
        // handshake must not wait out an opencode spawn.
        this.postToWebview(uri, {
          type: "chat.connectionStatus",
          data: {
            connected: this.acp.isClientConnected(),
            agent: this.acp.agent,
            images: this.acp.takesImages(),
          },
        });
        this.armConnectWatchdog();
        await this.sendSessions(uri, file);
        // Eagerly connect on panel open so the panel shows Connected
        // without needing a first message.
        await this.connectAndSendModels(uri, cwd);
        return;
      }
      case "chat.log":
        this.output.appendLine(`webview: ${String(data?.message ?? "")}`);
        return;
      case "chat.getSessions": {
        // The panel names the session it shows when it comes back to its
        // window: another window may have gone on with it, or deleted it.
        const shown = typeof data?.shown === "string" ? data.shown : undefined;
        await this.sendSessions(uri, file);
        if (!shown) return;
        // Deleted, not merely unread (a list that failed, a file that cannot
        // be read): only then is the panel told so.
        if (await this.sessions.isGone(shown)) {
          this.postToWebview(uri, {
            type: "chat.sessionDeleted",
            data: { sessionId: shown, reason: this.deletedReason(shown) },
          });
          return;
        }
        // What the panel shows: the stored messages it names (by key), and
        // those this window made (it showed them as they came). The others
        // are another window's. A reply it leaves (a turn started since) is
        // sent again next time; one it has already, it leaves.
        const keys: unknown[] = Array.isArray(data?.keys) ? data.keys : [];
        const shownKeys = new Set(keys.filter((k): k is string => typeof k === "string"));
        const isShown = (m: MessageData) => !m.key || shownKeys.has(m.key) || this.sessions.isLocal(shown, m.key);
        const all = this.sessions.getSessionMessages(shown);
        const lastShown = all.reduce((last, m, i) => (isShown(m) ? i : last), -1);
        const added = all.filter((m) => !isShown(m));
        if (added.length === 0) return;
        // Rows it shows that this host never sent nor made (shown as they
        // came, before a restart of the host): it cannot tell which stored
        // ones they are, so the transcript is sent again, once.
        const unkeyed = typeof data?.unkeyed === "number" ? data.unkeyed : 0;
        const unknownRows = unkeyed > 0 && !this.sessions.hasLocal(shown);
        if (unknownRows || all.indexOf(added[0]) < lastShown) {
          // Some come before what it shows (both windows went on at once):
          // the transcript again, in order. The panel leaves it if a turn has
          // started since it asked.
          await this.postHistory(uri, shown, { catchUp: true });
          return;
        }
        // All after what it shows: only those, added after it.
        const { messages, reverted } = await this.historyOf(shown);
        const addedKeys = new Set(added.map((m) => m.key));
        this.postToWebview(uri, {
          type: "chat.sessionAppend",
          data: { sessionId: shown, messages: messages.filter((m) => m.key && addedKeys.has(m.key)), reverted },
        });
        return;
      }
      case "chat.getProviders":
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
      case "chat.getCommands": {
        const mode: "plan" | "build" = data?.mode === "plan" ? "plan" : "build";
        this.postToWebview(uri, {
          type: "chat.commands",
          data: { mode, commands: this.registry.listForMode(mode) },
        });
        return;
      }
      case "chat.createSession": {
        await this.ensureStarted(cwd);
        // Collect the name via a native input box (webview prompt() is
        // blocked). Cancelling drops the panel's spinner.
        let name: string | undefined = data?.name;
        if (!name) {
          // The default offered must not be a name another window has taken.
          await this.sessions.refresh(file).catch(() => undefined);
          name = await vscode.window.showInputBox({
            title: "New Chat Session",
            prompt: "Name for the new chat session",
            // Single source of truth: the same helper the session
            // manager uses, so the pre-filled name can never collide
            // with an existing "Session N".
            value: this.sessions.nextDefaultSessionName(file),
            ignoreFocusOut: true,
            validateInput: (candidate) =>
              this.sessions.sessionNameExists(file, candidate.trim())
                ? `A session named "${candidate.trim()}" already exists`
                : undefined,
          });
          if (!name) {
            this.postToWebview(uri, { type: "chat.sessionCreateAborted" });
            return;
          }
        }
        const session = await this.sessions.createSession(
          file,
          name,
          data?.mode ?? this.pendingMode ?? "build",
        );
        this.sessionUri.set(session.id, uri);
        this.sessions.setCurrentSession(session.id);
        await this.applyPending(session.id);
        this.postToWebview(uri, {
          type: "chat.sessionCreated",
          data: { session },
        });
        await this.sendSessions(uri, file);
        return;
      }
      case "chat.loadSession": {
        if (!data?.sessionId) return;
        await this.ensureStarted(cwd);
        const loaded = await this.sessions.loadSession(data.sessionId);
        if (!loaded && (await this.sessions.isGone(data.sessionId))) {
          // Deleted in another window since this one listed it.
          this.postToWebview(uri, {
            type: "chat.sessionDeleted",
            data: { sessionId: data.sessionId, reason: this.deletedReason(data.sessionId) },
          });
          await this.sendSessions(uri, file);
          return;
        }
        if (!loaded) {
          this.postToWebview(uri, {
            type: "chat.error",
            data: {
              message: `Could not restore session ${data.sessionId}. It may have expired — start a new chat.`,
            },
          });
          return;
        }
        this.sessionUri.set(data.sessionId, uri);
        this.sessions.setCurrentSession(data.sessionId);
        await this.postHistory(uri, data.sessionId, {
          mode: this.acp.getSessionMode(data.sessionId),
          model: this.acp.getSessionModel(data.sessionId) ?? loaded.provider,
        });
        return;
      }
      case "chat.revert": {
        if (!data?.sessionId || !data?.messageId) return;
        await this.acp.revertToMessage(data.sessionId, data.messageId);
        await this.postHistory(uri, data.sessionId);
        return;
      }
      case "chat.unrevert": {
        if (!data?.sessionId) return;
        await this.acp.unrevert(data.sessionId);
        await this.postHistory(uri, data.sessionId);
        return;
      }
      case "chat.deleteSession": {
        if (!data?.sessionId) return;
        const target = this.sessions.getSession(data.sessionId);
        const label = target?.name ?? data.sessionId;
        const choice = await vscode.window.showWarningMessage(
          `Delete chat session "${label}"? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") return;
        // Pick the next session to fall back to (most-recent sibling), from
        // the list as it is now: the question may have waited a long time.
        await this.sessions.refresh(file).catch((error) => this.reportStoreError(error, "read"));
        const siblings = this.sessions
          .getSessionsForWorkflow(file)
          .filter((s) => s.id !== data.sessionId);
        const nextSessionId = siblings[0]?.id;
        this.deletedHere.add(data.sessionId);
        if (!(await this.sessions.deleteSession(data.sessionId, file))) {
          this.deletedHere.delete(data.sessionId);
          // Its file could not be removed: it stays, and the panel says so.
          this.postToWebview(uri, {
            type: "chat.error",
            data: { message: `Could not delete chat session "${label}": its file could not be removed (see the ${this.config.displayName} Chat output).` },
          });
          await this.sendSessions(uri, file);
          return;
        }
        this.sessionUri.delete(data.sessionId);
        if (nextSessionId) this.sessions.setCurrentSession(nextSessionId);
        this.postToWebview(uri, {
          type: "chat.sessionDeleted",
          data: { sessionId: data.sessionId, nextSessionId },
        });
        await this.sendSessions(uri, file);
        return;
      }
      case "chat.renameSession": {
        if (!data?.sessionId) return;
        let name: string | undefined = data.name;
        if (!name) {
          const current = this.sessions.getSession(data.sessionId);
          name = await vscode.window.showInputBox({
            title: "Rename Chat Session",
            prompt: "New name for the chat session",
            value: current?.name ?? "",
            ignoreFocusOut: true,
          });
          if (!name) return;
        }
        await this.sessions.renameSession(data.sessionId, name);
        if (await this.saidDeleted(uri, file, data.sessionId)) return;
        this.postToWebview(uri, {
          type: "chat.sessionRenamed",
          data: { sessionId: data.sessionId, name },
        });
        await this.sendSessions(uri, file);
        return;
      }
      case "chat.selection":
        // The panel pushes the current diagram selection; used as context.
        this.selectionByFile.set(
          file,
          Array.isArray(data?.selectedNodeIds)
            ? data.selectedNodeIds.map(String)
            : [],
        );
        this.setSurfaceSelection(file, data?.surfaceSelection);
        this.setViewTrail(file, data?.viewTrail);
        return;
      case "chat.sendMessage": {
        if (Array.isArray(data?.selectedNodeIds)) {
          this.selectionByFile.set(file, data.selectedNodeIds.map(String));
          this.setSurfaceSelection(file, data?.surfaceSelection);
        }
        this.setViewTrail(file, data?.viewTrail);
        await this.ensureStarted(cwd);
        // Fall back to the current session if the panel didn't pass one.
        let sessionId: string | undefined =
          data.sessionId || this.sessions.getCurrentSessionId() || undefined;
        if (!sessionId) {
          const session = await this.sessions.createSession(
            file,
            undefined,
            data.mode ?? this.pendingMode ?? "build",
          );
          sessionId = session.id;
          this.sessionUri.set(sessionId, uri);
          this.sessions.setCurrentSession(sessionId);
          await this.applyPending(sessionId);
          this.postToWebview(uri, {
            type: "chat.sessionCreated",
            data: { session },
          });
          await this.sendSessions(uri, file);
        }
        this.sessionUri.set(sessionId, uri);
        this.sessions.setCurrentSession(sessionId);
        const images = readChatImages(data?.images);
        const mode: "plan" | "build" = data.mode === "plan" ? "plan" : "build";
        if (images.length > 0 && this.acp.takesImages() === false) {
          // The panel refuses images an agent does not read; one that
          // connected since may not: nothing is sent or stored, and the panel
          // puts the message back in its composer, saying why.
          this.postToWebview(uri, {
            type: "chat.messageNotSent",
            data: {
              sessionId,
              reason: `${this.acp.agent} does not read images`,
              images: false,
            },
          });
          this.postToWebview(uri, { type: "chat.turnEnd", data: { sessionId } });
          return;
        }
        // A chat another window deleted takes no more messages: nothing is
        // sent or stored, the panel is told, and the message goes back to
        // the composer.
        const refuse = async () => {
          this.postToWebview(uri, {
            type: "chat.messageNotSent",
            data: {
              sessionId,
              reason: this.deletedHere.has(sessionId) ? "this chat was deleted" : "this chat was deleted in another window",
            },
          });
          this.postToWebview(uri, { type: "chat.turnEnd", data: { sessionId } });
          this.postToWebview(uri, { type: "chat.sessionDeleted", data: { sessionId, reason: this.deletedReason(sessionId) } });
          await this.sendSessions(uri, file);
        };
        if (await this.sessions.isGone(sessionId)) {
          await refuse();
          return;
        }
        // A session restored from storage (after a reload) isn't attached in
        // the freshly-started agent, so re-attach it before prompting — else
        // the agent has no context (file) for it. Deleted in the meantime:
        // refused all the same.
        if (!this.acp.getSession(sessionId)) {
          if (!(await this.sessions.loadSession(sessionId)) && (await this.sessions.isGone(sessionId))) {
            await refuse();
            return;
          }
        }
        this.sessions.addMessageToSession(sessionId, {
          role: "user",
          content: data.text,
          timestamp: Date.now(),
          mode: data.mode,
          // How many: the bytes would swell the stored sessions.
          ...(images.length > 0 ? { images: images.length } : {}),
        });
        let resolved: {
          contribution: ChatCommandContribution;
          args: Record<string, any>;
        } | null = null;
        try {
          resolved = this.registry.resolve(String(data.text ?? ""), mode);
        } catch (err) {
          this.postToWebview(uri, {
            type: "chat.message",
            data: {
              role: "system",
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: Date.now(),
              mode,
            },
          });
          // A slash command is a turn of its own: the panel shows it streaming
          // until told it ended, and the next click on send would cancel it.
          this.postToWebview(uri, { type: "chat.turnEnd", data: { sessionId } });
          return;
        }
        if (resolved && resolved.contribution.handler) {
          const ctx = {
            file,
            uri,
            sessionId,
            selectedNodeIds: this.selectionByFile.get(file) ?? [],
            ...(this.surfaceSelectionByFile.has(file)
              ? { surfaceSelection: this.surfaceSelectionByFile.get(file) }
              : {}),
            mode,
          };
          let result: { success: boolean; error?: string; info?: string };
          try {
            result = await resolved.contribution.handler(resolved.args, ctx);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
          this.postToWebview(uri, {
            type: "chat.message",
            data: {
              role: "system",
              content: (result.success
                ? (result.info ??
                  `✓ Executed: /${resolved.contribution.command}`)
                : `Error: ${result.error}`) +
                (images.length > 0
                  ? ` (The images were not sent: /${resolved.contribution.command} does not take them.)`
                  : ""),
              timestamp: Date.now(),
              mode,
            },
          });
          this.postToWebview(uri, { type: "chat.turnEnd", data: { sessionId } });
          return;
        }
        // A message runs in the mode it was sent in (its row says so): an agent
        // holding another -- a session re-attached above takes the agent's -- is
        // told first.
        if (
          (data.mode === "plan" || data.mode === "build") &&
          this.acp.getSessionMode(sessionId) !== data.mode
        ) {
          const sentIn: "plan" | "build" = data.mode;
          await this.acp
            .setSessionMode(sessionId, sentIn)
            .then(() => this.sessions.updateSessionMode(sentIn, sessionId))
            .catch((error) => console.warn(`[chat] could not set mode '${sentIn}':`, error));
        }
        // Pass-through slash suggestions and natural language both go to the agent.
        await this.acp.sendPrompt(sessionId, data.text, images);
        if (this.config.postTurnHook) {
          await this.config
            .postTurnHook(file, String(data.text ?? ""))
            .catch(() => undefined);
        }
        return;
      }
      case "chat.cancel":
        if (!data?.sessionId) return;
        await this.acp.cancelPrompt(data.sessionId);
        return;
      case "chat.setMode":
        // Chosen before any session exists: remember and apply on create.
        if (!data?.sessionId) {
          this.pendingMode = data.mode;
          return;
        }
        await this.acp.setSessionMode(data.sessionId, data.mode);
        this.sessions.setCurrentSession(data.sessionId);
        await this.sessions.updateSessionMode(data.mode, data.sessionId);
        await this.saidDeleted(uri, file, data.sessionId);
        return;
      case "chat.setProvider": {
        const modelId = data.providerId;
        if (!data?.sessionId) {
          this.pendingModel = modelId;
          return;
        }
        await this.acp.setProvider(data.sessionId, modelId);
        // Persist the choice as the preferred model for future sessions.
        void this.context.workspaceState.update(PREFERRED_MODEL_STATE_KEY, modelId);
        this.postToWebview(uri, {
          type: "chat.providerChanged",
          data: { provider: modelId },
        });
        return;
      }
      case "chat.permissionResponse":
        this.acp.respondToPermission(data.requestId, data.optionId ?? null);
        return;
      case "chat.openSessionNatively":
      case "chat.copySessionId": {
        const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
        if (!sessionId) return;
        const session: NativeSession = {
          agent: this.acp.agent,
          sessionId,
          resume: this.acp.resumeTemplate,
          cwd: this.acp.sessionCwd(sessionId),
        };
        await (type === "chat.copySessionId" ? copySessionId(session) : openSessionNatively(session));
        return;
      }
      case "chat.openAgentSession":
      case "chat.copyAgentSession": {
        // A run's agent: its firing named the connector and the directory.
        const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
        if (!sessionId) return;
        const connector = typeof data?.connector === "string" && data.connector ? data.connector : undefined;
        const cwd = typeof data?.cwd === "string" && data.cwd ? data.cwd : undefined;
        const session: NativeSession = {
          agent: connector ?? "agent",
          sessionId,
          cwd,
          // The workspace's connectors files decide (they can clear one);
          // the known connectors' only without them.
          resume: !connector
            ? undefined
            : this.config.connectorResume
              ? this.config.connectorResume(connector, cwd ?? process.cwd())
              : KNOWN_CONNECTORS[connector]?.resume,
        };
        await (type === "chat.copyAgentSession" ? copySessionId(session) : openSessionNatively(session));
        return;
      }
      case "chat.confirmAnswer": {
        const resolve = this.pendingConfirms.get(String(data?.id));
        if (!resolve) return;
        this.pendingConfirms.delete(String(data.id));
        resolve(typeof data?.choice === "string" ? { choice: data.choice } : {});
        return;
      }
      case "chat.runAnswer": {
        const pending = this.pendingRunQuestions.get(String(data?.id));
        if (!pending) return;
        this.pendingRunQuestions.delete(String(data.id));
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(
          data?.declined
            ? { declined: true, reason: typeof data.reason === "string" ? data.reason : "declined" }
            : { answer: String(data?.answer ?? "") },
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * Put a running agent's question (the run driver's elicitation) to the chat
   * panel open on `uri`, and wait for its `chat.runAnswer`. The chat is a
   * viewer of the run here, not a session: nothing goes to the agent process.
   * `undefined` when no panel can be reached, so the driver falls back to a
   * VS Code prompt; declined on the question's own timeout.
   */
  askRunQuestion(uri: string, question: DiagramRunQuestion): Promise<DiagramRunAnswer | undefined> {
    if (this.canReach && !this.canReach(uri)) {
      this.logLine(`run question ${question.id} from ${question.agent}: no chat panel on ${uri}`);
      return Promise.resolve(undefined);
    }
    const key = String(question.id);
    return new Promise((resolve) => {
      const timer = question.timeoutMs && question.timeoutMs > 0
        ? setTimeout(() => {
            if (this.pendingRunQuestions.delete(key)) {
              resolve({ declined: true, reason: "timeout" });
            }
          }, question.timeoutMs)
        : undefined;
      this.pendingRunQuestions.set(key, { resolve, timer });
      this.postToWebview(uri, { type: "chat.runQuestion", data: { ...question } });
    });
  }

  /**
   * Ask the person to confirm, in the session shown by the chat panel open on
   * `uri`: a card in its timeline with `confirm.choices` as buttons. Resolves
   * with the button pressed (none when declined); `undefined` when no panel can
   * be reached, so the caller asks another way.
   */
  confirmInChat(uri: string, confirm: DiagramChatConfirm): Promise<DiagramChatConfirmAnswer | undefined> {
    if (this.canReach && !this.canReach(uri)) {
      this.logLine(`confirm "${confirm.title}": no chat panel on ${uri}`);
      return Promise.resolve(undefined);
    }
    const id = String(this.nextConfirmId++);
    return new Promise((resolve) => {
      this.pendingConfirms.set(id, resolve);
      this.postToWebview(uri, { type: "chat.confirm", data: { id, ...confirm } });
    });
  }

  /**
   * Start a task in the chat panel open on `uri`: a new session named
   * `task.name`, in `task.mode`, whose first message is `task.prompt` -- sent by
   * the panel as if typed, so the person sees what was asked. `false` when no
   * panel can be reached there.
   */
  startTask(uri: string, task: { name: string; mode: "plan" | "build"; prompt: string }): boolean {
    if (this.canReach && !this.canReach(uri)) {
      this.logLine(`chat task "${task.name}": no chat panel on ${uri}`);
      return false;
    }
    this.postToWebview(uri, { type: "chat.startTask", data: { ...task } });
    return true;
  }

  /** The last model the user explicitly chose. */
  private getPreferredModel(): string | undefined {
    return this.context.workspaceState.get<string | undefined>(PREFERRED_MODEL_STATE_KEY, undefined);
  }

  /** Apply the preferred model first, then any pre-session mode/model the user
   *  picked before this session existed (an explicit pre-session choice wins). */
  private async applyPending(sessionId: string): Promise<void> {
    const preferred = this.getPreferredModel();
    if (preferred) {
      await this.acp.setProvider(sessionId, preferred).catch(() => undefined);
    }
    if (this.pendingMode) {
      await this.acp
        .setSessionMode(sessionId, this.pendingMode)
        .catch(() => undefined);
    }
    if (this.pendingModel) {
      await this.acp
        .setProvider(sessionId, this.pendingModel)
        .catch(() => undefined);
    }
  }

  /**
   * Persist a completed assistant turn as an ordered transcript. When the turn
   * carries structured parts (text runs interleaved with tool calls), each is
   * stored as its own message — text parts as `assistant` messages, tool parts
   * as `tool` messages — so a reloaded session restores tool chips and text
   * boundaries verbatim (no flattening into one concatenated blob). Reasoning is
   * attached to the first text part it produced, mirroring the live renderer.
   * Falls back to a single assistant message when no parts are available.
   */
  private persistAssistantTurn(
    sessionId: string,
    turn: {
      text?: string;
      thinking?: string;
      model?: string;
      parts?: TurnPart[];
    },
  ): void {
    const now = Date.now();
    const parts = turn.parts ?? [];
    if (parts.length === 0) {
      this.sessions.addMessageToSession(sessionId, {
        role: "assistant",
        content: turn.text ?? "",
        timestamp: now,
        thinking: turn.thinking,
        provider: turn.model,
      });
      return;
    }
    let thinkingAttached = false;
    for (const part of parts) {
      if (part.type === "tool") {
        this.sessions.addMessageToSession(sessionId, {
          role: "tool",
          content: "",
          timestamp: now,
          toolName: part.title,
          toolStatus: part.status,
        });
        continue;
      }
      const message: Parameters<typeof this.sessions.addMessageToSession>[1] = {
        role: "assistant",
        content: part.text,
        timestamp: now,
        provider: turn.model,
      };
      if (!thinkingAttached && turn.thinking) {
        message.thinking = turn.thinking;
        thinkingAttached = true;
      }
      this.sessions.addMessageToSession(sessionId, message);
    }
    // Reasoning with no text part to host it (a tool-only turn) still persists.
    if (!thinkingAttached && turn.thinking) {
      this.sessions.addMessageToSession(sessionId, {
        role: "assistant",
        content: "",
        timestamp: now,
        thinking: turn.thinking,
        provider: turn.model,
      });
    }
  }

  // --- revert / history-with-ids ----------------------------------------

  /**
   * Map each stored user message (in order) to its opencode message id, by
   * aligning against opencode's authoritative message list. Matches by content
   * (exact or endsWith — the first prompt of a session has context text
   * prepended); a message of images alone, by the images opencode holds for
   * the next one. Locally-only messages resolve to undefined without
   * consuming an opencode entry, so they don't shift the mapping.
   */
  private async alignUserMessageIds(
    sessionId: string,
    userMessages: Array<{ content?: string; images?: number }>,
  ): Promise<Array<string | undefined>> {
    let oc: Array<{ id: string; text: string; images: number }> = [];
    try {
      const msgs = await this.acp.getMessagesWithIds(sessionId);
      oc = msgs
        .filter(
          (m) =>
            (m as any)?.role === "user" && typeof (m as any).id === "string",
        )
        .map((m) => ({
          id: (m as any).id,
          text: String((m as any).text ?? "").trim(),
          images: Number((m as any).images ?? 0),
        }));
    } catch {
      return userMessages.map(() => undefined);
    }
    const out: Array<string | undefined> = [];
    let i = 0;
    for (const message of userMessages) {
      const content = (message.content ?? "").trim();
      const matches =
        i < oc.length &&
        (content !== ""
          ? oc[i].text === content || oc[i].text.endsWith(content)
          : (message.images ?? 0) > 0 && oc[i].images > 0);
      if (matches) {
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
    extra?: { mode?: "plan" | "build"; model?: string; catchUp?: boolean },
  ): Promise<void> {
    const { messages, reverted } = await this.historyOf(sessionId);
    this.postToWebview(uri, {
      type: "chat.sessionHistory",
      data: {
        sessionId,
        messages,
        mode: extra?.mode ?? this.acp.getSessionMode(sessionId),
        model: extra?.model ?? this.acp.getSessionModel(sessionId),
        reverted,
        // Sent on coming back to the window: the panel leaves it if a turn
        // has started since it asked, or another session is shown.
        ...(extra?.catchUp ? { catchUp: true } : {}),
      },
    });
  }

  /**
   * A chat another window deleted while it answered: its answer stays on
   * screen to be read, but was not kept, and the panel says so.
   */
  private async sayIfDeletedWhileAnswering(sessionId: string): Promise<void> {
    const uri = this.sessionUri.get(sessionId);
    if (!uri) return;
    await this.sessions.idle(sessionId);
    if (this.deletedHere.has(sessionId) || !(await this.sessions.isGone(sessionId))) return;
    this.postToWebview(uri, {
      type: "chat.message",
      data: {
        role: "system",
        content: "This chat was deleted in another window while it answered: this answer was not kept.",
        timestamp: Date.now(),
      },
    });
    await this.sendSessions(uri, this.fileFor(uri));
  }

  /** Why a chat went: deleted in this window (another panel), or another. */
  private deletedReason(sessionId: string): string {
    return this.deletedHere.has(sessionId) ? DELETED_HERE : DELETED_ELSEWHERE;
  }

  /**
   * After a change to a chat (a rename, a mode): one deleted meanwhile took
   * it not, and the panel is told so. True when it was.
   */
  private async saidDeleted(uri: string, file: string, sessionId: string): Promise<boolean> {
    await this.sessions.idle(sessionId);
    if (!(await this.sessions.isGone(sessionId))) return false;
    this.postToWebview(uri, {
      type: "chat.sessionDeleted",
      data: { sessionId, reason: this.deletedReason(sessionId) },
    });
    await this.sendSessions(uri, file);
    return true;
  }

  /** A session's stored messages, each user message with its opencode id. */
  private async historyOf(sessionId: string): Promise<{ messages: MessageData[]; reverted: boolean }> {
    const stored = this.sessions.getSessionMessages(sessionId);
    const ids = await this.alignUserMessageIds(
      sessionId,
      stored.filter((m) => m.role === "user"),
    );
    let reverted = false;
    try {
      reverted = Boolean(await this.acp.getRevertState(sessionId));
    } catch {
      // HTTP API unavailable — render history without revert ids.
    }
    let k = 0;
    const messages = stored.map((m) => {
      if (m.role !== "user") return m;
      const messageId = ids[k++];
      return messageId ? { ...m, messageId } : m;
    });
    return { messages, reverted };
  }

  /** After a turn, push resolved user-message ids (+ revert state) for the
   *  live timeline so just-sent messages gain their revert affordance. */
  private async postLiveMessageIds(sessionId: string): Promise<void> {
    const uri = this.sessionUri.get(sessionId);
    if (!uri) return;
    const stored = this.sessions.getSessionMessages(sessionId);
    const ids = await this.alignUserMessageIds(
      sessionId,
      stored.filter((m) => m.role === "user"),
    );
    let reverted = false;
    try {
      reverted = Boolean(await this.acp.getRevertState(sessionId));
    } catch {
      // ignore
    }
    this.postToWebview(uri, {
      type: "chat.messageIds",
      data: { sessionId, ids, reverted },
    });
  }

  /** A chat that cannot be kept is said, once, not hidden; the chat goes on. */
  private reportStoreError(error: unknown, failed: "save" | "read" = "save"): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output?.appendLine(`Chat session store (${failed}): ${message}`);
    if (failed === "read") {
      if (this.readErrorShown) return;
      this.readErrorShown = true;
      void vscode.window.showWarningMessage(
        `${this.config.displayName}: a stored chat could not be read (${message}). It is shown as this window last had it.`,
      );
      return;
    }
    if (this.storeErrorShown) return;
    this.storeErrorShown = true;
    void vscode.window.showWarningMessage(
      `${this.config.displayName}: chats cannot be saved (${message}). This chat goes on, but may not be there after a reload.`,
    );
  }

  /** The diagram's sessions, read again from the store: another window's show. */
  private async sendSessions(uri: string, file: string): Promise<void> {
    try {
      await this.sessions.refresh(file);
    } catch (error) {
      this.output.appendLine(`Could not read the stored chat sessions: ${String(error)}`);
    }
    const sessions = this.sessions
      .getSessionsForWorkflow(file)
      .map((s) => ({ id: s.id, name: s.name }));
    this.postToWebview(uri, { type: "chat.sessions", data: { sessions } });
  }

  private async sendModels(uri: string): Promise<void> {
    const providers = await this.acp.listProviders().catch(() => []);
    this.postToWebview(uri, {
      type: "chat.providers",
      data: { providers },
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
    this.output.appendLine("──────── DIAGNOSTICS ────────");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.output.appendLine(
      `workspace folder: ${workspaceRoot ?? "(none — open a folder)"}`,
    );
    this.output.appendLine(`PATH: ${process.env.PATH ?? "(unset)"}`);
    this.output.appendLine(`acp connected: ${this.acp.isClientConnected()}`);
    if (!workspaceRoot) {
      this.output.appendLine("Cannot probe: no workspace folder open.");
      return;
    }
    try {
      await this.ensureStarted(workspaceRoot);
      const sessionId = await this.acp.createSession(
        workspaceRoot,
        "diagnostic-probe",
        "build",
      );
      this.output.appendLine(`Probe session created: ${sessionId}`);
      const models = await this.acp.listProviders();
      this.output.appendLine(
        `Models available: ${models.length}` +
          (models.length
            ? ` (e.g. ${models
                .slice(0, 3)
                .map((m: any) => m.id)
                .join(", ")})`
            : ""),
      );
      this.output.appendLine(
        '✅ Backend is functional. If the panel still shows "Connecting", the webview↔extension messages are not reaching it.',
      );
    } catch (e) {
      this.output.appendLine(
        `Probe FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  dispose(): void {
    this.clearConnectWatchdog();
    // Nobody is left to answer: a pending confirmation is declined.
    for (const resolve of this.pendingConfirms.values()) resolve({});
    this.pendingConfirms.clear();
    this.acpForwardingDisposer();
    this.acp.stop();
    this.mcpHttp?.stop();
    this.output.dispose();
  }
}
