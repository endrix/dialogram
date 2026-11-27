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
  DiagramClientBehavior,
  DiagramCommandIds,
  DiagramOperationKinds,
  InProcessChatTool,
  EditStrategy,
  DiagramNavigationProvider,
  DiagramModelSource,
  DiagramEditBackend,
  DiagramOpenabilityCheck,
  DiagramClientAssets,
  EntityPaletteItemSpec,
  NodeFamilySpec,
  NodeListSpec,
  ExecutionNodeState,
  ExecutionOverlaySink,
  LoadPhaseWords,
  LoadProgress,
  OutlinePage,
  OutlinePageRequest,
  OutlineRowActivation,
  OutlineRowReveal,
  SurfaceSelectionSummary,
  ViewOptionChange,
  ViewOptionGroup,
  ViewOptionTurn,
} from "@dialogram/shared";

export type {
  AcpConnectorInfo,
  DiagramClientAssets,
  DiagramClientBehavior,
  DiagramCommandIds,
  DiagramOperationKinds,
  EntityPaletteItemSpec,
  InProcessChatTool,
  NodeFamilySpec,
  NodeListSpec,
} from "@dialogram/shared";

// The seams' vocabulary: the loading words, the outline on demand, a
// surface's selection, the view options.
export type {
  LoadPhase,
  LoadPhaseFacts,
  LoadPhaseWords,
  LoadProgress,
  OutlinePage,
  OutlinePageRequest,
  OutlinePageRow,
  OutlineRowActivation,
  OutlineRowReveal,
  SurfaceSelectionSummary,
  ViewOptionChange,
  ViewOptionGroup,
  ViewOptionItem,
  ViewOptionsState,
  ViewOptionTurn,
} from "@dialogram/shared";

import type {
  ChatCommandContribution,
  ChatCommandContext,
  ChatCommandResult,
} from "./extension/chat/slash-commands";

export type { ChatCommandContribution, ChatCommandContext, ChatCommandResult };
import type { AcpAgentSpec } from "./extension/acp-client";
export type { AcpAgentSpec };
import type { AcpConnectorConfig, AcpConnectorFiles } from "./extension/chat/acp-connectors";
export type { AcpConnectorConfig, AcpConnectorFiles };

/**
 * Semver of the API contract. Consumers must check the major version on
 * activation and fail with an actionable message on mismatch.
 */
export const DIALOGRAM_API_VERSION = "0.8.0";

/** The extension id consumers pass to `vscode.extensions.getExtension`. */
export const DIALOGRAM_EXTENSION_ID = "ebezati.dialogram";

/** Port operation-kind strings surfaced to the diagram client. Neutral
 *  successor of the pre-0.2.0 per-extension operation-kinds type. */
/**
 * Neutral storage runtime options core forwards to the diagram server: the
 * settings namespace, the operation-prefix surfaced to the client, and the
 * palette selector. Values are supplied by the consumer (the toolkit's
 * the toolkit's profile builder builds them for external-tool-backed profiles).
 */
export interface DiagramStorageOptions {
  settingsNamespace: string;
  operationPrefix: string;
  /** @deprecated The platform's two Entities lists are gone; declare the rows in `entityPaletteItems`. Accepted and ignored. */
  useAlternateEntityPalette?: boolean;
  /** The Entities palette: the product's rows, in its order. Plain data; the
   *  platform builds each item and adds none of its own. */
  entityPaletteItems?: EntityPaletteItemSpec[];
  /** @deprecated The platform has no Entities entries of its own any more. Accepted and ignored. */
  platformEntityItems?: boolean;
  nodeFamilies?: NodeFamilySpec[];
  /** A second outline, of one node family across the hierarchy (shared `NodeListSpec`). */
  nodeList?: NodeListSpec;
  /** How nested workflows are navigated; in place, a nested view's layout is
   *  the root's, per instance (diagram-server `layout-target.ts`). */
  nestedNavigation?: 'in-place' | 'new-editor';
  /** The layout diagrams open with and Layout > Default Layout runs:
   *  Untangled or Free Ports instead of the boundary-flow layout
   *  (diagram-server `layout-tuned-handler.ts`). */
  defaultLayout?: 'untangled' | 'free-ports';
  /** What opening or closing a bus, or a node in place, does to the rest of
   *  the view: lay it all out again (`relayout`, the default) or keep every
   *  node and push down the ones under it (`make-room`) (diagram-server
   *  `toggle-port-bus-handler.ts`). */
  toggleLayout?: 'relayout' | 'make-room';
  /** Whether a long node name breaks onto lines in its header. Default
   *  `true`; `false` keeps names on one line. A node's `meta.headerWrap`
   *  (a boolean) wins over it (diagram-server `storage-runtime-options.ts`). */
  headerWrap?: boolean;
  /** Whether a layout record is kept beside each source
   *  (`.layout/<file>.layout.json`: positions, routes, open bundles, port
   *  orders, the reader's view options). Default `true`. `false` writes none
   *  and reads none (one already there is left as it is), for a product
   *  whose files lie in folders it does not own: each diagram is laid out
   *  when it opens; the open bundles and held states are held until the
   *  editor closes, the view options until the window does; the positions
   *  moved, routes and port orders are not, and a model asked for again is
   *  laid out afresh. A Dialogram older than this ignores it and keeps the
   *  record (diagram-server `storage-runtime-options.ts`). */
  keepLayoutRecord?: boolean;
}

/**
 * Chat carry-over: everything the diagram chat backend needs that is not
 * already on the profile root. `nodeCommands` are the runtime's node-creation
 * slash commands (none when absent); `skill` is the domain primer injected into
 * each session's context. The operation prefix the edits route under is the
 * storage options', not this block's.
 *
 * REALM NOTE: the function-valued fields are SUPPORTED over the cross-extension
 * `DialogramApi.activateDiagramProfile`, as they are in library mode. Every
 * extension runs in the one extension-host JavaScript realm, and
 * `activateDiagramProfile` hands the platform the consumer's profile object
 * itself, not a copy (`packages/extension/src/main.ts`), so a plain function
 * the consumer wrote is called as it was written, with its closure. That
 * covers, here: `tools` (each `handler`, for the chat's in-process MCP server
 * and, with `DiagramProfile.mcp`, the diagram server's MCP bridge),
 * `graphContextProvider`, `turnContextProvider`, `selectionContext.render`, and
 * each slash command's `handler` in `slashCommands`
 * (`test/chat-functions-over-api.test.ts` calls each through that path).
 *
 * What does NOT cross is a DI object: a GLSP `DiagramModule`, a `ContainerModule`,
 * a class decorated for inversify. Those carry the identity of the bundle they
 * were built in, and the platform bundle resolves them in its own
 * (`DiagramProfile.serverDiagramModule`, `serverModules`, `edits.operationModules`;
 * `assertProfileCrossesPlatformApiSafely` refuses them). A chat function that
 * reaches into such an object of its own bundle still runs, in its own bundle.
 */
export interface DiagramChatConfig {
  /** @deprecated Nothing reads it; accepted and ignored. */
  name?: string;
  fullName: string;
  /** @deprecated Nothing reads it (the storage options carry their own prefix); accepted and ignored. */
  operationPrefix?: string;
  skill?: string;
  /** The slash commands that create a node, one per node type the product has.
   *  Absent: the chat offers none. */
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
   * Set, it is what the session gets; absent, a profile with an `editBackend`
   * gets the edit capability's graph export as JSON.
   */
  graphContextProvider?: (
    file: string,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Extra ACP content blocks injected on EVERY turn. `surfaceSelection` is
   * what a diagram surface has selected (diagram-client `diagram-surface.ts`),
   * passed only when there is one: a profile without a surface is called
   * with two arguments, as before.
   */
  turnContextProvider?: (
    file: string,
    selectedNodeIds: string[],
    surfaceSelection?: SurfaceSelectionSummary,
  ) => Promise<any[]> | any[];
  /**
   * Per-turn selection injection; `false` disables, `render` customizes.
   *
   * Without `render`, nodes selected are named by id, and a surface's
   * selection is said with its kind, title, ids and rows. `render` is called
   * when nodes are selected (with the surface's selection as a third argument
   * when there is one too) and when only a surface's is (`selectedNodeIds`
   * empty); an empty answer for the latter falls back to the default text.
   */
  selectionContext?:
    false | {
      render?: (
        file: string,
        selectedNodeIds: string[],
        surfaceSelection?: SurfaceSelectionSummary,
      ) => string;
    };
  /**
   * Slash commands contributed by the profile (handler-capable). Appended
   * AFTER the edit capability's contributions; on a duplicate `command` name
   * the profile's registration wins (registry map semantics).
   */
  slashCommands?: ChatCommandContribution[];
  /**
   * The ACP connector the chat talks to, declared as the product's setting
   * (`<settingsNamespace>.<settingKey>`, user level with a workspace
   * override) and its runtime's two connectors files. The platform reads the
   * connectors the way that runtime does (the known agents on the PATH, the
   * user's file under `~/.config`, the workspace's file at the project
   * root), resolves the chat's agent from them when the chat connects, and
   * offers them on an agent node's `connector` in the property panel
   * ({@link DiagramClientBehavior.acpConnectors}). Absent, the chat talks to
   * opencode.
   */
  acpConnector?: AcpConnectorConfig;
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
/** A running agent's question to the user (the runtime's elicitation over
 *  the run driver's socket): the toolkit's `RunQuestion`. */
export interface DiagramRunQuestion {
  id: number | string;
  agent: string;
  model?: string;
  runId?: string;
  question: string;
  context?: string;
  choices?: string[];
  timeoutMs?: number;
}

export interface DiagramRunAnswer {
  answer?: string;
  declined?: boolean;
  reason?: string;
}

export interface DiagramRunHost {
  overlay: ExecutionOverlaySink;
  /** Puts a running agent's question to the user in the chat panel open on
   *  the diagram at `sourceUri`; `undefined` when no chat can take it (the
   *  driver then asks through a VS Code prompt). */
  askUser(question: DiagramRunQuestion, sourceUri: string): Promise<DiagramRunAnswer | undefined>;
  requestRefresh(
    sourceUri: string,
    kind: "full" | "agentContextOnly",
    networkName?: string,
  ): void;
  output: vscode.OutputChannel;
  useLiveOverlaySignatureSource(source: DiagramLiveOverlaySource): void;
  /** Starts a task in the chat on the diagram at `sourceUri`: a new session in
   *  `task.mode`, named `task.name`, whose first message is `task.prompt`.
   *  `false` when no chat can take it there. */
  startChatTask?(task: DiagramChatTask, sourceUri: string): Promise<boolean>;
  /** Asks the person to confirm, in the chat session shown on the diagram at
   *  `sourceUri`: a card with `confirm.choices` as buttons. The answer's
   *  `choice` is the button pressed, absent when declined; `undefined` when no
   *  chat can ask there. */
  confirmInChat?(confirm: DiagramChatConfirm, sourceUri: string): Promise<DiagramChatConfirmAnswer | undefined>;
}

/** A confirmation the platform puts to the person in a diagram's chat (see `DiagramRunHost.confirmInChat`). */
export interface DiagramChatConfirm {
  title: string;
  text: string;
  choices: string[];
  /** Pictures of what is to be confirmed: PNGs, base64, each with what it shows. */
  figures?: Array<{ data: string; caption?: string }>;
}

/** The person's answer to a {@link DiagramChatConfirm}: the button pressed, none when declined. */
export interface DiagramChatConfirmAnswer {
  choice?: string;
}

/** A task the platform asks a diagram's chat to start (see `DiagramRunHost.startChatTask`). */
export interface DiagramChatTask {
  name: string;
  mode: "plan" | "build";
  prompt: string;
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
 * The rows of the outline that are too many to send with every model, and
 * what a click on a row that is no node of the graph does (shared
 * `outline-pages.ts`).
 *
 * The outline the model source gives (`GraphDocument.hierarchy`) is sent with
 * every model and drawn whole. A group of it marked `lazy` (with its `count`)
 * is not: its rows stay here, in the host, and the panel asks {@link page}
 * for the ones the reader scrolls to, a page at a time, and for the ones a
 * filter typed in the panel finds. Only the rows on screen are in the
 * panel's DOM, so a group of a hundred thousand scrolls as one of forty.
 *
 * A row with no node of the graph behind it (a lazy row without `nodeId`, an
 * `item` row of the outline) is the product's: a click calls {@link activate}
 * with its id. The product points the outline at a row with
 * {@link DiagramProfileHandle.revealOutlineRow}.
 *
 * Plain functions, safe across the cross-extension
 * `DialogramApi.activateDiagramProfile`. `file` is the absolute path of the
 * file the outline is of (the editor's, whose model gave the outline).
 */
export interface DiagramOutline {
  /**
   * Rows `offset` to `offset + limit` of the lazy group `group`, under the
   * panel's filter `query` (`''` for none; what matches is the producer's
   * to decide, the panel only shows what comes back), and how many rows
   * match in all. Asked as the reader opens the group and scrolls it; keep
   * it quick, it is what scrolling waits for. A throw shows the rows as not
   * loaded, and is logged.
   *
   * It may give fewer rows than `limit` (it reads in smaller batches, or
   * stops at a time budget): the panel asks again from the first row it did
   * not get. Only `total` ends the list: an answer with no rows short of it
   * shows the rest of what was asked as not loaded, and it is not asked
   * again while the panel keeps what it read of the group under that
   * filter: until the outline changes, or, under a filter other than the
   * one typed now, until the panel forgets it for newer ones (it keeps every
   * group under the filter typed now and any a reveal is reading, and
   * others while it keeps no more than twelve in all), when it is asked
   * again if the reader comes back to that filter. A row given without an `id` keeps its place and does
   * nothing when clicked.
   */
  page(file: string, request: OutlinePageRequest): OutlinePage | Promise<OutlinePage>;
  /**
   * Where the row `id` is among the rows of `group` under `query`, from 0,
   * or `undefined` when it is not there. Asked to reveal a row whose place
   * the product did not give ({@link OutlineRowReveal.index}), or with a
   * filter typed. Without it, such a row is revealed only when a page the
   * panel has read already holds it; otherwise the reveal opens the groups
   * down to the row (and the panel, with `show`) and selects nothing. A
   * filter that hides the row is cleared only when the row is there without
   * it.
   */
  locate?(
    file: string,
    row: { group: string; id: string; query: string },
  ): number | undefined | Promise<number | undefined>;
  /**
   * A click (`open: false`) or double click (`open: true`) on a row that is
   * the product's. It does not say which editor of the file it was in, when
   * two show it: what it selects is the file's, as a node selection is, and
   * {@link DiagramProfileHandle.postToWebview} tells every editor of it.
   *
   * To enter a view of the file on a double click, run the profile's
   * `commands.refreshDiagramModel` with `{ sourceUri, workflowName, open:
   * true }`: the view is recorded as what the editor shows, and the next
   * save or view option marked `reload` is of it. It is the editor's root,
   * with no crumb back to the file's root; the name is not checked; the
   * file's own editor is asked, not one that shows the file in place
   * (shared `command-ids.ts`). Without `open: true` the
   * name is a refresh's hint: the view is drawn and nothing is recorded, so
   * those show the default view again.
   */
  activate?(file: string, row: OutlineRowActivation): void | Promise<void>;
}

/**
 * Node states that come from a report rather than a run: what a product's tool
 * says about each node of the file a diagram shows (which of its requirements
 * are covered, which checks pass), painted with the run overlay's drawing.
 *
 * A run streams its states while it lasts and needs a driver for that; a
 * report is one answer, asked for and shown. So the platform does the asking:
 * it registers {@link showCommand} and {@link clearCommand}, offers them on the
 * diagram's context menu ("Show <label>", "Clear <label>"), calls
 * {@link collect} for the diagram a command is invoked on, and publishes the
 * answer through the same execution-overlay sink a run driver gets as
 * `DiagramRunHost.overlay`. No run driver is involved and none is needed.
 *
 * The states replace the ones shown; they stay until shown again or cleared,
 * also across a view change in place (a state is matched by node id in
 * whatever view is shown) and a reopened editor.
 */
export interface DiagramStatusSource {
  /** What the states say, in a word or two (`Coverage`): the menu items, the
   *  progress and the messages are worded from it. */
  label: string;
  /** Consumer-owned command id: collect the states and show them. Takes the
   *  diagram's source URI (a `vscode.Uri`, as an editor-title menu passes it,
   *  or a string); without one it acts on the active diagram. */
  showCommand: string;
  /** Consumer-owned command id: take the states off. Same argument. */
  clearCommand: string;
  /**
   * The node states for the diagram of `file` (absolute path), `nodeId` as the
   * producer's graph names the node. A node left out, or `idle`, draws
   * nothing. A throw is reported to the person, and the states shown stay as
   * they were.
   */
  collect(file: string, context: DiagramStatusContext): Promise<ExecutionNodeState[]>;
}

/** What the platform hands {@link DiagramStatusSource.collect}. */
export interface DiagramStatusContext {
  /** The status source's output channel, `<display name> <label>`. */
  output: vscode.OutputChannel;
}

/**
 * What a reader may show and hide in this product's diagrams, from the
 * palette: checkable groups drawn under the palette's tools, in its style,
 * each a heading that opens and closes over its lines, with All, None and
 * Only for a long one (shared `view-options.ts`).
 *
 * A group is declared as data: here, once for every diagram, or by the model
 * source with each graph (`GraphDocument.viewOptions`), which is where groups
 * that depend on the file come from. The profile's come first.
 *
 * The HOST holds what the reader chose, per file, beside the file's layout
 * (`.layout/<file>.layout.json`, `viewOptions`), so that it survives a
 * reload and a reopen, and so that it can be read and set when no diagram is
 * open: {@link DiagramProfileHandle.getViewOptions} and
 * {@link DiagramProfileHandle.setViewOptions}, which is what a chat tool that
 * shows or hides things calls. A click is in force in the webview at once:
 * the platform dispatches `ViewOptionsChangedAction` there, which a
 * product's client module handles to redraw without a round trip.
 *
 * Functions here are plain functions, safe across the cross-extension
 * `DialogramApi.activateDiagramProfile` (no DI identity is involved; see
 * the realm note on {@link DiagramChatConfig}).
 */
export interface DiagramViewOptions {
  /** Groups every diagram of the profile offers, before the graph's own. A
   *  graph's group with the id of one of these is left out. */
  groups?: ViewOptionGroup[];
  /**
   * Told every change, from the reader or the host, once it is in force in
   * the diagrams and kept: the file (an absolute path), every group as it
   * stands, the lines turned and who turned them. A group marked `reload`
   * has the model asked for again besides; this is for the rest (a status
   * line, a chat context). A throw is logged and changes nothing.
   */
  onDidChange?(
    file: string,
    event: { groups: ViewOptionGroup[]; turns: ViewOptionTurn[]; origin: "reader" | "host" },
  ): void;
}

/**
 * v2 diagram profile — the complete activation contract at
 * `DIALOGRAM_API_VERSION` 0.3.0. It carries everything the platform needs to
 * activate a diagram for one consumer; NO external-tool/product vocabulary appears
 * here. External-tool-backed consumers assemble one with the toolkit's profile
 * builder.
 */
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
  /**
   * Neutral behavior flags forwarded into the diagram webview. Among them,
   * for a diagram whose content a webview surface draws (diagram-client
   * `diagram-surface.ts`, bound in the bundle `clientAssets` serves):
   * `zoomLimits` (the zoom range, GLSP's 0.1 to 20 by default; the surface's
   * own wins), `initialView` (`'fit'` fits a view the first time it is
   * opened, once its content has bounds; `'center'`, the default, centres it
   * at zoom 1) and `fitMaxZoom` (the largest zoom that fit, Fit and `reveal`
   * with `fit` take; `1` keeps a small diagram at its drawn size).
   */
  clientBehavior?: DiagramClientBehavior;
  /** Consumer-supplied webview bundle (script/style/resource-roots). When absent,
   *  the provider serves its stock `dist/webview/*` bundle. DATA ONLY — path/URI
   *  strings, never code objects. */
  clientAssets?: DiagramClientAssets;
  /**
   * Stylesheets served into the webview after the platform's own, whichever
   * bundle that is: the stock one or `clientAssets`. Absolute fs paths or
   * file-URI strings, DATA ONLY; each file's directory joins the webview's
   * `localResourceRoots`.
   *
   * The platform writes hooks it does not style: `<kind>-node` for a kind of
   * its own, `node-role-<role>` for what a node is to the picture (its
   * `meta.role`), `edge-role-<role>` for what a connection is, the family
   * classes. One it does style: `edge-tone-<tone>` (a connection's
   * `meta.tone`), `warning` and `error` in the editor's colours, over a
   * product's colour for the role.
   * A product that wants `refines` solid and `conflicts-with` red, or its pins
   * smaller, says so here in CSS and nowhere else, without composing a webview
   * bundle of its own for one stylesheet.
   *
   * A long node name breaks onto lines in its header. A product that wants
   * names on one line (code, say) turns it off with
   * `storageOptions.headerWrap: false`, or a producer per node with
   * `meta.headerWrap: false`; a node's `true` turns it back on.
   *
   * `edge-role-<role>` is on both an edge's outer group (`.sprotty-edge`) and
   * its line group inside it (`.workflow-edge`, which also carries `selected`
   * and `hover`). Style the line through the line group, giving way to the
   * selection: `.workflow-edge.edge-role-x:not(.selected):not(.hover)`. A rule
   * on the bare class matches both groups, so an `opacity` there applies
   * twice.
   *
   * An edge's line (`.edge-line`) carries `--edge-dash-offset`. A dashed role
   * that sets `stroke-dashoffset: var(--edge-dash-offset, 0px)` dashes in step
   * with the wires it shares a stretch with: counted back from its end where
   * more than one wire comes into that port, else from its start. Out of step,
   * wires sharing a stretch fill in each other's gaps and read as one solid
   * line.
   */
  clientStylesheets?: string[];
  /** Edit strategy: `'read-only'` disables writes; an editable strategy carries the
   *  consumer-supplied operation modules registered on the diagram server. */
  edits: EditStrategy;
  /** Factory for the graph model source (core ships no implementation). */
  modelSource?: () => DiagramModelSource;
  /** The outline's rows on demand, and its rows that are the product's; see {@link DiagramOutline}. */
  outline?: DiagramOutline;
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
   * before (byte-identical parity). `ctx.postToWebview` posts back to the
   * webview the message came from, and to it alone when two editors show the
   * file (`DiagramProfileHandle.postToWebview` reaches every editor of it);
   * `ctx.revealRange` opens a source URI and selects the range. Where
   * the file is not open in another group, it opens in the active one, the
   * diagram's, over the diagram; `{ beside: true }` opens it in the group beside
   * instead (see {@link RevealRangeOptions}).
   *
   * The webview side is `postToHost(message)` and `onHostMessage(listener)`
   * from `@dialogram/diagram-client` (a diagram surface gets both as
   * `context.host`): messages are objects with a string `type`, and types
   * starting with `dialogram.` or `chat.` are the platform's, refused there
   * and never heard. Reach for those, not for the page's VS Code API object,
   * which is the platform's and is not part of this contract. `ArrayBuffer`s
   * cross both ways.
   */
  onWebviewMessage?: (
    uri: string,
    message: unknown,
    ctx: {
      postToWebview(msg: unknown): void;
      revealRange(
        uriStr: string,
        range?: { startLine: number; startColumn?: number },
        options?: RevealRangeOptions,
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
  /**
   * What the platform watches on disk for changes made outside the editor (an
   * agent, git, a build), and which diagrams such a change reloads.
   *
   * `globs` are what is watched; absent, the globs follow from
   * {@link sourceExtensions} (every file, when it declares none), so `watch`
   * can carry `affects` alone. An empty list watches nothing on disk: only a
   * save in the editor reloads a diagram. A change to one of the product's
   * sources reloads every open diagram (one may import another); a file that
   * is not a source reloads nothing, unless `affects` is given.
   *
   * `affects` says which diagrams a change reloads: handed the changed file
   * and the files with a diagram open (URIs, as `vscode.Uri.toString()` spells
   * them, which is how `getGraph` was handed them), it returns the ones to
   * reload. It is asked about every file the globs see, source or not, so
   * that a side file (a manifest, a technology file) reloads the diagrams that
   * read it and no others; and about each save of a source in the editor. The
   * changed file's own diagram, when it has one, is reloaded whatever it
   * returns. Changes within a quarter of a second are taken together, and a
   * file under a build tree (`build/`, `out/`, `node_modules/`…) is never asked
   * about. A hook that throws reloads every open diagram. Absent, a change
   * reloads what it always did.
   */
  watch?: {
    globs?: string[];
    affects?: DiagramWatchAffects;
  };
  /**
   * A file's first diagram editor has opened. Called once per file, however
   * many editors are then opened on it, with the URI the editor is on (as
   * `vscode.Uri.toString()` spells it). What it throws or rejects is logged.
   */
  onEditorOpened?: (uri: string) => void | Promise<void>;
  /**
   * The last diagram editor of a file has closed: nothing the product keeps
   * for that file's diagram has a reader any more. Called once, with the last
   * editor, and not when one of two editors on the file closes. A load still
   * running for it has been told already (`ModelSourceOptions.signal`). Not
   * called when the window closes: the extension host is going, and
   * `deactivate` is where to let go of everything at once.
   */
  onEditorClosed?: (uri: string) => void | Promise<void>;
  /**
   * The words the loading indicator shows for the platform's own steps of a
   * load ("Reading top.def", "Drawing the diagram | 1 node, 0 edges",
   * "Laying out the diagram", "Routing the connections"), or none.
   *
   * The platform's words are about a graph of nodes and edges. A product
   * whose graph is a frame for content it streams afterwards says what its
   * reader is really waiting for, or nothing: given the step, the platform's
   * words and the facts they were made from (the file, the node and edge
   * counts), it returns other words, `false` to say nothing at that step, or
   * nothing to keep the platform's. Called on the extension host, for a load
   * somebody is waiting on. A hook that throws says nothing at that step.
   * What the product says while it reads (`ModelSourceOptions.progress`) and
   * after (`DiagramProfileHandle.loading`) is its own and not passed here.
   */
  loadPhaseWords?: LoadPhaseWords;
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
  /**
   * The Java ELK server this product ships, for laying out large graphs.
   * `jar` is the server's fat jar, relative to the extension's root or
   * absolute. With it, `<settingsNamespace>.layout.engine` (`auto`, the
   * default; `elkjs`; `elk-server`) picks the engine, and `.layout.javaPath`,
   * `.layout.javaOpts` and `.layout.serverTimeoutMs` tune the process; see
   * diagram-server `elk-server/`. Absent, every layout runs on elkjs.
   */
  elkServer?: { jar: string };
  /** Run driver factory; when absent no run/stop commands or live glow are wired. */
  runDriver?: DiagramRunDriverFactory;
  /** Node states from a report the product's tool makes, shown on demand with
   *  the run overlay's drawing; independent of {@link runDriver}. */
  statusSource?: DiagramStatusSource;
  /** Registers the new-source-file (and any edit-backend) commands; returns their disposable. */
  newSourceFile?: (context: vscode.ExtensionContext) => vscode.Disposable;
  /** What a reader may show and hide, in the palette; see {@link DiagramViewOptions}. */
  viewOptions?: DiagramViewOptions;
}

/**
 * Where `ctx.revealRange` (in {@link DiagramProfile.onWebviewMessage}) shows a
 * source. Left out, it is shown as it always was: in the group the file is
 * already open in, else in the active group, which is the diagram's own, so
 * the text covers the diagram, and with the focus moved to it.
 */
export interface RevealRangeOptions {
  /**
   * Keep the diagram in sight: show the file in a group other than the
   * diagram's where it is open there, else in the group beside (opening one
   * where there is none). A "Go to source" from a diagram the user is still
   * reading wants this.
   */
  beside?: boolean;
  /** Leave the focus where it is (on the diagram) rather than on the text. */
  preserveFocus?: boolean;
}

/**
 * Which of the open diagrams a change to a watched file reloads
 * (`DiagramProfile.watch.affects`).
 *
 * @param changed the changed file, as `vscode.Uri.toString()` spells it.
 * @param open the files with a diagram open, spelled the same way.
 * @returns the files of `open` whose diagrams to reload; nothing for none.
 */
export type DiagramWatchAffects = (
  changed: string,
  open: readonly string[],
) =>
  | readonly string[]
  | undefined
  | void
  | Promise<readonly string[] | undefined | void>;

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
   * Show a row in the outline of every open diagram of the file at `uri` (a
   * URI string, a `vscode.Uri` or an absolute path): its group opened, the
   * page it is on fetched, the row selected and scrolled into view; the
   * panel opened too with `show`. For the product's own selection (a row
   * picked elsewhere) to be the outline's. Returns how many diagrams were
   * told; none when no diagram of the file is open.
   *
   * Absent on a Dialogram older than this, which reports the same API
   * version: call it as `handle.revealOutlineRow?.(...)`.
   */
  revealOutlineRow?(uri: string | vscode.Uri, row: OutlineRowReveal): number;
  /**
   * Dispatch a host→client action to every diagram editor open on `uri` (a
   * file can have two, after View: Split Editor Right), over the ungated
   * `sendMessageToClient` overlay-bridge path — it reaches the client even for
   * kinds the client did not advertise in `clientActions`. No-op when no diagram
   * client is registered for the URI.
   */
  dispatchToWebview(
    uri: string,
    action: { kind: string } & Record<string, unknown>,
  ): void;
  /**
   * Post a raw message straight to the webview of every diagram editor open
   * on `uri` (`webview.postMessage`; a file can have two), for the consumer's
   * own cursor-sync / graph-era channel; a diagram surface hears it on
   * `context.host`. To answer one editor, answer through the `ctx` of
   * {@link DiagramProfile.onWebviewMessage}. No-op when no panel is
   * registered for the URI.
   */
  postToWebview(uri: string, message: unknown): void;
  /**
   * The loading indicator of a file's diagram, for what the product does
   * for that diagram outside `getGraph`: a layout it streams in after the
   * platform has drawn the graph, a second pass, a reload of its own.
   *
   * `report` shows what is being done (`message`, and an optional `detail`)
   * on every editor of `uri`: centred while the diagram is still empty, as a
   * pill near the top once it has a picture, and then only once the wait
   * passes 300 ms. `end` takes it down. Words are trimmed to one line each,
   * and words with no message show nothing. A file with no diagram open is
   * told nothing. The same indicator the platform's own load uses: what is
   * said last shows, whoever said it.
   *
   * Absent on a Dialogram older than this, which reports the same API
   * version: call it as `handle.loading?.report(...)`.
   */
  loading?: {
    report(uri: string, progress: LoadProgress): void;
    end(uri: string): void;
  };
  /**
   * The view options of the file at `uri` (a URI string, a `vscode.Uri` or
   * an absolute path) as they stand: every group its graphs have declared
   * since the window opened, the newest declaration of each with the lines
   * an older one declared that it lacks (two editors of the file can show
   * views that declare different groups, or one group with other lines), or
   * the profile's when no diagram of it has been opened yet, with the
   * reader's choices applied. See {@link DiagramViewOptions}.
   *
   * Absent on a Dialogram older than this, which reports the same API
   * version: check for it before calling.
   */
  getViewOptions?(uri: string | vscode.Uri): Promise<ViewOptionGroup[]>;
  /**
   * Change the view options of the file at `uri`, as the host: each change
   * in turn (a line, `all` of a group, `only` one line), kept for the file,
   * shown in every diagram of it and told to `viewOptions.onDidChange`. A
   * line of a group no graph of the file has declared yet is kept, and
   * applies when one does. Resolves to the groups as they stand.
   *
   * Absent on a Dialogram older than this, which reports the same API
   * version: check for it before calling.
   */
  setViewOptions?(
    uri: string | vscode.Uri,
    changes: ViewOptionChange | ViewOptionChange[],
  ): Promise<ViewOptionGroup[]>;
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
