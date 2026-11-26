import { inject, injectable, optional, postConstruct } from 'inversify';
import { IDiagramStartup, ISelectionListener } from '@eclipse-glsp/client';
import { CHAT_IMAGE_MAX_COUNT, chatImageRefusal, type ChatImage, type SurfaceSelectionSummary } from '@dialogram/shared';
import { DiagramSurfaceHost } from './diagram-surface-host';
import { summarizeSurfaceSelection } from './diagram-surface';
import { raiseFloatingPanel, stackAsFloatingPanel } from './floating-panels';
import { Messenger } from 'vscode-messenger-webview';
import { DiagramWebviewChannel, getDiagramWebviewChannel } from './webview-channel';
import { NotificationType } from 'vscode-messenger-common';
import { html, render, nothing, TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdownSafe } from './markdown';
import { formatAgentOutputs } from './agent-outputs';
import { shouldStick } from './chat-scroll';
import { CHAT_RESIZE_EDGES, restoreChatSize, startChatResize } from './chat-resize';
import { diagramPng } from './diagram-picture';
import { carriesImages, imageFiles, imageSrc, readImageFile } from './chat-images';
import {
  RunAgentStreamActionHandler,
  type LiveAgentPart,
  type LiveAgentQuestion,
  type LiveAgentState
} from './editing-action-handlers';

/**
 * Memoized markdown → HTML. The chat template runs `renderMarkdownSafe` for every
 * message on every render; during streaming that re-parses all prior messages
 * each frame. Message content is immutable once rendered, so cache by content
 * (bounded LRU-ish) to parse each message exactly once.
 */
const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_MAX = 500;
/**
 * An agent's answer arrives as one JSON object whose port values are
 * themselves JSON, so a diff reaches the chat escaped twice and renders as a
 * paragraph of `\n`. Reformat that as Markdown before parsing it; anything
 * else is returned unchanged.
 */
function readable(content: string): string {
  return formatAgentOutputs(content) ?? content;
}

function renderMarkdownMemo(md: string): string {
  const cached = markdownCache.get(md);
  if (cached !== undefined) {
    // Refresh recency.
    markdownCache.delete(md);
    markdownCache.set(md, cached);
    return cached;
  }
  const out = renderMarkdownSafe(md);
  markdownCache.set(md, out);
  if (markdownCache.size > MARKDOWN_CACHE_MAX) {
    const oldest = markdownCache.keys().next().value;
    if (oldest !== undefined) markdownCache.delete(oldest);
  }
  return out;
}

// VS Code-native form controls (web components, theme-aware).
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';

/**
 * Chat travels over the GLSP `vscode-messenger` channel (GLSP owns the diagram
 * webview's message channel; raw postMessage is dropped). These method names
 * MUST match the constants in `extension/.../chatbox-integration.ts`.
 */
interface ChatEnvelope {
  type: string;
  data: any;
}
const ChatToHost: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toHost' };
const ChatToClient: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toClient' };

/** Minimal shape of the VS Code webview API. */
interface WebviewApiLike {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare const acquireVsCodeApi: () => WebviewApiLike;

/**
 * Resolve the single VS Code webview API instance. The diagram webview's inline
 * bootstrap caches it on `window.__calVscodeApi` (acquireVsCodeApi may only be
 * called once per webview).
 */
function getWebviewApi(): WebviewApiLike | undefined {
  const w = globalThis as any;
  if (w.__calVscodeApi?.postMessage) return w.__calVscodeApi;
  if (typeof acquireVsCodeApi === 'function') {
    try {
      return acquireVsCodeApi();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── Timeline model ──────────────────────────────────────────────────────────

type Role = 'user' | 'assistant' | 'system';

interface MessageItem {
  kind: 'message';
  role: Role;
  content: string;
  timestamp: number;
  mode?: 'plan' | 'build';
  /** opencode message id (user messages only) — enables "revert to here". */
  messageId?: string;
  /** Assistant reasoning, shown as a collapsible "Thinking" block. */
  thinking?: string;
  /** The images a message the user sent carried, shown under it. */
  images?: ChatImage[];
  /** How many images a restored message carried: their bytes are not kept. */
  imageCount?: number;
  /** Pictures a message of the platform's own shows (the untangle's two drawings). */
  figures?: ChatFigure[];
  /** The stored message's key: one added on catching up is not shown twice. */
  key?: string;
}

/** A picture the platform shows in the chat: a PNG, base64, and what it shows. */
interface ChatFigure {
  data: string;
  caption?: string;
}

/** The pictures in `value`, as the host sent them; none that is not one. */
function figuresOf(value: unknown): ChatFigure[] {
  return Array.isArray(value)
    ? value
        .filter((each): each is ChatFigure => typeof each?.data === 'string' && each.data !== '')
        .map((each) => ({ data: each.data, ...(typeof each.caption === 'string' ? { caption: each.caption } : {}) }))
    : [];
}

interface ToolItem {
  kind: 'tool';
  id: string;
  title: string;
  status?: string;
  /** The stored message's key: one added on catching up is not shown twice. */
  key?: string;
}

interface PermissionItem {
  kind: 'permission';
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  resolved?: 'allowed' | 'denied';
}

/** The platform asking the person to confirm something the session's agent proposed. */
interface ConfirmItem {
  kind: 'confirm';
  id: string;
  title: string;
  text: string;
  choices: string[];
  /** Pictures of what is to be confirmed. */
  figures?: ChatFigure[];
  /** The button pressed, or `null` once declined. */
  resolved?: string | null;
}

type TimelineItem = MessageItem | ToolItem | PermissionItem | ConfirmItem;

/**
 * What the panel shows: the diagram's own session with its agent, or one of
 * the run's agents, read only (its transcript and its questions).
 */
type ChatView = { kind: 'session' } | { kind: 'agent'; instance: string };

interface SessionEntry {
  id: string;
  name: string;
}

interface ModelEntry {
  id: string;
  name: string;
}

interface CommandEntry {
  command: string;
  description: string;
  usage?: string;
}

/**
 * Integrated Chat Panel for the GLSP Diagram Webview.
 *
 * Embedded in the diagram webview itself (not a separate window); slides up
 * from the bottom. Rendering is declarative (lit-html): all UI is a function of
 * the panel state, re-rendered on every state change. Controls use
 * @vscode-elements/elements + codicons for a native VS Code look.
 *
 * Communication with the extension host happens over the GLSP vscode-messenger
 * channel (the diagram webview's raw postMessage is owned by GLSP).
 */

/**
 * The view on screen, as a trail from the editor's root, when it is not the
 * root itself.
 *
 * The chat is the root's for the whole hierarchy, so without this the agent
 * cannot tell that the diagram shows a nested workflow -- nor which instance
 * the selected nodes belong to.
 */
export function currentViewTrail(): Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }> | undefined {
  const trail = (globalThis as any).__calDiagramContext?.trail;
  return Array.isArray(trail) && trail.length > 1 ? trail : undefined;
}

@injectable()
export class ChatPanel implements IDiagramStartup, ISelectionListener {
  /** Run after the diagram model is ready so the webview DOM exists. */
  rank = 100;

  private initialized = false;

  private static readonly VISIBLE_BODY_CLASS = 'workflow-chat-visible';

  // ── DOM hosts ──
  private panel: HTMLElement | null = null;

  // ── State (single source of truth for the rendered UI) ──
  private isVisible = false;
  private isCompact = false;
  private currentMode: 'plan' | 'build' = 'build';
  /** The mode the turn in progress was sent in: its reply's, though the mode is switched while it runs. */
  private turnMode: 'plan' | 'build' | undefined;
  /** The session this panel asked for ("+", a task, a message sent with no
   *  chat open) and waits for, by the id the host says back; one it no longer
   *  waits for (left for a chat picked, or for a task) is listed, not shown. */
  private createRequest: string | undefined;
  private createCount = 0;
  /** The message sent once that session exists: a task's, or one sent with no
   *  chat open. Until then another waits in the composer. */
  private pendingSend: { text: string; images: ChatImage[]; fromComposer: boolean } | undefined;
  /** A picture opened at full size over the panel (`figuresTemplate`). */
  private openFigure: ChatFigure | undefined;
  private currentSessionId: string | null = null;
  private timeline: TimelineItem[] = [];
  private sessions: SessionEntry[] = [];
  private models: ModelEntry[] = [];
  private currentModel = '';
  /** True when the session is in a reverted state (shows the redo banner). */
  private reverted = false;
  private connection: 'unknown' | 'connected' | 'disconnected' = 'unknown';
  private connectionReason = '';
  /** The ACP connector the chat is (or was) connected to, as the host names it. */
  private connectionAgent = '';
  private inputValue = '';
  /** Images to send with the next message: pasted, dropped, or a picture of the diagram. */
  private pendingImages: ChatImage[] = [];
  /** The message last sent, and its row, until the host answers: one it does not send is put back. */
  /** Per chat, the message last sent in it, kept until the host answers, so a
   *  message it does not send goes back where it came from (one sent since in
   *  another chat is not it). */
  private sentIn = new Map<string, { row: TimelineItem; text: string; images: ChatImage[]; fromComposer: boolean }>();
  /** The chat the last message went to: a refusal that names none is for it. */
  private lastSentIn: string | undefined;
  /** Whether the agent reads images, as the host says; unknown until it says. */
  private agentTakesImages: boolean | undefined;
  /** True while a picture of the diagram is drawn for the next message. */
  private takingPicture = false;
  private view: ChatView = { kind: 'session' };
  /** A running agent's question that arrived while the user was typing in
   *  the session: shown as a banner instead of switching the view. */
  private runBanner: LiveAgentQuestion | null = null;

  /** Live diagram selection (node ids), mirrored to the host for chat context. */
  private selectedNodeIds: string[] = [];
  /** What a diagram surface has selected, as the chat is told it. */
  private surfaceSelection: SurfaceSelectionSummary | undefined;

  @inject(DiagramSurfaceHost) @optional()
  protected readonly surfaceHost: DiagramSurfaceHost | undefined;

  /**
   * True from the moment a session's history is restored until the user sends the
   * next message. opencode replays the conversation as `session/update`
   * notifications on `session/load`; that replay tail must not stream in as a
   * phantom row duplicating the just-restored trailing message. Cleared on send,
   * when a real (user-initiated) turn begins.
   */
  private suppressReplayStream = false;

  /** In-progress assistant reply (streamed chunks). */
  private streamingText = '';
  /** Reasoning streamed during the in-flight turn (shown as a live Thinking block). */
  private streamingThinking = '';
  private isStreaming = false;
  private showTyping = false;
  /** True while a session load/create round-trip is in flight (shows a loading row). */
  private isLoadingSession = false;
  /** Label shown in the loading row (load vs create). */
  private loadingLabel = 'Loading session…';
  /** Pending requestAnimationFrame id for a coalesced re-render (see scheduleUpdate). */
  private pendingFrame: number | null = null;

  /** Slash-command menu. */
  private availableCommands: CommandEntry[] = [];
  private menuItems: CommandEntry[] = [];
  private menuIndex = -1;

  /** Handshake bookkeeping for the connection-status indicator. */
  private receivedStatus = false;
  private statusHandshakeTimer: number | null = null;
  private lastStatusKey = '';
  /** The "Not connected" row of a disconnection since taken back by a connect. */
  private disconnectedRow: TimelineItem | undefined;
  /**
   * Number of `chat.ready` posts made so far (initial + retries). If the host
   * hasn't wired its chat messenger yet (it may still be spawning opencode), the
   * first `chat.ready` is dropped; we re-post with backoff before declaring the
   * channel dead. Capped at {@link ChatPanel.MAX_READY_ATTEMPTS}.
   */
  private readyAttempts = 0;
  private static readonly MAX_READY_ATTEMPTS = 3;
  private static readonly HANDSHAKE_TIMEOUT_MS = 5000;

  /** The canonical host↔webview channel (shared GLSP messenger). */
  private channel: DiagramWebviewChannel | null = null;

  /**
   * IDiagramStartup hook — runs once the diagram model is initialized and the
   * webview DOM is available. This is what actually causes the panel + floating
   * toggle button to be created (the DI singleton is otherwise never resolved).
   */
  postModelInitialization(): void {
    this.initialize();
  }

  /**
   * GLSP selection changed: track the ids, push them to the host (so the chat
   * context always reflects the live selection) and refresh the composer hint.
   */
  selectionChanged(_root: unknown, selectedElements: string[]): void {
    this.selectedNodeIds = selectedElements ?? [];
    this.postSelection();
  }

  /**
   * A diagram surface's selection (`diagram-surface.ts`) is the chat's
   * selection too: it rides on the same `chat.selection` beside the node
   * ids, and on every message sent, so the host's context says what it is.
   */
  @postConstruct()
  protected listenToSurface(): void {
    this.surfaceHost?.onSelectionChanged(selection => {
      this.surfaceSelection = selection ? summarizeSurfaceSelection(selection) : undefined;
      this.postSelection();
    });
  }

  private postSelection(): void {
    this.sendToHost('chat.selection', {
      selectedNodeIds: this.selectedNodeIds,
      surfaceSelection: this.surfaceSelection,
      viewTrail: currentViewTrail(),
    });
    if (this.initialized) this.update();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.createHost();
    this.createToggleButton();
    this.setupMessageListener();
    // The run's agents stream into the same live state the "Running agents"
    // bar renders; the panel shows them too, as a read-only viewer.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('dialogram.runAgents.updated', () => this.update());
      window.addEventListener('dialogram.chat.showAgent', (e) => {
        const instance = (e as CustomEvent<{ instance?: string }>).detail?.instance;
        if (instance) this.showAgent(instance);
      });
      // Another window on the same folder (a local one, a Remote-SSH one) may
      // have made, extended or deleted a chat since: look again when this one
      // is come back to.
      window.addEventListener('focus', () => this.catchUp());
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.catchUp();
        });
      }
    }
    this.update();
    this.requestState();
  }

  /** When the sessions were last asked for on coming back to the window. */
  private lastCatchUp = 0;

  /**
   * Ask for the sessions again, naming the one shown unless a turn is running
   * or one is loading, so the host can bring its transcript up to date.
   */
  private catchUp(): void {
    const now = Date.now();
    if (now - this.lastCatchUp < 1000) return;
    this.lastCatchUp = now;
    const shown = this.currentSessionId && !this.isStreaming && !this.isLoadingSession
      ? this.currentSessionId
      : undefined;
    // With the stored messages it shows, by key: the host sends the others.
    const keys = this.timeline.map((t: any) => t.key).filter((k: unknown): k is string => typeof k === 'string');
    // And how many rows of the transcript have none: shown as they came.
    const unkeyed = this.timeline.filter(
      (t: any) => !t.key && (t.kind === 'tool' || (t.kind === 'message' && (t.role === 'user' || t.role === 'assistant')))
    ).length;
    this.sendToHost('chat.getSessions', shown ? { shown, keys, unkeyed } : undefined);
  }

  // ── The view: the session, or one of the run's agents ─────────────────

  /** Show a running agent's transcript (and open the panel). */
  showAgent(instance: string): void {
    this.view = { kind: 'agent', instance };
    if (this.runBanner?.agent === instance) this.runBanner = null;
    this.show();
    this.update();
    this.announceRunView();
  }

  /** Back to the diagram's own session. */
  showSession(): void {
    this.view = { kind: 'session' };
    this.update();
    this.announceRunView();
  }

  /** The Run segment: the agent with a question waiting, else the latest. */
  private openRun(): void {
    const agents = RunAgentStreamActionHandler.getAgents();
    const target = agents.find((a) => a.pendingQuestions > 0) ?? agents[0];
    if (target) this.showAgent(target.instance);
  }

  /** The bar on the canvas hides while the panel shows a running agent. */
  private announceRunView(): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const visible = this.isVisible && this.view.kind === 'agent';
    window.dispatchEvent(new CustomEvent('dialogram.chat.runView', { detail: { visible } }));
  }

  /** The user is in the middle of a message to the session. */
  private isComposing(): boolean {
    return this.view.kind === 'session' && (this.inputValue.trim().length > 0 || this.pendingImages.length > 0);
  }

  // ── Transport ───────────────────────────────────────────────────────────

  /**
   * The document URI of the diagram this panel lives in, exposed by the webview
   * bootstrap. The active text editor is unreliable here because a focused GLSP
   * diagram is a custom editor, not a text editor.
   */
  private get workflowUri(): string | undefined {
    return (globalThis as any).diagramIdentifier?.uri;
  }

  /** The GLSP client id of the diagram this panel lives in: which of a file's editors spoke. */
  private get diagramClientId(): string | undefined {
    return (globalThis as any).diagramIdentifier?.clientId;
  }

  /**
   * Send a chat message to the extension host over the GLSP messenger channel.
   * Every message carries the diagram's workflow URI so the host can scope the
   * session even when there is no active text editor, and the diagram's client
   * id, so a command acts on this editor's diagram of the file.
   */
  private sendToHost(type: string, data: any = {}): boolean {
    if (!this.channel) return false;
    this.channel.sendToHost(ChatToHost.method, {
      type,
      data: { workflowUri: this.workflowUri, diagramClientId: this.diagramClientId, ...data },
    });
    return true;
  }

  /** Ship a diagnostic line to the extension's "Workflow Chat" log channel. */
  private log(message: string): void {
    // eslint-disable-next-line no-console
    console.log(`[chat-panel] ${message}`);
    this.sendToHost('chat.log', { message });
  }

  /**
   * Set up the vscode-messenger transport and register the inbound handler.
   * This is the channel GLSP itself uses, so it reliably reaches the extension.
   */
  private setupMessageListener(): void {
    const onToClient = (env: { type?: string; data?: unknown }) => {
      if (!env || typeof env.type !== 'string') return;
      this.handleIncomingMessage(env.type, env.data);
    };

    // Prefer the canonical channel over GLSP's messenger — the instance that
    // actually receives host notifications. Registering `dialogram/chat/toClient`
    // on a SEPARATE Messenger (as this used to) meant the host's replies were
    // processed by the GLSP instance, which had no handler for them → "unknown
    // method" → the chat connection indicator stuck on "disconnected". The
    // channel composes, so this handler coexists with the overlay/model routes.
    // See webview-channel.ts.
    const channel = getDiagramWebviewChannel();
    if (channel) {
      this.channel = channel;
      channel.onNotification(ChatToClient.method, (params) => onToClient(params as { type?: string; data?: unknown }));
      // The GLSP bootstrap already called start(); no second start needed.
      return;
    }

    const api = getWebviewApi();
    if (!api) {
      this.log('no VS Code webview API available');
      return;
    }
    // Degenerate load order (no GLSP messenger yet): stand up a private channel
    // over our own Messenger so chat still functions.
    const fallback = new DiagramWebviewChannel(new Messenger(api as any) as never);
    fallback.onNotification(ChatToClient.method, (params) => onToClient(params as { type?: string; data?: unknown }));
    fallback.start();
    this.channel = fallback;
  }

  private requestState(): void {
    this.log('panel initialized; posting chat.ready');
    this.readyAttempts = 1;
    const posted = this.sendToHost('chat.ready');
    this.log(`chat.ready posted=${posted}`);
    this.loadProviders();
    this.loadSessions();
    this.loadCommands();

    if (!posted) {
      this.setConnectionStatus(false, 'Chat messenger unavailable in webview');
      return;
    }

    // The host may not have wired its chat messenger yet (it is still spawning
    // opencode), in which case this first `chat.ready` was dropped. Re-post with
    // backoff before declaring the channel dead; a real `connectionStatus`
    // cancels the pending retries (see setConnectionStatus).
    this.scheduleHandshakeTimeout();
  }

  /**
   * Arm the handshake watchdog. On expiry, if no `connectionStatus` has arrived,
   * re-post `chat.ready` (up to {@link ChatPanel.MAX_READY_ATTEMPTS} total) and
   * re-arm; only after the final attempt still goes unanswered do we surface the
   * disconnected/timeout state.
   */
  private scheduleHandshakeTimeout(): void {
    this.statusHandshakeTimer = setTimeout(() => {
      this.statusHandshakeTimer = null;
      if (this.receivedStatus) return;
      if (this.readyAttempts < ChatPanel.MAX_READY_ATTEMPTS) {
        this.readyAttempts += 1;
        this.log(`retrying chat.ready (attempt ${this.readyAttempts})`);
        this.sendToHost('chat.ready');
        this.scheduleHandshakeTimeout();
        return;
      }
      this.log('TIMEOUT: no chat.connectionStatus received within 5s');
      this.setConnectionStatus(false, 'No response from extension host');
    }, ChatPanel.HANDSHAKE_TIMEOUT_MS) as unknown as number;
  }

  // ── Inbound protocol ────────────────────────────────────────────────────

  private handleIncomingMessage(type: string, data: any): void {
    switch (type) {
      case 'chat.message':
        // A note for another chat than the one shown (switched from since).
        if (typeof data?.sessionId === 'string' && data.sessionId !== this.currentSessionId) break;
        this.finishStreamingMessage();
        if (data) {
          this.pushMessage(data.role ?? 'system', data.content ?? '', data.mode, data.timestamp);
          const figures = figuresOf(data.figures);
          const row = this.timeline[this.timeline.length - 1];
          if (figures.length > 0 && row?.kind === 'message') {
            row.figures = figures;
            this.update();
          }
        }
        break;

      case 'chat.sessionUpdate':
        this.handleSessionUpdate(data?.notification);
        break;

      case 'chat.providers':
        this.models = Array.isArray(data?.providers)
          ? data.providers
              .filter((p: any) => typeof p?.id === 'string')
              .map((p: any) => ({ id: p.id, name: p.name || p.id }))
          : [];
        if (typeof data?.current === 'string' && data.current) {
          this.currentModel = data.current;
        }
        this.update();
        break;

      case 'chat.sessions':
        this.sessions = Array.isArray(data?.sessions)
          ? data.sessions
              .filter((s: any) => typeof s?.id === 'string')
              .map((s: any) => ({ id: s.id, name: s.name || s.id }))
          : [];
        this.update();
        break;

      case 'chat.sessionCreated':
        // Not the one this panel waits for (a request it left), or, from a host
        // that names no request, one made while it waits for none and a chat is
        // shown: listed.
        if (
          typeof data?.requestId === 'string'
            ? data.requestId !== this.createRequest
            : !this.createRequest && this.currentSessionId && this.currentSessionId !== data?.session?.id
        ) {
          this.loadSessions();
          break;
        }
        this.createRequest = undefined;
        this.isLoadingSession = false;
        // An answer that names no session: the message waiting goes back.
        if (!data?.session?.id) this.restorePending();
        if (data?.session?.id) {
          this.currentSessionId = data.session.id;
          // A fresh session starts with an empty transcript — clear whatever the
          // previous session left on screen so its rows don't leak in. A brand-new
          // session has no history to replay, so drop the replay guard too, and
          // runs no turn: one still running is another session's.
          this.clearTimeline();
          this.setStreaming(false);
          this.suppressReplayStream = false;
          this.loadSessions();
          this.pushMessage('system', `Created session: ${data.session.name ?? data.session.id}`);
        }
        this.update();
        // The message it was made for (a task's, or one sent with no chat
        // open): sent now, so it is in the transcript like any other.
        if (data?.session?.id && this.pendingSend) {
          const pending = this.pendingSend;
          this.pendingSend = undefined;
          this.sendPrompt(pending.text, pending.images, pending.fromComposer);
        }
        break;

      case 'chat.startTask':
        // The host asks for a task in a new session: "Fix with AI" on a run
        // that failed. Open the panel, start the session in the task's mode,
        // and send its message once the session exists.
        if (data && typeof data.prompt === 'string' && data.prompt.trim() !== '') {
          const mode: 'plan' | 'build' = data.mode === 'build' ? 'build' : 'plan';
          const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name : 'Task';
          // A message waiting for a session gives way: it goes back to the
          // composer. Its prompt alone: what the composer holds stays there.
          this.restorePending();
          this.pendingSend = { text: data.prompt.trim(), images: [], fromComposer: false };
          this.currentMode = mode;
          this.isLoadingSession = true;
          this.loadingLabel = 'Creating session…';
          this.autoShow('task');
          this.update();
          // Its own session, named and in its mode; one asked for before is
          // no longer waited for.
          this.requestSession({ mode, name });
        }
        break;

      case 'chat.sessionCreateAborted':
        // One no longer waited for: nothing to drop.
        if (typeof data?.requestId === 'string' && data.requestId !== this.createRequest) break;
        // Name prompt cancelled, or the session not made — drop the "Creating
        // session…" spinner; a message waiting for it goes back to the composer.
        this.isLoadingSession = false;
        this.createRequest = undefined;
        this.restorePending();
        this.update();
        break;

      case 'chat.messageIds':
        this.applyMessageIds(data);
        break;

      case 'chat.sessionHistory':
        // Sent on coming back to the window: a turn started since, or
        // another session chosen, is not to be redrawn under it.
        if (data?.catchUp && (this.isStreaming || this.isLoadingSession || data.sessionId !== this.currentSessionId)) {
          break;
        }
        // A history only follows a request (a load, a revert) for the chat
        // shown: one for another comes late, for a chat left (or while a session
        // is awaited and none is shown), and is not drawn.
        if (data?.sessionId !== this.currentSessionId && (this.currentSessionId || this.createRequest)) break;
        this.renderSessionHistory(data);
        break;

      case 'chat.sessionAppend':
        this.appendSessionMessages(data);
        break;

      case 'chat.sessionDeleted':
        this.loadSessions();
        // Another chat than the one shown (one switched from since asking):
        // the list says it, not this one's transcript.
        if (data?.sessionId !== this.currentSessionId) break;
        // Opened from a list another window had made stale: no history comes.
        this.isLoadingSession = false;
        this.currentSessionId = data?.nextSessionId ?? null;
        this.clearTimeline();
        if (data?.nextSessionId) {
          this.loadSession(data.nextSessionId);
        } else {
          this.pushMessage(
            'system',
            typeof data?.reason === 'string' && data.reason
              ? data.reason
              : 'Session deleted. Create or select a session to continue.'
          );
        }
        break;

      case 'chat.sessionRenamed':
        this.loadSessions();
        break;

      case 'chat.modeChanged':
        if (data?.mode === 'plan' || data?.mode === 'build') {
          this.applyMode(data.mode);
        }
        break;

      case 'chat.providerChanged':
        if (data?.provider) {
          this.currentModel = data.provider;
          this.update();
        }
        break;

      case 'chat.connectionStatus':
        if (!data?.connected && data?.connecting) {
          this.setConnecting();
        } else {
          this.setConnectionStatus(!!data?.connected, data?.reason, data?.agent, data?.images);
        }
        break;

      case 'chat.commands':
        this.availableCommands = Array.isArray(data?.commands) ? data.commands : [];
        break;

      case 'chat.messageNotSent':
        this.messageNotSent(data);
        break;

      case 'chat.turnEnd':
        if (!data?.sessionId || data.sessionId === this.currentSessionId) {
          this.finishStreamingMessage();
          this.setStreaming(false);
        }
        break;

      case 'chat.runQuestion':
        if (data && (typeof data.id === 'number' || typeof data.id === 'string') && typeof data.question === 'string') {
          const question: LiveAgentQuestion = {
            id: data.id,
            agent: typeof data.agent === 'string' && data.agent ? data.agent : 'agent',
            model: typeof data.model === 'string' ? data.model : undefined,
            question: data.question,
            context: typeof data.context === 'string' && data.context ? data.context : undefined,
            choices: Array.isArray(data.choices) ? data.choices.map(String) : [],
          };
          RunAgentStreamActionHandler.addQuestion(question.agent, question);
          if (this.isComposing()) {
            // Do not pull the user out of a message: a banner, and the Run segment's badge.
            this.runBanner = question;
            this.update();
          } else {
            this.view = { kind: 'agent', instance: question.agent };
            this.update();
          }
          this.autoShow('run-question');
          this.announceRunView();
        }
        break;

      case 'chat.confirm':
        if (data && typeof data.id === 'string' && typeof data.text === 'string' && Array.isArray(data.choices)) {
          const figures = figuresOf(data.figures);
          this.timeline.push({
            kind: 'confirm',
            id: data.id,
            title: typeof data.title === 'string' ? data.title : 'Confirm',
            text: data.text,
            choices: data.choices.map(String),
            ...(figures.length > 0 ? { figures } : {}),
          });
          // It is the session's agent that proposed it: show the session.
          if (this.view.kind !== 'session') this.showSession();
          else this.update();
          this.autoShow('confirm');
        }
        break;

      case 'chat.permissionRequest':
        if (data?.requestId) {
          this.showTyping = false;
          this.timeline.push({
            kind: 'permission',
            requestId: data.requestId,
            title: data.title ?? 'Tool call',
            options: Array.isArray(data.options) ? data.options : [],
          });
          this.update();
          this.autoShow('permission-request');
        }
        break;

      case 'chat.error':
        // A session asked for is still awaited: the host says whether it was
        // made, and "Creating session…" stays until it does.
        if (!this.createRequest) this.isLoadingSession = false;
        this.finishStreamingMessage();
        // The unified runtime eagerly connects on the chat.ready handshake, so
        // connection errors arrive without any user interaction — record them
        // but never pop the drawer open for background chatter. When the error
        // follows a user action the panel is already open. One the connection
        // status already carries has its row there.
        if (!data?.inStatus) {
          this.pushMessage('system', `Error: ${data?.message ?? 'Unknown error'}`, undefined, undefined, { reveal: false });
        }
        break;
    }
  }

  /**
   * Handle a streamed ACP session/update notification from opencode. Assistant
   * text arrives as `agent_message_chunk` pieces accumulated into one row.
   */
  private handleSessionUpdate(notification: any): void {
    const update = notification?.update;
    if (!update) return;

    // Ignore updates for a session that is no longer active (race when the
    // user switches sessions while a previous turn is still streaming).
    const updSession = notification?.sessionId;
    if (updSession && this.currentSessionId && updSession !== this.currentSessionId) {
      return;
    }

    // Drop the session/load replay tail: after history is restored, opencode
    // re-streams the conversation, which would otherwise duplicate the trailing
    // message. A real turn (the user sending) clears this guard first.
    if (this.suppressReplayStream) {
      return;
    }

    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = this.extractText(update.content);
      if (text) {
        this.showTyping = false;
        // Keep reasoning separate from the answer so it can render as its own block.
        if (kind === 'agent_thought_chunk') {
          this.streamingThinking += text;
        } else {
          this.streamingText += text;
        }
        // Coalesce re-renders to one per animation frame so streaming doesn't
        // starve the diagram (both share this webview's single thread).
        this.scheduleUpdate();
        this.autoShow('stream-chunk');
      }
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.upsertToolCall(update);
    }
  }

  /**
   * Render or update a tool-call activity line in place as the call progresses
   * (pending → in_progress → completed/failed).
   */
  private upsertToolCall(update: any): void {
    const id = update.toolCallId ?? update.id ?? `tc_${this.timeline.length}`;
    // opencode names the tool on the initial `tool_call`, then emits status-only
    // `tool_call_update`s that omit the title. Only take a title when one is
    // present so a later status update can't clobber the name back to generic.
    const title = update.title || update.kind || undefined;
    const status = update.status as string | undefined;

    // A tool call interrupts streamed text — finalize the current row first.
    this.finishStreamingMessage();

    const existing = this.timeline.find(
      (t): t is ToolItem => t.kind === 'tool' && t.id === id
    );
    if (existing) {
      if (title !== undefined) existing.title = title;
      if (status !== undefined) existing.status = status;
    } else {
      this.timeline.push({ kind: 'tool', id, title: title ?? 'tool call', status });
    }
    this.update();
    this.autoShow('tool-call');
  }

  /** Extract plain text from an ACP content block (or array of blocks). */
  private extractText(content: any): string {
    if (!content) return '';
    if (Array.isArray(content)) {
      return content.map((c) => this.extractText(c)).join('');
    }
    if (typeof content === 'string') return content;
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    return '';
  }

  /**
   * Replace the conversation with a session's persisted history and restore its
   * mode + model selectors.
   */
  private renderSessionHistory(data: any): void {
    if (!data?.sessionId) return;
    this.isLoadingSession = false;
    this.finishStreamingMessage();
    this.currentSessionId = data.sessionId;
    this.clearTimeline();

    const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
    this.timeline.push(...this.historyItems(messages, undefined, 'restored-tool'));
    if (data.mode === 'plan' || data.mode === 'build') {
      this.currentMode = data.mode;
    }
    if (!this.isStreaming) this.turnMode = undefined;
    if (typeof data.model === 'string' && data.model) {
      this.currentModel = data.model;
    }
    this.reverted = Boolean(data.reverted);
    // Ignore the session/load replay tail until the user drives a real turn.
    // A catch-up loads nothing in the agent: no replay follows it.
    if (!data.catchUp) this.suppressReplayStream = true;
    this.update();
  }

  /**
   * The timeline items of stored messages. A stored reply has no mode of its
   * own: it is the mode of the message it answers (`askedIn` before the first).
   */
  private historyItems(messages: any[], askedIn: 'plan' | 'build' | undefined, toolIds: string): typeof this.timeline {
    const items: typeof this.timeline = [];
    messages.forEach((m, i) => {
      if (m.role === 'user') askedIn = m.mode === 'plan' || m.mode === 'build' ? m.mode : undefined;
      // Persisted tool calls restore as tool timeline items — the same chip the
      // live path renders — keeping the text parts on either side distinct.
      if (m.role === 'tool') {
        items.push({
          kind: 'tool',
          id: typeof m.toolId === 'string' ? m.toolId : `${toolIds}-${i}`,
          title: m.toolName ?? 'tool call',
          status: typeof m.toolStatus === 'string' ? m.toolStatus : undefined,
          ...(typeof m.key === 'string' ? { key: m.key } : {}),
        });
        return;
      }
      items.push({
        kind: 'message',
        role: m.role === 'assistant' || m.role === 'user' ? m.role : 'system',
        content: m.content ?? '',
        timestamp: m.timestamp ?? Date.now(),
        mode: m.mode ?? (m.role === 'assistant' ? askedIn : undefined),
        ...(typeof m.messageId === 'string' ? { messageId: m.messageId } : {}),
        ...(typeof m.thinking === 'string' && m.thinking ? { thinking: m.thinking } : {}),
        ...(typeof m.images === 'number' && m.images > 0 ? { imageCount: m.images } : {}),
        ...(typeof m.key === 'string' ? { key: m.key } : {}),
      });
    });
    return items;
  }

  /**
   * Messages another window added to the session shown, sent on coming back
   * to this window: added after what the panel shows, which stays (its own
   * notes and errors too). Left if a turn has started since it asked, or
   * another session is shown.
   */
  private appendSessionMessages(data: any): void {
    if (!data?.sessionId || data.sessionId !== this.currentSessionId || this.isStreaming || this.isLoadingSession) return;
    // One it shows already (two catch-ups crossing) is not shown twice.
    const shown = new Set(this.timeline.map((t: any) => t.key).filter(Boolean));
    const messages: any[] = (Array.isArray(data.messages) ? data.messages : []).filter((m: any) => !m.key || !shown.has(m.key));
    if (messages.length === 0) return;
    const lastAsked = [...this.timeline].reverse().find((t: any) => t.kind === 'message' && t.role === 'user') as any;
    this.timeline.push(...this.historyItems(messages, lastAsked?.mode, `appended-tool-${this.timeline.length}`));
    this.reverted = Boolean(data.reverted);
    this.update();
  }

  /**
   * Attach opencode message ids to the live timeline's user messages (in order)
   * after a turn completes, so just-sent messages gain the "revert to here"
   * control without rebuilding the timeline.
   */
  private applyMessageIds(data: any): void {
    if (!data || data.sessionId !== this.currentSessionId) return;
    const ids: Array<string | undefined> = Array.isArray(data.ids) ? data.ids : [];
    let k = 0;
    for (const item of this.timeline) {
      if (item.kind === 'message' && item.role === 'user') {
        const id = ids[k++];
        if (typeof id === 'string') item.messageId = id;
      }
    }
    this.reverted = Boolean(data.reverted);
    this.update();
  }

  private clearTimeline(): void {
    this.timeline = [];
    this.streamingText = '';
    this.streamingThinking = '';
    this.showTyping = false;
    this.update();
  }

  // ── Connection status ──────────────────────────────────────────────────

  private setConnectionStatus(connected: boolean, reason?: string, agent?: string, images?: unknown): void {
    this.receivedStatus = true;
    // Whether it reads images is the connected agent's: unknown once it is gone
    // or another takes its place, until a status says.
    if (!connected || (typeof agent === 'string' && agent && agent !== this.connectionAgent)) {
      this.agentTakesImages = undefined;
    }
    if (typeof images === 'boolean') this.agentTakesImages = images;
    if (this.statusHandshakeTimer !== null) {
      clearTimeout(this.statusHandshakeTimer);
      this.statusHandshakeTimer = null;
    }
    this.connection = connected ? 'connected' : 'disconnected';
    this.connectionReason = reason ?? '';
    if (typeof agent === 'string' && agent) this.connectionAgent = agent;

    // Surface a state change once in the timeline so the reason is visible.
    const stateKey = `${connected}:${reason ?? ''}`;
    if (stateKey !== this.lastStatusKey) {
      this.lastStatusKey = stateKey;
      if (!connected) {
        // The runtime posts an immediate connected:false on every diagram open
        // (before its eager connect completes), so this is background chatter —
        // record it for whenever the user opens the chat, never pop the drawer.
        this.pushMessage(
          'system',
          `Not connected${reason ? `: ${reason}` : ''}. Run the chat's "Diagnose Connection" command for details.`,
          undefined,
          undefined,
          { reveal: false }
        );
        this.disconnectedRow = this.timeline[this.timeline.length - 1];
      } else if (this.disconnectedRow) {
        // Connected since: the row said what is no longer so (the chat opened
        // with "Not connected" under a status reading "Connected"). It goes,
        // unless the conversation went on below it, where it is history.
        if (this.timeline[this.timeline.length - 1] === this.disconnectedRow) {
          this.timeline.pop();
        }
        this.disconnectedRow = undefined;
      }
    }

    if (connected) {
      this.loadProviders();
      this.loadSessions();
    }
    this.update();
  }

  /** The host stopped its agent to start another: "Connecting…", with no row
   *  in the timeline; the next status says how the start went. */
  private setConnecting(): void {
    this.receivedStatus = true;
    if (this.statusHandshakeTimer !== null) {
      clearTimeout(this.statusHandshakeTimer);
      this.statusHandshakeTimer = null;
    }
    this.connection = 'unknown';
    this.connectionReason = '';
    this.agentTakesImages = undefined;
    this.update();
  }

  // ── Outbound actions ───────────────────────────────────────────────────

  private sendMessage(): void {
    const text = this.inputValue.trim();
    const images = this.pendingImages;
    if (!text && images.length === 0) return;
    if (images.length > 0 && this.agentTakesImages === false) {
      // Attached before the agent said so: the message stays as written.
      this.pushMessage('system', `Not sent: ${this.connectionAgent || 'the agent'} does not read images. Remove them and send again.`);
      return;
    }
    // No chat open: it is made first, and the message sent once it is. One
    // waiting already: this one stays in the composer.
    if (!this.currentSessionId) {
      if (this.pendingSend) return;
      this.inputValue = '';
      this.pendingImages = [];
      this.hideMenu();
      this.pendingSend = { text, images, fromComposer: true };
      if (!this.createRequest) {
        this.isLoadingSession = true;
        this.loadingLabel = 'Creating session…';
        this.update();
        this.requestSession({ mode: this.currentMode, ask: false });
      }
      return;
    }
    this.inputValue = '';
    this.pendingImages = [];
    this.hideMenu();
    this.sendPrompt(text, images, true);
  }

  /** Ask the host for a session, as the one this panel now waits for. */
  private requestSession(params: { mode: 'plan' | 'build'; name?: string; ask?: false }): void {
    this.createRequest = `create-${++this.createCount}`;
    if (this.sendToHost('chat.createSession', { ...params, requestId: this.createRequest })) return;
    // Not asked: nothing will answer.
    this.createRequest = undefined;
    this.isLoadingSession = false;
    this.restorePending();
    this.pushMessage('system', 'Error: VS Code API not available in webview');
  }

  /** A message that waited for a session it will not get goes back to the composer. */
  private restorePending(): void {
    const pending = this.pendingSend;
    this.pendingSend = undefined;
    if (pending?.fromComposer) this.putBack(pending.text, pending.images);
  }

  /** Text and images of a message not sent, back in the composer, before what
   *  it holds now (nothing written since is lost). */
  private putBack(text: string, images: ChatImage[]): void {
    const draft = this.inputValue.trim();
    this.inputValue = !draft ? text : draft === text.trim() ? this.inputValue : `${text}\n\n${this.inputValue}`;
    this.pendingImages = [...images, ...this.pendingImages].slice(0, CHAT_IMAGE_MAX_COUNT);
  }

  /**
   * Send `text` and `images` as the user's message: its row in the transcript,
   * and the host asked to send it. What was sent is kept until the host answers,
   * so a message it does not send goes back where it came from.
   */
  private sendPrompt(text: string, images: ChatImage[], fromComposer: boolean): void {
    this.finishStreamingMessage();
    // A real turn begins: subsequent agent streaming is genuine, not replay.
    this.suppressReplayStream = false;
    // A new prompt continues from the revert point; opencode drops the reverted
    // tail, so the session is no longer in a reverted state.
    this.reverted = false;
    this.turnMode = this.currentMode;
    this.pushMessage('user', text, this.currentMode, undefined, undefined, images);
    const row = this.timeline.at(-1);
    const sentTo = this.currentSessionId ?? '';
    this.lastSentIn = sentTo;
    if (row) this.sentIn.set(sentTo, { row, text, images, fromComposer });
    else this.sentIn.delete(sentTo);

    const ok = this.sendToHost('chat.sendMessage', {
      text,
      ...(images.length > 0 ? { images } : {}),
      sessionId: this.currentSessionId,
      mode: this.currentMode,
      selectedNodeIds: this.selectedNodeIds,
      surfaceSelection: this.surfaceSelection,
      viewTrail: currentViewTrail(),
    });

    if (!ok) {
      // Not sent: its row goes, and it goes back where it came from.
      this.sentIn.delete(sentTo);
      if (row) {
        const at = this.timeline.lastIndexOf(row);
        if (at >= 0) this.timeline.splice(at, 1);
      }
      if (fromComposer) this.putBack(text, images);
      this.pushMessage('system', 'Error: VS Code API not available in webview');
      return;
    }
    this.setStreaming(true);
    this.showTyping = true;
    this.update();
  }

  private cancelStreaming(): void {
    this.sendToHost('chat.cancel', { sessionId: this.currentSessionId });
    this.finishStreamingMessage();
    this.setStreaming(false);
    this.pushMessage('system', 'Stopped');
  }

  private setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
    if (!streaming) this.showTyping = false;
    this.update();
  }

  /** Finalize the in-progress assistant row into the timeline. */
  private finishStreamingMessage(): void {
    if (this.streamingText) {
      this.timeline.push({
        kind: 'message',
        role: 'assistant',
        content: this.streamingText,
        timestamp: Date.now(),
        mode: this.turnMode ?? this.currentMode,
        ...(this.streamingThinking ? { thinking: this.streamingThinking } : {}),
      });
      this.streamingText = '';
      // Reasoning attaches to the answer it produced; reset only once attached.
      // (Mid-turn flushes before a tool call carry thinking forward to the final
      // answer, matching how the extension persists the whole turn's reasoning.)
      this.streamingThinking = '';
    }
    this.update();
  }

  private pushMessage(
    role: Role,
    content: string,
    mode?: 'plan' | 'build',
    timestamp?: number,
    opts?: { reveal?: boolean },
    images?: ChatImage[]
  ): void {
    this.timeline.push({
      kind: 'message',
      role,
      content,
      timestamp: timestamp ?? Date.now(),
      mode,
      ...(images && images.length > 0 ? { images } : {}),
    });
    this.update();
    // reveal:false = record without opening the drawer, for messages that can
    // arrive with no user interaction (background connection errors).
    if (opts?.reveal !== false) this.autoShow(`message:${role}:${content.slice(0, 60)}`);
  }

  // ── Images ─────────────────────────────────────────────────────────────

  /** Add images to the next message, saying why any is left out. */
  private attachImages(images: ChatImage[]): void {
    for (const image of images) {
      const refusal = this.imageRefusal(image);
      if (refusal) {
        this.pushMessage('system', `The image was not attached: ${refusal}.`);
        continue;
      }
      this.pendingImages = [...this.pendingImages, image];
    }
    this.update();
  }

  /**
   * The host did not send the message last sent (an agent that does not read
   * its images): its row leaves the transcript, and what it held goes back to
   * the composer, beside whatever was written since, to change and send again.
   */
  private messageNotSent(data: any): void {
    if (data?.images === false) this.agentTakesImages = false;
    // For a chat not shown (left while its message went): the message still
    // goes back to the composer, but no line is said in the chat shown.
    const elsewhere = typeof data?.sessionId === 'string' && !!this.currentSessionId && data.sessionId !== this.currentSessionId;
    // The message last sent in the chat refused (not one sent since in
    // another): its row goes, its text back to the composer.
    const refusedIn = typeof data?.sessionId === 'string' ? data.sessionId : this.lastSentIn;
    const sent = refusedIn === undefined ? undefined : this.sentIn.get(refusedIn);
    if (sent) {
      this.sentIn.delete(refusedIn!);
      const at = this.timeline.lastIndexOf(sent.row);
      if (at >= 0) this.timeline.splice(at, 1);
      if (sent.fromComposer) this.putBack(sent.text, sent.images);
    }
    if (elsewhere) {
      this.update();
      return;
    }
    const reason = typeof data?.reason === 'string' && data.reason ? data.reason : 'the agent did not take it';
    // The advice is for images the agent refused, not for a chat deleted.
    this.pushMessage('system', data?.images === false ? `Not sent: ${reason}. Remove the images and send again.` : `Not sent: ${reason}.`);
  }

  /** Why `image` cannot go with the next message, or nothing when it can. */
  private imageRefusal(image: ChatImage): string | undefined {
    if (this.agentTakesImages === false) {
      return `${this.connectionAgent || 'the agent'} does not read images`;
    }
    if (this.pendingImages.length >= CHAT_IMAGE_MAX_COUNT) {
      return `a message carries at most ${CHAT_IMAGE_MAX_COUNT} images`;
    }
    return chatImageRefusal(image);
  }

  /** The image files pasted or dropped on the composer, read and attached. */
  private async attachFiles(files: File[]): Promise<void> {
    const images: ChatImage[] = [];
    for (const file of files) {
      try {
        images.push(await readImageFile(file));
      } catch (err) {
        this.pushMessage('system', `The image was not attached: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
    this.attachImages(images);
  }

  private removePendingImage(index: number): void {
    this.pendingImages = this.pendingImages.filter((_, i) => i !== index);
    this.update();
  }

  /** Attach a picture of the diagram, as it is drawn, to the next message. */
  private async attachDiagramPicture(): Promise<void> {
    if (this.takingPicture) return;
    this.takingPicture = true;
    this.update();
    try {
      const picture = await diagramPng();
      this.attachImages([{ mimeType: 'image/png', data: picture.data }]);
    } catch (err) {
      this.pushMessage('system', `No picture of the diagram: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.takingPicture = false;
      this.update();
    }
  }

  /** Pictures the platform shows, side by side where the panel is wide enough; one clicked opens at full size. */
  private figuresTemplate(figures: ChatFigure[] | undefined): TemplateResult | typeof nothing {
    if (!figures || figures.length === 0) return nothing;
    return html`<div class="chat-figures">
      ${figures.map(
        (figure) => html`<figure class="chat-figure">
          <img
            src="data:image/png;base64,${figure.data}"
            alt=${figure.caption ?? 'The diagram'}
            title="Open at full size"
            @click=${() => {
              this.openFigure = figure;
              this.update();
            }}
          />
          ${figure.caption ? html`<figcaption>${figure.caption}</figcaption>` : nothing}
        </figure>`
      )}
    </div>`;
  }

  /** The picture opened at full size, over the panel; a click closes it. */
  private openFigureTemplate(): TemplateResult | typeof nothing {
    const figure = this.openFigure;
    if (!figure) return nothing;
    const close = (): void => {
      this.openFigure = undefined;
      this.update();
    };
    return html`<div class="chat-figure-open" title="Close" @click=${close}>
      <img src="data:image/png;base64,${figure.data}" alt=${figure.caption ?? 'The diagram'} />
      ${figure.caption ? html`<div class="chat-figure-open-caption">${figure.caption}</div>` : nothing}
    </div>`;
  }

  /** The images a message carries, small, under its text; a restored one says how many it had. */
  private messageImagesTemplate(item: MessageItem): TemplateResult | typeof nothing {
    if (item.images && item.images.length > 0) {
      return html`<div class="chat-row-images">
        ${item.images.map((image) => html`<img class="chat-image-thumb" src=${imageSrc(image)} alt="Attached image" />`)}
      </div>`;
    }
    if (item.imageCount) {
      return html`<div class="chat-row-image-count">
        <span class="codicon codicon-file-media"></span>
        ${item.imageCount} image${item.imageCount === 1 ? '' : 's'}
      </div>`;
    }
    return nothing;
  }

  /** What the composer asks for: a question or a plan in Plan, which changes nothing; the commands only where the product has some. */
  private placeholder(): string {
    const ask = this.currentMode === 'plan' ? 'Ask about this diagram, or plan a change…' : 'Describe a change or ask anything…';
    return this.availableCommands.length > 0 ? `${ask}  ("/" for commands)` : ask;
  }

  private switchMode(mode: 'plan' | 'build'): void {
    this.applyMode(mode);
    this.sendToHost('chat.setMode', { mode, sessionId: this.currentSessionId });
  }

  private applyMode(mode: 'plan' | 'build'): void {
    this.currentMode = mode;
    this.loadCommands();
    this.update();
  }

  private switchProvider(providerId: string): void {
    this.currentModel = providerId;
    this.sendToHost('chat.setProvider', { providerId, sessionId: this.currentSessionId });
    this.update();
  }

  /** Name collection happens extension-side (webview prompt() is blocked). */
  private createNewSession(): void {
    // One asked for before is no longer waited for; a message waiting goes to
    // this one (or back to the composer, should its name be cancelled).
    // Creating a session spawns the agent's MCP server (+ its language subprocess), a
    // noticeable moment; show the same spinner so the panel doesn't look frozen.
    this.isLoadingSession = true;
    this.loadingLabel = 'Creating session…';
    this.autoShow('create-session');
    this.update();
    this.requestSession({ mode: this.currentMode });
  }

  private loadSession(sessionId: string): void {
    // Picked while a session was being made: that one is no longer awaited, and
    // a message waiting for it goes back to the composer. A task's is: the
    // task still opens its own session, as it asked.
    if (!this.pendingSend || this.pendingSend.fromComposer) {
      this.createRequest = undefined;
      this.restorePending();
    }
    this.currentSessionId = sessionId;
    // Restoring a session fans out to several opencode round-trips and can take
    // a noticeable moment; show a loading row so the panel doesn't look frozen.
    this.isLoadingSession = true;
    this.loadingLabel = 'Loading session…';
    this.autoShow('load-session');
    this.update();
    this.sendToHost('chat.loadSession', { sessionId });
  }

  /** Revert the session to before the given (user) message. */
  private requestRevert(messageId: string): void {
    if (!this.currentSessionId) return;
    this.sendToHost('chat.revert', { sessionId: this.currentSessionId, messageId });
  }

  /** Restore whatever the most recent revert undid. */
  private requestUnrevert(): void {
    if (!this.currentSessionId) return;
    this.sendToHost('chat.unrevert', { sessionId: this.currentSessionId });
  }

  private deleteCurrentSession(): void {
    if (!this.currentSessionId) {
      this.pushMessage('system', 'No session selected to delete.');
      return;
    }
    this.sendToHost('chat.deleteSession', { sessionId: this.currentSessionId });
  }

  private renameCurrentSession(): void {
    if (!this.currentSessionId) {
      this.pushMessage('system', 'No session selected to rename.');
      return;
    }
    this.sendToHost('chat.renameSession', { sessionId: this.currentSessionId });
  }

  private respondToPermission(item: PermissionItem, optionId: string | null): void {
    if (item.resolved) return;
    this.sendToHost('chat.permissionResponse', { requestId: item.requestId, optionId });
    item.resolved = optionId ? 'allowed' : 'denied';
    this.update();
  }

  /** Open the shown session in the agent's own CLI (the host opens a terminal). */
  private openSessionNatively(): void {
    if (this.currentSessionId) this.sendToHost('chat.openSessionNatively', { sessionId: this.currentSessionId });
  }

  /** Copy the shown session's id (the host writes the clipboard). */
  private copySessionId(): void {
    if (this.currentSessionId) this.sendToHost('chat.copySessionId', { sessionId: this.currentSessionId });
  }

  /** Answer a confirmation with the button pressed (`null`: declined). */
  private answerConfirm(item: ConfirmItem, choice: string | null): void {
    if (item.resolved !== undefined) return;
    this.sendToHost('chat.confirmAnswer', choice === null ? { id: item.id } : { id: item.id, choice });
    item.resolved = choice;
    this.update();
  }

  /** Answer a running agent's question (or decline it, `answer` undefined). */
  private answerRunQuestion(q: LiveAgentQuestion, answer: string | undefined): void {
    if (q.resolved) return;
    let resolved: { answer?: string; declined?: boolean };
    if (answer === undefined) {
      this.sendToHost('chat.runAnswer', { id: q.id, declined: true, reason: 'declined in the chat' });
      resolved = { declined: true };
    } else {
      this.sendToHost('chat.runAnswer', { id: q.id, answer });
      resolved = { answer };
    }
    RunAgentStreamActionHandler.resolveQuestion(q.agent, q.id, resolved);
    if (this.runBanner?.id === q.id) this.runBanner = null;
    this.update();
  }

  private loadProviders(): void {
    this.sendToHost('chat.getProviders');
  }

  private loadSessions(): void {
    this.sendToHost('chat.getSessions');
  }

  private loadCommands(): void {
    this.sendToHost('chat.getCommands', { mode: this.currentMode });
  }

  // ── Slash-command menu ─────────────────────────────────────────────────

  private updateMenu(): void {
    const match = /^\/([\w-]*)$/.exec(this.inputValue);
    if (!match) {
      this.hideMenu();
      return;
    }
    const prefix = match[1].toLowerCase();
    const items = this.availableCommands
      .filter((c) => c.command.toLowerCase().startsWith(prefix))
      .slice(0, 8);
    if (!items.length) {
      this.hideMenu();
      return;
    }
    this.menuItems = items;
    this.menuIndex = 0;
    this.update();
  }

  private hideMenu(): void {
    this.menuItems = [];
    this.menuIndex = -1;
    this.update();
  }

  /** Returns true if the key was consumed by the menu. */
  private handleMenuKey(e: KeyboardEvent): boolean {
    if (!this.menuItems.length) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.menuIndex = (this.menuIndex + 1) % this.menuItems.length;
      this.update();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.menuIndex = (this.menuIndex - 1 + this.menuItems.length) % this.menuItems.length;
      this.update();
      return true;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      this.applyMenuSelection(this.menuIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hideMenu();
      return true;
    }
    return false;
  }

  private applyMenuSelection(index: number): void {
    const item = this.menuItems[index];
    this.menuItems = [];
    this.menuIndex = -1;
    if (item) {
      this.inputValue = `/${item.command} `;
    }
    this.update();
    this.focusInput();
  }

  // ── Panel visibility ───────────────────────────────────────────────────

  show(): void {
    if (!this.panel) return;
    this.panel.classList.add('visible');
    raiseFloatingPanel(this.panel);
    document.body.classList.add(ChatPanel.VISIBLE_BODY_CLASS);
    this.isVisible = true;
    this.focusInput();
    this.announceRunView();
  }

  hide(): void {
    if (!this.panel) return;
    this.panel.classList.remove('visible');
    document.body.classList.remove(ChatPanel.VISIBLE_BODY_CLASS);
    this.isVisible = false;
    this.announceRunView();
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show();
  }

  toggleCompact(): void {
    this.isCompact = !this.isCompact;
    this.update();
  }

  /**
   * Open the drawer for user-visible activity. `origin` names the trigger and
   * is logged (webview console + host output channel) whenever this actually
   * opens the panel — the evidence trail for any uninvited auto-open.
   */
  private autoShow(origin: string): void {
    if (this.isVisible) return;
    this.log(`autoShow(${origin}) opening the chat panel`);
    this.show();
  }

  private focusInput(): void {
    // preventScroll: the panel slides in from off-screen (transform), so a
    // plain focus() would scroll the viewport to chase the off-screen input —
    // jolting the diagram/breadcrumb until the transition settles.
    (this.panel?.querySelector('.chat-input') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
  }

  // ── DOM scaffolding ────────────────────────────────────────────────────

  private createHost(): void {
    let panel = document.getElementById('workflow-chat-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'workflow-chat-panel';
      panel.className = 'workflow-chat-panel';
      document.body.appendChild(panel);
    }
    this.panel = panel;
    stackAsFloatingPanel(panel);

    // The drawer height and card width the last drag left.
    restoreChatSize(this.panel);
  }

  private createToggleButton(): void {
    let toggleBtn = document.getElementById('workflow-chat-toggle-btn');
    if (toggleBtn) return;

    toggleBtn = document.createElement('button');
    toggleBtn.id = 'workflow-chat-toggle-btn';
    toggleBtn.className = 'workflow-chat-toggle-btn';
    toggleBtn.innerHTML = '<span class="codicon codicon-comment-discussion"></span>';
    toggleBtn.title = 'Toggle Chat (Ctrl+Shift+C)';
    toggleBtn.addEventListener('click', () => this.toggle());
    // At the top of the floating stack when the navigation has made it already
    // (it moves the button there itself when it makes the stack later); on its
    // own it would sit where the stack's lowest button is, over it.
    (document.querySelector('.workflow-fab-stack') ?? document.body).appendChild(toggleBtn);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Whether the message drawer has anything to show. */
  private get hasContent(): boolean {
    return (
      this.timeline.length > 0 ||
      !!this.streamingText ||
      !!this.streamingThinking ||
      this.showTyping ||
      this.isLoadingSession ||
      // The empty-state placeholder is content too: it opens the drawer so the
      // user sees the "create/select a session" prompt on a fresh panel.
      this.isEmptyState
    );
  }

  /**
   * True when no session is selected and there is nothing else to show — the
   * fresh-panel / just-deleted state that renders the centered placeholder.
   */
  private get isEmptyState(): boolean {
    return (
      !this.currentSessionId &&
      this.timeline.length === 0 &&
      !this.streamingText &&
      !this.streamingThinking &&
      !this.showTyping &&
      !this.isLoadingSession
    );
  }

  /** Placeholder copy for the empty state — varies on whether sessions exist. */
  private get emptyStateText(): string {
    return this.sessions.length === 0
      ? 'Create a new session'
      : 'Select a session or create a new session';
  }

  /**
   * Coalesced re-render: schedules at most one render per animation frame. Use on
   * the hot streaming path so a burst of token updates repaints once per frame
   * instead of once per token — keeping the diagram (same webview thread) responsive.
   */
  private scheduleUpdate(): void {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.update();
    });
  }

  /** Re-render the panel from state and keep the scroll pinned to the end. */
  private update(): void {
    if (!this.panel) return;
    // An immediate render supersedes any frame already queued by scheduleUpdate().
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    // The message drawer slides open only when there is content (and the user
    // hasn't collapsed it); otherwise the card is just header + composer.
    this.panel.classList.toggle('drawer-closed', this.isCompact || !this.hasContent);
    // Decide BEFORE re-rendering whether to keep the view pinned: only if the
    // user was already at (or near) the bottom. Once they scroll up to read
    // earlier content, streaming must not yank them back down.
    const scroll = this.panel.querySelector('.chat-scroll') as HTMLElement | null;
    const stick = scroll
      ? shouldStick(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight)
      : true;
    render(this.template(), this.panel);
    if (scroll && stick) scroll.scrollTop = scroll.scrollHeight;
  }

  private template(): TemplateResult {
    return html`
      ${CHAT_RESIZE_EDGES.map(edge => html`<div
        class="chat-resize-handle ${edge}"
        @pointerdown=${(e: PointerEvent) => this.panel && startChatResize(this.panel, e, edge)}
      ></div>`)}
      ${this.topbarTemplate()}
      <div class="chat-scroll">
        ${this.view.kind === 'agent' ? this.agentTranscriptTemplate(this.view.instance) : this.sessionBodyTemplate()}
      </div>
      ${this.view.kind === 'agent'
        ? this.viewerBarTemplate()
        : html`
            ${this.reverted
              ? html`<div class="chat-redo-banner">
                  <span class="codicon codicon-history"></span>
                  <span>Session reverted — messages and file changes were undone.</span>
                  <button class="chat-redo-btn" @click=${() => this.requestUnrevert()}>
                    <span class="codicon codicon-redo"></span> Redo
                  </button>
                </div>`
              : nothing}
            ${this.runBannerTemplate()}
            ${this.composerTemplate()}
          `}
      ${this.openFigureTemplate()}
    `;
  }

  /** The session's timeline: messages, tool calls, its own permission requests. */
  private sessionBodyTemplate(): TemplateResult {
    return html`
      ${this.isEmptyState
        ? html`<div class="chat-empty-state">
            <span class="codicon codicon-comment-discussion"></span>
            <span>${this.emptyStateText}</span>
          </div>`
        : nothing}
      ${this.isLoadingSession
        ? html`<div class="chat-loading-session">
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
            <span>${this.loadingLabel}</span>
          </div>`
        : nothing}
      ${repeat(
        this.timeline,
        (item, i) => (item.kind === 'tool' ? `t${item.id}` : item.kind === 'permission' ? `p${item.requestId}` : item.kind === 'confirm' ? `c${item.id}` : `m${i}`),
        (item) => this.itemTemplate(item)
      )}
      ${this.streamingText || this.streamingThinking ? this.streamingTemplate() : nothing}
      ${this.showTyping ? html`<div class="chat-typing"><span></span><span></span><span></span></div>` : nothing}
    `;
  }

  private topbarTemplate(): TemplateResult {
    const status = this.connection;
    const agent = this.connectionAgent;
    const statusLabel =
      status === 'connected'
        ? agent
          ? `Connected · ${agent}`
          : 'Connected'
        : status === 'disconnected'
          ? 'Disconnected'
          : 'Connecting…';
    const statusTitle =
      status === 'disconnected' && this.connectionReason
        ? `${agent || 'agent'}: ${this.connectionReason}`
        : status === 'connected' && agent
          ? `Connected to the ${agent} ACP connector`
          : 'agent connection';
    return html`
      <header class="chat-topbar">
        <span class="chat-title">
          <span class="codicon codicon-comment-discussion"></span>
          <span class="chat-title-text">Chat</span>
        </span>
        ${this.segmentsTemplate()}
        ${this.view.kind === 'session'
          ? html`
              <vscode-single-select
                class="chat-session-select"
                title="Session"
                @change=${(e: Event) => {
                  const value = (e.target as any).value as string;
                  if (value && value !== this.currentSessionId) this.loadSession(value);
                }}
              >
                ${!this.currentSessionId
                  ? html`<vscode-option value="" ?selected=${true}>${this.sessions.length === 0 ? 'No session' : 'Select a session'}</vscode-option>`
                  : nothing}
                ${this.sessions.map(
                  (s) => html`<vscode-option value=${s.id} ?selected=${s.id === this.currentSessionId}>${s.name}</vscode-option>`
                )}
              </vscode-single-select>
              <button class="chat-ibtn" title="New session" @click=${() => this.createNewSession()}>
                <span class="codicon codicon-add"></span>
              </button>
              <button class="chat-ibtn" title="Rename session" @click=${() => this.renameCurrentSession()}>
                <span class="codicon codicon-edit"></span>
              </button>
              <button class="chat-ibtn" title="Delete session" @click=${() => this.deleteCurrentSession()}>
                <span class="codicon codicon-trash"></span>
              </button>
              ${this.currentSessionId
                ? html`<button
                      class="chat-ibtn"
                      title=${`Open this session in ${this.connectionAgent || 'the agent'}'s own CLI, in a terminal`}
                      @click=${() => this.openSessionNatively()}
                    >
                      <span class="codicon codicon-terminal"></span>
                    </button>
                    <button class="chat-ibtn" title="Copy the session id" @click=${() => this.copySessionId()}>
                      <span class="codicon codicon-copy"></span>
                    </button>`
                : nothing}
            `
          : this.agentSelectTemplate(this.view.instance)}
        <div class="chat-topbar-spacer"></div>
        <span class="chat-status status-${status}" title=${statusTitle}>
          <span class="chat-status-dot"></span>${statusLabel}
        </span>
        <button class="chat-ibtn" title=${this.isCompact ? 'Expand' : 'Collapse'} @click=${() => this.toggleCompact()}>
          <span class="codicon ${this.isCompact ? 'codicon-chevron-up' : 'codicon-chevron-down'}"></span>
        </button>
        <button class="chat-ibtn" title="Close" @click=${() => this.hide()}>
          <span class="codicon codicon-close"></span>
        </button>
      </header>
    `;
  }

  // ── The run's agents ────────────────────────────────────────────────

  /** Session | Run · n, with a badge for the questions waiting. */
  private segmentsTemplate(): TemplateResult {
    const agents = RunAgentStreamActionHandler.getAgents();
    const active = RunAgentStreamActionHandler.isRunActive();
    const pending = RunAgentStreamActionHandler.pendingQuestionCount();
    const isAgent = this.view.kind === 'agent';
    return html`
      <div class="chat-segments" role="tablist">
        <button class="chat-segment ${!isAgent ? 'active' : ''}" role="tab" title="The diagram's own session" @click=${() => this.showSession()}>
          Session
        </button>
        <button
          class="chat-segment ${isAgent ? 'active' : ''}"
          role="tab"
          title=${agents.length ? "The run's agents, read only" : 'No run yet'}
          ?disabled=${agents.length === 0}
          @click=${() => this.openRun()}
        >
          Run${agents.length ? ` · ${agents.length}` : ''}
          ${pending > 0
            ? html`<span class="chat-segment-badge" title="${pending} question${pending === 1 ? '' : 's'} waiting">${pending}</span>`
            : active
              ? html`<span class="chat-segment-live" title="live"></span>`
              : nothing}
        </button>
      </div>
    `;
  }

  /** The run's agents, one selected: what the topbar shows in the agent view. */
  private agentSelectTemplate(instance: string): TemplateResult {
    const agents = RunAgentStreamActionHandler.getAgents();
    const label = (a: LiveAgentState): string =>
      `${a.instance}${a.pendingQuestions > 0 ? ' (asking…)' : a.status === 'running' ? ' (streaming…)' : ' (done)'}`;
    return html`
      <vscode-single-select
        class="chat-agent-select"
        title="Running agent"
        @change=${(e: Event) => {
          const value = (e.target as any).value as string;
          if (value && value !== instance) this.showAgent(value);
        }}
      >
        ${agents.map((a) => html`<vscode-option value=${a.instance} ?selected=${a.instance === instance}>${label(a)}</vscode-option>`)}
      </vscode-single-select>
    `;
  }

  /** A running agent's transcript: its turns, reasoning, text, tool calls and questions, in order. */
  private agentTranscriptTemplate(instance: string): TemplateResult {
    const a = RunAgentStreamActionHandler.getAgent(instance);
    if (!a) {
      return html`<div class="chat-empty-state">
        <span class="codicon codicon-broadcast"></span>
        <span>No agent “${instance}” in this run.</span>
      </div>`;
    }
    const lastReasoning = [...a.parts].reverse().find((p) => p.kind === 'reasoning');
    return html`
      <div class="chat-run-transcript">
        <div class="chat-run-agent-head">
          <span class="chat-run-dot ${a.status}"></span>
          <span class="chat-run-name" title=${a.instance}>${a.instance}</span>
          <span class="chat-run-status">${a.pendingQuestions > 0 ? 'asking…' : a.status === 'running' ? 'streaming…' : 'done'}</span>
        </div>
        ${a.parts.length === 0 ? html`<div class="chat-run-empty">Waiting for the agent…</div>` : nothing}
        ${a.parts.map((p) => this.partTemplate(p, p === lastReasoning && a.status === 'running'))}
      </div>
    `;
  }

  private partTemplate(p: LiveAgentPart, open: boolean): TemplateResult {
    switch (p.kind) {
      case 'turn': {
        const session = p.session;
        return html`<div class="chat-run-turn">
          <span>turn ${p.index}</span>
          ${session
            ? html`<button
                  class="chat-ibtn chat-run-session-btn"
                  title=${`Open this turn's session in ${session.connector ?? 'the agent'}'s own CLI, in a terminal`}
                  @click=${() => this.sendToHost('chat.openAgentSession', { sessionId: session.id, connector: session.connector, cwd: session.cwd })}
                >
                  <span class="codicon codicon-terminal"></span>
                </button>
                <button
                  class="chat-ibtn chat-run-session-btn"
                  title=${`Copy this turn's session id (${session.id})`}
                  @click=${() => this.sendToHost('chat.copyAgentSession', { sessionId: session.id, connector: session.connector, cwd: session.cwd })}
                >
                  <span class="codicon codicon-copy"></span>
                </button>`
            : nothing}
        </div>`;
      }
      case 'reasoning':
        return this.thinkingTemplate(p.text, { open });
      case 'text': {
        // An agent's last text is usually its outputs object, whose port
        // values are themselves JSON. Format that; leave ordinary text as
        // typed, which is what the viewer has always shown.
        const outputs = formatAgentOutputs(p.text);
        return outputs
          ? html`<div class="chat-run-text chat-run-outputs">${unsafeHTML(renderMarkdownMemo(outputs))}</div>`
          : html`<div class="chat-run-text">${p.text}</div>`;
      }
      case 'tool': {
        const icon = p.status === 'completed' ? 'codicon-check' : p.status === 'failed' ? 'codicon-warning' : 'codicon-tools';
        const statusText = p.status && p.status !== 'completed' ? ` — ${p.status.replace('_', ' ')}` : '';
        return html`
          <div class="chat-tool ${p.status === 'failed' ? 'failed' : ''}">
            <span class="codicon ${icon}"></span>
            <span class="chat-tool-title">${p.name}</span>
            <span class="chat-tool-status">${statusText}</span>
          </div>
        `;
      }
      case 'question':
        return this.questionTemplate(p.question);
    }
  }

  /** The footer under a running agent: no prompt, answers only. */
  private viewerBarTemplate(): TemplateResult {
    return html`
      <footer class="chat-viewer-bar">
        <span class="codicon codicon-eye"></span>
        <span>Viewer of a running agent: its questions are answered above; it takes no prompt.</span>
        <button class="chat-permission-btn" @click=${() => this.showSession()}>Back to the session</button>
      </footer>
    `;
  }

  /** A question that arrived while the user was typing: a way to it. */
  private runBannerTemplate(): TemplateResult | typeof nothing {
    const q = this.runBanner;
    if (!q || q.resolved) return nothing;
    return html`
      <div class="chat-run-banner">
        <span class="codicon codicon-question"></span>
        <span class="chat-run-banner-text">${q.agent} asks: ${q.question}</span>
        <button class="chat-permission-btn" @click=${() => this.showAgent(q.agent)}>Go</button>
      </div>
    `;
  }

  private questionTemplate(q: LiveAgentQuestion): TemplateResult {
    const who = q.model ? `${q.agent} (${q.model})` : q.agent;
    const readInput = (e: Event): string =>
      ((e.currentTarget as HTMLElement | null)?.closest('.chat-question')?.querySelector('input') as HTMLInputElement | null)
        ?.value ?? '';
    return html`
      <div class="chat-question ${q.resolved ? 'resolved' : ''}">
        <div class="chat-question-title">
          <span class="codicon codicon-question"></span>
          <span>${who} asks</span>
        </div>
        <div class="chat-question-text">${q.question}</div>
        ${q.context ? html`<div class="chat-question-context">${q.context}</div>` : nothing}
        ${q.resolved
          ? html`<div class="chat-question-answer">
              ${q.resolved.declined ? 'Declined' : `Answered: ${q.resolved.answer}`}
            </div>`
          : q.choices.length > 0
            ? html`<div class="chat-permission-actions">
                ${q.choices.map(
                  (c) => html`<button class="chat-permission-btn" @click=${() => this.answerRunQuestion(q, c)}>${c}</button>`
                )}
                <button class="chat-permission-btn deny" @click=${() => this.answerRunQuestion(q, undefined)}>Decline</button>
              </div>`
            : html`<div class="chat-permission-actions">
                <input
                  class="chat-question-input"
                  placeholder="Your answer"
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.answerRunQuestion(q, (e.currentTarget as HTMLInputElement).value);
                  }}
                />
                <button class="chat-permission-btn" @click=${(e: Event) => this.answerRunQuestion(q, readInput(e))}>Answer</button>
                <button class="chat-permission-btn deny" @click=${() => this.answerRunQuestion(q, undefined)}>Decline</button>
              </div>`}
      </div>
    `;
  }

  private itemTemplate(item: TimelineItem): TemplateResult {
    if (item.kind === 'tool') {
      const icon =
        item.status === 'completed'
          ? 'codicon-check'
          : item.status === 'failed'
            ? 'codicon-warning'
            : 'codicon-tools';
      const statusText = item.status && item.status !== 'completed' ? ` — ${item.status.replace('_', ' ')}` : '';
      return html`
        <div class="chat-tool ${item.status === 'failed' ? 'failed' : ''}">
          <span class="codicon ${icon}"></span>
          <span class="chat-tool-title">${item.title}</span>
          <span class="chat-tool-status">${statusText}</span>
        </div>
      `;
    }

    if (item.kind === 'confirm') {
      return html`
        <div class="chat-permission chat-confirm ${item.resolved !== undefined ? 'resolved' : ''}">
          <div class="chat-permission-title">
            <span class="codicon codicon-debug-continue"></span>
            <span>${item.title}</span>
          </div>
          <div class="chat-question-text">${item.text}</div>
          ${this.figuresTemplate(item.figures)}
          ${item.resolved === undefined
            ? html`<div class="chat-permission-actions">
                ${item.choices.map(
                  (c, i) => html`<button
                    class="chat-permission-btn ${i === item.choices.length - 1 && item.choices.length > 1 ? 'deny' : ''}"
                    @click=${() => this.answerConfirm(item, c)}
                  >
                    ${c}
                  </button>`
                )}
              </div>`
            : html`<div class="chat-question-answer">${item.resolved ?? 'Declined'}</div>`}
        </div>
      `;
    }

    if (item.kind === 'permission') {
      return html`
        <div class="chat-permission ${item.resolved ? 'resolved' : ''}">
          <div class="chat-permission-title">
            <span class="codicon codicon-shield"></span>
            ${item.resolved === 'allowed'
              ? `Allowed: ${item.title}`
              : item.resolved === 'denied'
                ? `Denied: ${item.title}`
                : `Permission requested: ${item.title}`}
          </div>
          ${!item.resolved
            ? html`
                <div class="chat-permission-actions">
                  ${item.options.map((opt) => {
                    const reject =
                      /reject|deny|no/i.test(opt.name) || opt.kind === 'reject_once' || opt.kind === 'reject_always';
                    return html`
                      <button
                        class="chat-permission-btn ${reject ? 'deny' : ''}"
                        @click=${() => this.respondToPermission(item, reject ? null : opt.optionId)}
                      >
                        ${opt.name}
                      </button>
                    `;
                  })}
                  ${!item.options.some((o) => /reject|deny|no/i.test(o.name))
                    ? html`<button class="chat-permission-btn deny" @click=${() => this.respondToPermission(item, null)}>
                        Deny
                      </button>`
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      `;
    }

    // message
    if (item.role === 'system') {
      return html`
        <div class="chat-row chat-row-system">
          <span class="codicon codicon-info"></span>
          ${item.figures && item.figures.length > 0
            ? html`<div class="chat-row-system-body"><span>${item.content}</span>${this.figuresTemplate(item.figures)}</div>`
            : html`<span>${item.content}</span>`}
        </div>
      `;
    }
    const isUser = item.role === 'user';
    return html`
      <div class="chat-row ${isUser ? 'chat-row-user' : 'chat-row-assistant'}">
        <div class="chat-row-head">
          <span class="codicon ${isUser ? 'codicon-account' : 'codicon-hubot'}"></span>
          <span class="chat-row-who">${isUser ? 'You' : 'Assistant'}</span>
          ${item.mode ? html`<span class="chat-row-mode">${item.mode}</span>` : nothing}
          ${isUser && item.messageId
            ? html`<button
                class="chat-row-revert"
                title="Revert to here — undo this message, all later replies, and their file changes"
                @click=${() => this.requestRevert(item.messageId!)}
              >
                <span class="codicon codicon-discard"></span>
              </button>`
            : nothing}
        </div>
        ${!isUser && item.thinking ? this.thinkingTemplate(item.thinking) : nothing}
        ${isUser && !item.content
          ? nothing
          : // Flush with its tags: a user's text keeps its own line breaks (pre-wrap), and only those.
            html`<div class="chat-row-body">${isUser ? item.content : unsafeHTML(renderMarkdownMemo(readable(item.content)))}</div>`}
        ${isUser ? this.messageImagesTemplate(item) : nothing}
      </div>
    `;
  }

  /** Collapsible "Thinking" block for assistant reasoning. Open while streaming. */
  private thinkingTemplate(text: string, opts?: { open?: boolean }): TemplateResult {
    return html`
      <details class="chat-thinking" ?open=${opts?.open ?? false}>
        <summary class="chat-thinking-summary">
          <span class="codicon codicon-lightbulb"></span>
          <span>Thinking</span>
        </summary>
        <div class="chat-thinking-body">${unsafeHTML(renderMarkdownMemo(text))}</div>
      </details>
    `;
  }

  private streamingTemplate(): TemplateResult {
    return html`
      <div class="chat-row chat-row-assistant streaming">
        <div class="chat-row-head">
          <span class="codicon codicon-hubot"></span>
          <span class="chat-row-who">Assistant</span>
        </div>
        ${this.streamingThinking ? this.thinkingTemplate(this.streamingThinking, { open: true }) : nothing}
        ${this.streamingText ? html`<div class="chat-row-body">${this.streamingText}</div>` : nothing}
      </div>
    `;
  }

  private composerTemplate(): TemplateResult {
    return html`
      <footer class="chat-composer-wrap">
        ${this.menuItems.length
          ? html`
              <div class="chat-command-menu">
                ${this.menuItems.map(
                  (c, i) => html`
                    <div
                      class="chat-command-item ${i === this.menuIndex ? 'active' : ''}"
                      @mousedown=${(e: MouseEvent) => {
                        e.preventDefault();
                        this.applyMenuSelection(i);
                      }}
                    >
                      <span class="cmd">/${c.command}${c.usage ? html` <span class="cmd-usage">${c.usage}</span>` : nothing}</span>
                      <span class="desc">${c.description}</span>
                    </div>
                  `
                )}
              </div>
            `
          : nothing}
        ${this.selectedNodeIds.length
          ? html`<div class="chat-selection-hint" title="Selected diagram nodes are sent as context">
              <span class="codicon codicon-inspect"></span>
              ${this.selectedNodeIds.length} node${this.selectedNodeIds.length === 1 ? '' : 's'} selected — included as context
            </div>`
          : this.surfaceSelection
            ? html`<div class="chat-selection-hint" title="The selection is sent as context">
                <span class="codicon codicon-inspect"></span>
                ${this.surfaceSelection.title} selected — included as context
              </div>`
            : nothing}
        <div
          class="chat-composer"
          @dragover=${(e: DragEvent) => {
            if (carriesImages(e.dataTransfer)) e.preventDefault();
          }}
          @drop=${(e: DragEvent) => {
            const files = imageFiles(e.dataTransfer);
            if (files.length === 0) return;
            e.preventDefault();
            void this.attachFiles(files);
          }}
        >
          ${this.pendingImages.length
            ? html`<div class="chat-attachments">
                ${this.pendingImages.map(
                  (image, i) => html`<div class="chat-attachment">
                    <img class="chat-image-thumb" src=${imageSrc(image)} alt="Image to send" />
                    <button class="chat-attachment-remove" title="Remove" @click=${() => this.removePendingImage(i)}>
                      <span class="codicon codicon-close"></span>
                    </button>
                  </div>`
                )}
              </div>`
            : nothing}
          <textarea
            class="chat-input"
            rows="1"
            placeholder=${this.placeholder()}
            .value=${this.inputValue}
            @input=${(e: Event) => {
              const el = e.target as HTMLTextAreaElement;
              this.inputValue = el.value;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 140) + 'px';
              this.updateMenu();
            }}
            @keydown=${(e: KeyboardEvent) => this.onInputKeydown(e)}
            @paste=${(e: ClipboardEvent) => {
              const files = imageFiles(e.clipboardData);
              if (files.length > 0) void this.attachFiles(files);
            }}
          ></textarea>
          <div class="chat-composer-bar">
            <div class="chat-mode-seg" title="Agent mode (Shift+Tab switches)">
              <button
                class=${this.currentMode === 'build' ? 'active' : ''}
                @click=${() => this.switchMode('build')}
              >
                <span class="codicon codicon-tools"></span>Build
              </button>
              <button
                class=${this.currentMode === 'plan' ? 'active' : ''}
                @click=${() => this.switchMode('plan')}
              >
                <span class="codicon codicon-checklist"></span>Plan
              </button>
            </div>
            <vscode-single-select
              class="chat-model-select"
              title="Model"
              position="above"
              @change=${(e: Event) => {
                const value = (e.target as any).value as string;
                if (value) this.switchProvider(value);
              }}
            >
              ${this.models.length === 0
                ? html`<vscode-option value="">Default model</vscode-option>`
                : this.models.map(
                    (m) => html`<vscode-option value=${m.id} ?selected=${m.id === this.currentModel}>${m.name}</vscode-option>`
                  )}
            </vscode-single-select>
            <div class="chat-composer-spacer"></div>
            <button
              class="chat-picture"
              title=${this.agentTakesImages === false
                ? `${this.connectionAgent || 'The agent'} does not read images`
                : 'Attach a picture of the diagram'}
              ?disabled=${this.takingPicture || this.agentTakesImages === false}
              @click=${() => void this.attachDiagramPicture()}
            >
              <span class="codicon ${this.takingPicture ? 'codicon-loading codicon-modifier-spin' : 'codicon-device-camera'}"></span>
            </button>
            <button
              class="chat-send ${this.isStreaming ? 'stop' : ''}"
              title=${this.isStreaming ? 'Stop' : 'Send (Enter)'}
              @click=${() => (this.isStreaming ? this.cancelStreaming() : this.sendMessage())}
            >
              <span class="codicon ${this.isStreaming ? 'codicon-debug-stop' : 'codicon-send'}"></span>
            </button>
          </div>
        </div>
      </footer>
    `;
  }

  private onInputKeydown(e: KeyboardEvent): void {
    if (this.handleMenuKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (this.isStreaming) {
        this.cancelStreaming();
      } else {
        this.sendMessage();
      }
      return;
    }
    // Shift+Tab switches between Plan and Build, as agents' own prompts do. Not
    // Ctrl+Shift+P / B: the webview hands those on to VS Code too, which opens
    // its Command Palette or build tasks over the chat and takes the focus.
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.switchMode(this.currentMode === 'plan' ? 'build' : 'plan');
    }
  }
}
