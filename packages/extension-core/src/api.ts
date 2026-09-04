/**
 * The Dialogram public API contract.
 *
 * This module is the compile-time surface consumers import
 * (`@dialogram/extension-core/api`) — types plus the version constant only,
 * no runtime platform code — so bundling it into a consumer stays trivial.
 * The runtime object is obtained from the running Dialogram extension:
 *
 *     const base = vscode.extensions.getExtension<DialogramApi>('ebezati.dialogram');
 *     const api = await base.activate();
 *     api.activateDiagramProfile(context, MY_PROFILE);
 *
 * It will eventually be published as the standalone `@dialogram/api` package.
 */
import type * as vscode from "vscode";
import type {
  EditStrategy,
  DiagramNavigationProvider,
  DiagramModelSource,
  DiagramEditBackend,
  DiagramOpenabilityCheck,
  DiagramClientAssets,
  EntityPaletteItemSpec,
  NodeFamilySpec,
  ExecutionOverlaySink,
} from "@dialogram/shared";

export type { DiagramClientAssets, EntityPaletteItemSpec, NodeFamilySpec } from "@dialogram/shared";

import type {
  ChatCommandContribution,
  ChatCommandContext,
  ChatCommandResult,
} from "./extension/chat/slash-commands";

export type { ChatCommandContribution, ChatCommandContext, ChatCommandResult };

/**
 * Semver of the API contract. Consumers must check the major version on
 * activation and fail with an actionable message on mismatch.
 */
export const DIALOGRAM_API_VERSION = "0.7.0";

/** The extension id consumers pass to `vscode.extensions.getExtension`. */
export const DIALOGRAM_EXTENSION_ID = "ebezati.dialogram";

/**
 * The command ids a diagram profile owns. Members are consumer-owned strings so
 * two installed consumers never collide. Neutral successor of the pre-0.2.0
 * per-extension command-ids type.
 */
export interface DiagramCommandIds {
  openDiagram: string;
  openDiagramSplit: string;
  layoutDiagram: string;
  refreshDiagramModel: string;
  renameEntityByName: string;
  undo: string;
  redo: string;
  fitToScreen: string;
  center: string;
  exportSvg: string;
  toggleGrid: string;
  setQueueTraceVisible: string;
  stopWorkflow: string;
  runWorkflow: string;
  layoutDiagramIfNeeded: string;
  setAgentToolConfig: string;
  getAgentToolConfig: string;
  createAgentToolPolicyFile: string;
  chatAddViewerEditor: string;
  chatAddViewerTask: string;
  createNewContainer: string;
}

/** Port operation-kind strings surfaced to the diagram client. Neutral
 *  successor of the pre-0.2.0 per-extension operation-kinds type. */
export interface DiagramOperationKinds {
  createEntityPort: string;
  deleteEntityPort: string;
}

/**
 * Neutral storage runtime options core forwards to the diagram server: the
 * settings namespace, the operation-prefix surfaced to the client, and the
 * palette selector. Values are supplied by the consumer (the toolkit's
 * the toolkit's profile builder builds them for external-tool-backed profiles).
 */
export interface DiagramStorageOptions {
  settingsNamespace: string;
  operationPrefix: string;
  useAlternateEntityPalette?: boolean;
  /** Extra Entities-palette entries this product contributes. Plain data; the
   *  platform builds the actual palette item. */
  entityPaletteItems?: EntityPaletteItemSpec[];
  nodeFamilies?: NodeFamilySpec[];
}

/**
 * Chat carry-over: everything the diagram chat backend + intent resolver need
 * that is not already on the profile root. `operationPrefix` is the internal
 * namespace the chat's operation dispatcher routes under; `nodeCommands` are the
 * runtime's node-creation slash commands; `skill` is the domain primer injected
 * into each session's context.
 *
 * REALM NOTE: the function-valued fields (graph/turn/selection context, tool
 * handlers, slash-command handlers) follow the {@link DiagramProfile.serverDiagramModule}
 * precedent — they are safe only in build-time library mode, where the consumer
 * bundles `@dialogram/extension-core` and calls `activateProfileRuntime` directly.
 * The cross-extension `DialogramApi.activateDiagramProfile` path (data-only
 * profiles assembled inside the platform bundle) never populates them.
 */
export interface DiagramChatConfig {
  name: string;
  fullName: string;
  /** Internal op-dispatcher namespace shared by the chat backend and intent resolver. */
  operationPrefix: string;
  skill?: string;
  nodeCommands?: Array<{
    command: string;
    nodeType: string;
    description: string;
  }>;
  /** MIME type for the source file attached to each session's agent context (opaque, consumer-owned). */
  sourceMimeType?: string;
  /**
   * Largest source file attached to a chat session, in bytes; 0 attaches none.
   *
   * The source is injected whole by default, which is right for a hand-written
   * diagram and fatal for a generated one — a 12 MB module exhausts the context
   * before the question is read. Past the bound the head is sent with a note
   * saying what was omitted and to use the profile's tools instead.
   */
  sourceMaxBytes?: number;
  /** In-process MCP tools served over loopback HTTP. */
  tools?: InProcessChatTool[];
  /**
   * Compact graph/structure rendering, injected with the file (mtime-deduped).
   * When the profile has an `editBackend`, the edit capability's exportGraph
   * provider WINS and this field is ignored.
   */
  graphContextProvider?: (
    file: string,
  ) => Promise<string | undefined> | string | undefined;
  /** Extra ACP content blocks injected on EVERY turn. */
  turnContextProvider?: (
    file: string,
    selectedNodeIds: string[],
  ) => Promise<any[]> | any[];
  /** Per-turn selection injection; `false` disables, `render` customizes. */
  selectionContext?:
    false | { render?: (file: string, selectedNodeIds: string[]) => string };
  /**
   * Slash commands contributed by the profile (handler-capable). Appended
   * AFTER the edit capability's contributions; on a duplicate `command` name
   * the profile's registration wins (registry map semantics).
   */
  slashCommands?: ChatCommandContribution[];
}

/**
 * The live-overlay signature source a run driver exposes so the editor provider
 * can drive live-execution glow. Structural twin of the editor provider's
 * `LiveOverlaySignatureSource` and the toolkit driver's live-overlay APIs.
 */
export interface DiagramLiveOverlaySource {
  watch(sourceUri: vscode.Uri): { dispose(): void };
  onSignature(
    listener: (sourceUri: string, signature: string | undefined) => void,
  ): { dispose(): void };
}

/**
 * The host core builds and hands to a profile's {@link DiagramRunDriverFactory}:
 * the neutral execution-overlay sink, the diagram-refresh dispatch (the driver
 * never holds the connector), the run output channel, and a hook to register the
 * driver's live-overlay signature source with the editor provider.
 */
export interface DiagramRunHost {
  overlay: ExecutionOverlaySink;
  requestRefresh(
    sourceUri: string,
    kind: "full" | "agentContextOnly",
    networkName?: string,
  ): void;
  output: vscode.OutputChannel;
  useLiveOverlaySignatureSource(source: DiagramLiveOverlaySource): void;
}

/**
 * Consumer-supplied run driver factory. Core calls it with the caller's
 * ExtensionContext (the driver reads `context.workspaceState` for persisted
 * per-entity overrides) and the {@link DiagramRunHost} it builds; the returned
 * disposable tears the driver down.
 */
export type DiagramRunDriverFactory = (
  context: vscode.ExtensionContext,
  host: DiagramRunHost,
) => vscode.Disposable;

/**
 * v2 diagram profile — the complete activation contract at
 * `DIALOGRAM_API_VERSION` 0.3.0. It carries everything the platform needs to
 * activate a diagram for one consumer; NO external-tool/product vocabulary appears
 * here. External-tool-backed consumers assemble one with the toolkit's profile
 * builder.
 */
/**
 * Neutral, behavior-named client capability flags a consumer injects into the
 * diagram webview via `window.diagramIdentifier`. Each field names a client
 * behavior; the consumer supplies the per-product truth value. Core/client code
 * consults these flags instead of comparing a product-identity string.
 */
export interface DiagramClientBehavior {
  /** Cross-file drill-down navigation resolves through the graph source model. */
  graphSourceNavigation?: boolean;
  /** Property panel renders the network-model sections and labels. */
  networkPropertySections?: boolean;
  /** Cross-file navigation UI uses the network entity vocabulary. */
  networkNavigationLabels?: boolean;
  /** Sentinel option value/default for the agent CLI-tools "none" selection. */
  noneSentinel?: string;
  /** Node `cmd` values (lower-case) that render with the script-tool icon. */
  scriptInterpreterCommands?: string[];
  /**
   * Artwork for icon ids this product uses, keyed by id.
   *
   * A palette icon is only a CSS class — GLSP renders `<i class="codicon
   * codicon-<id>">` — so an icon exists only if some rule draws it. The
   * platform's own rules cannot carry a product's mark, so a product supplies
   * the image and the webview writes the rule.
   *
   * Each value is a complete `url(...)` source: a `data:image/svg+xml,...` URI
   * is the portable choice, since a webview cannot load arbitrary file paths.
   * `light`/`dark` are picked by the viewer's theme; give only `dark` and it is
   * used for both.
   */
  paletteIcons?: Record<string, { dark: string; light?: string }>;
  nodeFamilies?: NodeFamilySpec[];
  /**
   * Whether the host has a chat backend behind this diagram.
   *
   * Derived by the platform from `DiagramProfile.chat`, not supplied by a
   * product: the two must agree, and a field a product sets by hand is a field
   * it can set wrongly. Read it, do not write it.
   *
   * The stock feature module boots a chat panel eagerly. When the host has no
   * chat backend, that panel opened, sent its first message into a host with no
   * handler for it, logged an unknown-method error, and timed out five seconds
   * later — leaving a chat button that could never answer. A consumer that
   * composes the stock features without configuring chat is a normal thing to
   * be; the platform documents that module as the stock product's feature set,
   * which is precisely the case that has to degrade quietly.
   */
  chatBackend?: boolean;
}

export interface DiagramProfile {
  key: string;
  displayName: string;
  settingsNamespace: string;
  customEditorViewType: string;
  glspClientId: string;
  glspClientName: string;
  /** Consumer-owned command ids. */
  commands: DiagramCommandIds;
  /**
   * File extensions this product's diagram is a view of — lower-case, leading
   * dot: `['.foo', '.bar']`.
   *
   * Everywhere the platform has to decide whether a URI is one of this
   * product's sources — the open-diagram commands, the rename command's
   * "which file is active" lookup, the editor provider's save and on-disk
   * watchers — it asks this list. User-facing messages are worded from it too,
   * so a consumer is told to open a `.foo` file rather than whatever the
   * platform was written against.
   *
   * Declaring nothing is legal and deliberately permissive: the platform then
   * filters by extension nowhere, and phrases those messages without naming an
   * extension at all. The core cannot know how a product names its files, and a
   * guess would fail silently — commands refusing every file, indistinguishable
   * from a workspace with no sources. An unrecognised file instead reaches
   * {@link DiagramProfile.canOpenSource}, which can refuse it for a reason the
   * product actually knows.
   */
  sourceExtensions?: string[];
  /** Port operation-kind strings injected into the diagram client. */
  operationKinds?: DiagramOperationKinds;
  /** Neutral behavior flags forwarded into the diagram webview. */
  clientBehavior?: DiagramClientBehavior;
  /** Consumer-supplied webview bundle (script/style/resource-roots). When absent,
   *  the provider serves its stock `dist/webview/*` bundle. DATA ONLY — path/URI
   *  strings, never code objects. */
  clientAssets?: DiagramClientAssets;
  /** Edit strategy: `'read-only'` disables writes; an editable strategy carries the
   *  consumer-supplied operation modules registered on the diagram server. */
  edits: EditStrategy;
  /** Factory for the graph model source (core ships no implementation). */
  modelSource?: () => DiagramModelSource;
  /**
   * Consumer's GLSP `DiagramModule` factory — BUILD-TIME LIBRARY consumption
   * only. When supplied it REPLACES the stock diagram module on the server
   * (threaded to `createWorkflowServerModules`'s `diagramModuleFactory`),
   * letting a consumer (e.g. mlir-viewer) run its own server-side DI classes.
   *
   * REALM LAW (SP2c bundle-boundary): the returned module and every
   * `ContainerModule`/DI-decorated class it pulls in carry the inversify/Symbol
   * identity of the realm they were CONSTRUCTED in. They resolve correctly ONLY
   * when the platform runtime and this module share ONE esbuild bundle — i.e.
   * the consumer bundles `@dialogram/extension-core` and calls
   * `activateProfileRuntime` directly. This field MUST NOT cross the
   * cross-extension `DialogramApi.activateDiagramProfile` boundary: the platform
   * would resolve it in a foreign realm with no injection metadata. That path
   * asserts the field is absent and throws a clear error (see
   * {@link assertProfileCrossesPlatformApiSafely}). Returns `unknown` because
   * `shared` must stay browser-safe and cannot name GLSP server types.
   */
  serverDiagramModule?: () => unknown;
  /**
   * Inbound webview-message hook. The editor provider forwards every message
   * NOT already consumed by its built-in debug / `dialogram.ui.*` handlers to
   * this hook; returning `true` (or a promise resolving to `true`) marks the
   * message consumed. When absent, unhandled messages are ignored exactly as
   * before (byte-identical parity). `ctx.postToWebview` posts back to the same
   * webview; `ctx.revealRange` opens a source URI and selects the range.
   */
  onWebviewMessage?: (
    uri: string,
    message: unknown,
    ctx: {
      postToWebview(msg: unknown): void;
      revealRange(
        uriStr: string,
        range?: { startLine: number; startColumn?: number },
      ): Promise<void>;
    },
  ) => boolean | Promise<boolean>;
  /** Extra DI container modules contributed to the diagram server. */
  serverModules?: unknown[];
  /** Neutral storage runtime options forwarded to the diagram server. */
  storageOptions?: DiagramStorageOptions;
  /**
   * Whether this diagram can be authored on the canvas. Default `true`.
   *
   * Set `false` for a diagram that is a PROJECTION of a source artifact —
   * generated by reading a file rather than drawn. For one of those, every
   * creation tool is a lie: the palette offers to add a node, and the drop has
   * nowhere to go, because the graph is derived and the file is where the truth
   * lives. `false` empties the creation palette entirely — the platform's own
   * categories and the product's own {@link DiagramStorageOptions.entityPaletteItems}
   * alike, since a projection has nothing to create either way.
   *
   * It says nothing about edits that DO have somewhere to go. Moving a node,
   * routing an edge and the persisted layout are unaffected; so is
   * {@link DiagramProfile.edits}, which governs whether operations may write at
   * all. A profile can be fully editable and still create nothing.
   */
  supportsElementCreation?: boolean;
  watch?: { globs: string[] };
  /** Cross-file navigation provider. */
  navigation?: DiagramNavigationProvider;
  /** Openability predicate; `undefined` = always openable. */
  canOpenSource?: DiagramOpenabilityCheck;
  /** Chat mutation seam; chat features degrade gracefully when absent. */
  editBackend?: DiagramEditBackend;
  /** Chat carry-overs; when absent the chat backend is not activated. */
  chat?: DiagramChatConfig;
  /**
   * GLSP-MCP opt-in. Absent or `{ enabled:false }` keeps the legacy chat/MCP path
   * byte-identical (no in-host MCP loopback server, no diagram-scope MCP tools).
   * `{ enabled:true }` boots the in-host GLSP-MCP loopback server on the diagram's
   * `initialize` handshake and bridges the profile's read-only {@link DiagramChatConfig.tools}
   * into diagram-scope MCP tools. The announced loopback URL is surfaced on the
   * activation handle for the agent clients.
   */
  mcp?: { enabled: boolean };
  /** Run driver factory; when absent no run/stop commands or live glow are wired. */
  runDriver?: DiagramRunDriverFactory;
  /** Registers the new-source-file (and any edit-backend) commands; returns their disposable. */
  newSourceFile?: (context: vscode.ExtensionContext) => vscode.Disposable;
}

/**
 * Handle returned by `activateDiagramProfile`. Disposing it tears down the
 * GLSP integration for that profile. The `chat` accessors back the consumer's
 * own diagnostic commands (command ids stay consumer-owned so two consumers
 * never collide).
 */
export interface DiagramProfileHandle extends vscode.Disposable {
  chat: {
    runDiagnostics(): Promise<void> | void;
    showLog(): void;
  };
  /**
   * Dispatch a host→client action to the webview owning `uri`, over the ungated
   * `sendMessageToClient` overlay-bridge path — it reaches the client even for
   * kinds the client did not advertise in `clientActions`. No-op when no diagram
   * client is registered for the URI.
   */
  dispatchToWebview(
    uri: string,
    action: { kind: string } & Record<string, unknown>,
  ): void;
  /**
   * Post a raw message straight to the webview panel owning `uri`
   * (`webview.postMessage`), for the consumer's own cursor-sync / graph-era
   * channel. No-op when no panel is registered for the URI.
   */
  postToWebview(uri: string, message: unknown): void;
}

/** A `{ type, data }` message exchanged with a consumer-owned chat webview. */
export interface ChatPayload {
  type: string;
  data?: any;
}

/**
 * Delivers a chat payload to the panel owned by the given document URI.
 * Types the per-URI reply sink consumed by ChatRuntime/GlspChatTransport.
 */
export type ChatMessageSink = (uri: string, payload: ChatPayload) => void;

/**
 * An MCP tool served in-process over loopback HTTP. The handler receives the
 * absolute path of the file the session is scoped to and the tool arguments,
 * and returns the tool's text result — it can read live host-side state
 * (e.g. an in-memory graph store) directly.
 */
export interface InProcessChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    file: string,
    args: Record<string, unknown>,
  ): string | Promise<string>;
  /**
   * When `true`, this tool WRITES source and MUST NOT be bridged onto the read-only
   * GLSP-MCP surface, whose handlers inherit `readOnlyHint = true` (an auto-approving MCP
   * client could otherwise mutate files unconfirmed). Locked design (approach B):
   * mutation-capable tools ride the GLSP-MCP built-in operation tools only. The diagram
   * server's bridge filters on this explicit marker; the tool stays available on the
   * in-host chat / in-process MCP path.
   */
  mutates?: boolean;
}

/**
 * A `/command` suggestion surfaced in the chat composer's slash menu.
 *
 * @deprecated Since 0.3.0 use {@link ChatCommandContribution}, which is a
 * superset (adds optional `modes` and a host-side `handler`). This 0.2.0 shape
 * remains exported and is structurally a subset of `ChatCommandContribution`,
 * so existing `slashCommands` literals keep compiling — a contribution without a
 * handler is still a pass-through suggestion whose raw text goes to the agent.
 */
export interface ChatSlashCommand {
  command: string;
  description: string;
  usage?: string;
}

export interface DialogramApi {
  apiVersion: string;
  /**
   * Activate the full diagram platform (custom editor + GLSP server +
   * webview client + chat backend) for one profile. Registers everything
   * against the CALLER's ExtensionContext, so disposables die with the
   * consumer extension. Webview/MCP assets are served from the Dialogram
   * extension's own install directory.
   */
  activateDiagramProfile(
    context: vscode.ExtensionContext,
    profile: DiagramProfile,
  ): Promise<DiagramProfileHandle>;
}

/**
 * Guard the cross-extension platform-API path: {@link DiagramProfile.serverDiagramModule}
 * is a build-time library-only field (see its JSDoc — the realm law). A consumer
 * reaching `DialogramApi.activateDiagramProfile` with it set would have its GLSP
 * DiagramModule resolved in the platform bundle's FOREIGN inversify realm with no
 * injection metadata (the SP2c cross-bundle failure). Throw a clear, actionable
 * error instead. Library consumers that call `activateProfileRuntime` directly
 * never pass through here and are unaffected.
 */
/**
 * Brand key stamped (via `Symbol.for`, so any bundle sees the same key) on profiles
 * ASSEMBLED INSIDE the platform bundle (the api's profile assembler). Branded
 * profiles may legitimately carry DI-holding fields back across the cross-extension
 * API: those objects were constructed in the platform's own realm and merely round-trip
 * through the consumer.
 */
export const PLATFORM_ASSEMBLED_PROFILE = Symbol.for(
  "dialogram.platformAssembledProfile",
);

export function assertProfileCrossesPlatformApiSafely(
  profile: DiagramProfile,
): void {
  const realmError = (field: string): Error =>
    new Error(
      `DiagramProfile.${field} cannot be supplied over the cross-extension ` +
        "DialogramApi.activateDiagramProfile boundary: DI objects constructed in the " +
        "consumer's bundle would resolve in the platform bundle's foreign inversify realm with no " +
        "injection metadata. Either assemble the profile platform-side " +
        "(the platform api's profile assembler) or consume the platform as a build-time library — " +
        "bundle @dialogram/extension-core and call activateProfileRuntime directly.",
    );
  if (profile.serverDiagramModule) {
    // Never legal over the API, branded or not: the toolkit assembler never sets it.
    throw realmError("serverDiagramModule");
  }
  if (
    (profile as unknown as Record<PropertyKey, unknown>)[
      PLATFORM_ASSEMBLED_PROFILE
    ] === true
  ) {
    return; // platform-realm objects round-tripping through the consumer — safe.
  }
  if (profile.serverModules && profile.serverModules.length > 0) {
    throw realmError("serverModules");
  }
  if (
    profile.edits !== "read-only" &&
    profile.edits?.operationModules?.length
  ) {
    throw realmError("edits.operationModules");
  }
}

/** True when the base's API version satisfies the consumer's expectation. */
export function isApiVersionCompatible(
  baseVersion: string,
  expected: string = DIALOGRAM_API_VERSION,
): boolean {
  const majorOf = (v: string): string => v.split(".")[0] ?? "";
  const major = majorOf(baseVersion);
  if (major !== majorOf(expected)) {
    return false;
  }
  // Pre-1.0: minor bumps may break too, so require an exact major.minor match.
  if (major === "0") {
    return baseVersion.split(".")[1] === expected.split(".")[1];
  }
  return true;
}
