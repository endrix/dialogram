import { injectable } from 'inversify';
import { IDiagramStartup, ISelectionListener } from '@eclipse-glsp/client';
import { Messenger } from 'vscode-messenger-webview';
import { DiagramWebviewChannel, getDiagramWebviewChannel } from './webview-channel';
import { NotificationType } from 'vscode-messenger-common';
import { html, render, nothing, TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdownSafe } from './markdown';

/**
 * Memoized markdown → HTML. The chat template runs `renderMarkdownSafe` for every
 * message on every render; during streaming that re-parses all prior messages
 * each frame. Message content is immutable once rendered, so cache by content
 * (bounded LRU-ish) to parse each message exactly once.
 */
const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_MAX = 500;
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
}

interface ToolItem {
  kind: 'tool';
  id: string;
  title: string;
  status?: string;
}

interface PermissionItem {
  kind: 'permission';
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  resolved?: 'allowed' | 'denied';
}

type TimelineItem = MessageItem | ToolItem | PermissionItem;

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
@injectable()
export class ChatPanel implements IDiagramStartup, ISelectionListener {
  /** Run after the diagram model is ready so the webview DOM exists. */
  rank = 100;

  private initialized = false;

  private static readonly VISIBLE_BODY_CLASS = 'workflow-chat-visible';
  private static readonly PANEL_HEIGHT_STORAGE_KEY = 'workflow.diagram.chatPanel.heightPx';
  private static readonly DRAWER_MIN_HEIGHT_PX = 120;
  private static readonly PANEL_MAX_HEIGHT_RATIO = 0.6;

  // ── DOM hosts ──
  private panel: HTMLElement | null = null;

  // ── State (single source of truth for the rendered UI) ──
  private isVisible = false;
  private isCompact = false;
  private currentMode: 'plan' | 'build' = 'build';
  private currentSessionId: string | null = null;
  private timeline: TimelineItem[] = [];
  private sessions: SessionEntry[] = [];
  private models: ModelEntry[] = [];
  private currentModel = '';
  /** True when the session is in a reverted state (shows the redo banner). */
  private reverted = false;
  private connection: 'unknown' | 'connected' | 'disconnected' = 'unknown';
  private connectionReason = '';
  private inputValue = '';

  /** Live diagram selection (node ids), mirrored to the host for chat context. */
  private selectedNodeIds: string[] = [];

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
    this.sendToHost('chat.selection', { selectedNodeIds: this.selectedNodeIds });
    if (this.initialized) this.update();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.createHost();
    this.createToggleButton();
    this.setupMessageListener();
    this.update();
    this.requestState();
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

  /**
   * Send a chat message to the extension host over the GLSP messenger channel.
   * Every message carries the diagram's workflow URI so the host can scope the
   * session even when there is no active text editor.
   */
  private sendToHost(type: string, data: any = {}): boolean {
    if (!this.channel) return false;
    this.channel.sendToHost(ChatToHost.method, {
      type,
      data: { workflowUri: this.workflowUri, ...data },
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
        this.finishStreamingMessage();
        if (data) {
          this.pushMessage(data.role ?? 'system', data.content ?? '', data.mode, data.timestamp);
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
        this.isLoadingSession = false;
        if (data?.session?.id) {
          this.currentSessionId = data.session.id;
          this.loadSessions();
          this.pushMessage('system', `Created session: ${data.session.name ?? data.session.id}`);
        }
        this.update();
        break;

      case 'chat.sessionCreateAborted':
        // Name prompt cancelled — drop the "Creating session…" spinner.
        this.isLoadingSession = false;
        this.update();
        break;

      case 'chat.sessionLoaded':
        if (data?.sessionId) {
          this.currentSessionId = data.sessionId;
          this.update();
        }
        break;

      case 'chat.messageIds':
        this.applyMessageIds(data);
        break;

      case 'chat.sessionHistory':
        this.renderSessionHistory(data);
        break;

      case 'chat.sessionDeleted':
        if (data?.sessionId === this.currentSessionId) {
          this.currentSessionId = data?.nextSessionId ?? null;
          this.clearTimeline();
        }
        this.loadSessions();
        if (data?.nextSessionId) {
          this.loadSession(data.nextSessionId);
        } else {
          this.pushMessage('system', 'Session deleted. Create or select a session to continue.');
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
        this.setConnectionStatus(!!data?.connected, data?.reason);
        break;

      case 'chat.commands':
        this.availableCommands = Array.isArray(data?.commands) ? data.commands : [];
        break;

      case 'chat.turnEnd':
        if (!data?.sessionId || data.sessionId === this.currentSessionId) {
          this.finishStreamingMessage();
          this.setStreaming(false);
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
          this.autoShow();
        }
        break;

      case 'chat.error':
        this.isLoadingSession = false;
        this.finishStreamingMessage();
        this.pushMessage('system', `Error: ${data?.message ?? 'Unknown error'}`);
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
        this.autoShow();
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
    const title = update.title || update.kind || 'tool call';
    const status = update.status as string | undefined;

    // A tool call interrupts streamed text — finalize the current row first.
    this.finishStreamingMessage();

    const existing = this.timeline.find(
      (t): t is ToolItem => t.kind === 'tool' && t.id === id
    );
    if (existing) {
      existing.title = title;
      existing.status = status;
    } else {
      this.timeline.push({ kind: 'tool', id, title, status });
    }
    this.update();
    this.autoShow();
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
    for (const m of messages) {
      this.timeline.push({
        kind: 'message',
        role: m.role === 'assistant' || m.role === 'user' ? m.role : 'system',
        content: m.content ?? '',
        timestamp: m.timestamp ?? Date.now(),
        mode: m.mode,
        ...(typeof m.messageId === 'string' ? { messageId: m.messageId } : {}),
        ...(typeof m.thinking === 'string' && m.thinking ? { thinking: m.thinking } : {}),
      });
    }
    if (data.mode === 'plan' || data.mode === 'build') {
      this.currentMode = data.mode;
    }
    if (typeof data.model === 'string' && data.model) {
      this.currentModel = data.model;
    }
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

  private setConnectionStatus(connected: boolean, reason?: string): void {
    this.receivedStatus = true;
    if (this.statusHandshakeTimer !== null) {
      clearTimeout(this.statusHandshakeTimer);
      this.statusHandshakeTimer = null;
    }
    this.connection = connected ? 'connected' : 'disconnected';
    this.connectionReason = reason ?? '';

    // Surface a state change once in the timeline so the reason is visible.
    const stateKey = `${connected}:${reason ?? ''}`;
    if (stateKey !== this.lastStatusKey) {
      this.lastStatusKey = stateKey;
      if (!connected) {
        this.pushMessage(
          'system',
          `Not connected${reason ? `: ${reason}` : ''}. Run "Workflow Chat: Diagnose Connection" for details.`
        );
      }
    }

    if (connected) {
      this.loadProviders();
      this.loadSessions();
    }
    this.update();
  }

  // ── Outbound actions ───────────────────────────────────────────────────

  private sendMessage(): void {
    const text = this.inputValue.trim();
    if (!text) return;

    this.finishStreamingMessage();
    // A new prompt continues from the revert point; opencode drops the reverted
    // tail, so the session is no longer in a reverted state.
    this.reverted = false;
    this.pushMessage('user', text, this.currentMode);
    this.inputValue = '';
    this.hideMenu();

    const ok = this.sendToHost('chat.sendMessage', {
      text,
      sessionId: this.currentSessionId,
      mode: this.currentMode,
      selectedNodeIds: this.selectedNodeIds,
    });

    if (!ok) {
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
        mode: this.currentMode,
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

  private pushMessage(role: Role, content: string, mode?: 'plan' | 'build', timestamp?: number): void {
    this.timeline.push({ kind: 'message', role, content, timestamp: timestamp ?? Date.now(), mode });
    this.update();
    this.autoShow();
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
    // Creating a session spawns the agent's MCP server (+ its language subprocess), a
    // noticeable moment; show the same spinner so the panel doesn't look frozen.
    this.isLoadingSession = true;
    this.loadingLabel = 'Creating session…';
    this.autoShow();
    this.update();
    this.sendToHost('chat.createSession', { mode: this.currentMode });
  }

  private loadSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    // Restoring a session fans out to several opencode round-trips and can take
    // a noticeable moment; show a loading row so the panel doesn't look frozen.
    this.isLoadingSession = true;
    this.loadingLabel = 'Loading session…';
    this.autoShow();
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
    if (e.key === 'Enter' || e.key === 'Tab') {
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
    document.body.classList.add(ChatPanel.VISIBLE_BODY_CLASS);
    this.isVisible = true;
    this.focusInput();
  }

  hide(): void {
    if (!this.panel) return;
    this.panel.classList.remove('visible');
    document.body.classList.remove(ChatPanel.VISIBLE_BODY_CLASS);
    this.isVisible = false;
  }

  toggle(): void {
    this.isVisible ? this.hide() : this.show();
  }

  toggleCompact(): void {
    this.isCompact = !this.isCompact;
    this.update();
  }

  private autoShow(): void {
    if (!this.isVisible) this.show();
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

    // Restore the saved message-drawer height.
    const savedHeight = localStorage.getItem(ChatPanel.PANEL_HEIGHT_STORAGE_KEY);
    if (savedHeight) {
      this.panel.style.setProperty('--chat-drawer-height', savedHeight);
    }
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
    document.body.appendChild(toggleBtn);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /** Drag the card's top edge to resize the message drawer. */
  private startResize(e: MouseEvent): void {
    if (!this.panel) return;
    e.preventDefault();
    const scroll = this.panel.querySelector('.chat-scroll') as HTMLElement | null;
    const startY = e.clientY;
    const startHeight = scroll?.offsetHeight ?? 300;
    document.body.style.cursor = 'ns-resize';

    const onMove = (ev: MouseEvent) => {
      const deltaY = startY - ev.clientY;
      const newHeight = Math.max(
        ChatPanel.DRAWER_MIN_HEIGHT_PX,
        Math.min(window.innerHeight * ChatPanel.PANEL_MAX_HEIGHT_RATIO, startHeight + deltaY)
      );
      this.panel!.style.setProperty('--chat-drawer-height', `${newHeight}px`);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      const value = this.panel!.style.getPropertyValue('--chat-drawer-height');
      if (value) localStorage.setItem(ChatPanel.PANEL_HEIGHT_STORAGE_KEY, value);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Whether the message drawer has anything to show. */
  private get hasContent(): boolean {
    return (
      this.timeline.length > 0 ||
      !!this.streamingText ||
      !!this.streamingThinking ||
      this.showTyping ||
      this.isLoadingSession
    );
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
    render(this.template(), this.panel);
    const scroll = this.panel.querySelector('.chat-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  private template(): TemplateResult {
    return html`
      <div class="chat-resize-handle" @mousedown=${(e: MouseEvent) => this.startResize(e)}></div>
      ${this.topbarTemplate()}
      <div class="chat-scroll">
        ${this.isLoadingSession
          ? html`<div class="chat-loading-session">
              <span class="codicon codicon-loading codicon-modifier-spin"></span>
              <span>${this.loadingLabel}</span>
            </div>`
          : nothing}
        ${repeat(
          this.timeline,
          (item, i) => (item.kind === 'tool' ? `t${item.id}` : item.kind === 'permission' ? `p${item.requestId}` : `m${i}`),
          (item) => this.itemTemplate(item)
        )}
        ${this.streamingText || this.streamingThinking ? this.streamingTemplate() : nothing}
        ${this.showTyping ? html`<div class="chat-typing"><span></span><span></span><span></span></div>` : nothing}
      </div>
      ${this.reverted
        ? html`<div class="chat-redo-banner">
            <span class="codicon codicon-history"></span>
            <span>Session reverted — messages and file changes were undone.</span>
            <button class="chat-redo-btn" @click=${() => this.requestUnrevert()}>
              <span class="codicon codicon-redo"></span> Redo
            </button>
          </div>`
        : nothing}
      ${this.composerTemplate()}
    `;
  }

  private topbarTemplate(): TemplateResult {
    const status = this.connection;
    const statusLabel =
      status === 'connected' ? 'Connected' : status === 'disconnected' ? 'Disconnected' : 'Connecting…';
    const statusTitle =
      status === 'disconnected' && this.connectionReason
        ? `opencode: ${this.connectionReason}`
        : 'opencode connection';
    return html`
      <header class="chat-topbar">
        <span class="chat-title">
          <span class="codicon codicon-comment-discussion"></span>
          <span class="chat-title-text">Chat</span>
        </span>
        <vscode-single-select
          class="chat-session-select"
          title="Session"
          @change=${(e: Event) => {
            const value = (e.target as any).value as string;
            if (value && value !== this.currentSessionId) this.loadSession(value);
          }}
        >
          ${this.sessions.length === 0 ? html`<vscode-option value="">No session</vscode-option>` : nothing}
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
          <span>${item.content}</span>
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
        <div class="chat-row-body">
          ${isUser ? item.content : unsafeHTML(renderMarkdownMemo(item.content))}
        </div>
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
          ? html`<div class="chat-selection-hint">
              <span class="codicon codicon-list-selection"></span>
              ${this.selectedNodeIds.length} node${this.selectedNodeIds.length === 1 ? '' : 's'} selected — "this" refers to ${this.selectedNodeIds.length === 1 ? 'it' : 'them'}
            </div>`
          : nothing}
        <div class="chat-composer">
          <textarea
            class="chat-input"
            rows="1"
            placeholder=${this.currentMode === 'plan'
              ? 'Ask about this workflow…  ("/" for commands)'
              : 'Describe a change or ask anything…  ("/" for commands)'}
            .value=${this.inputValue}
            @input=${(e: Event) => {
              const el = e.target as HTMLTextAreaElement;
              this.inputValue = el.value;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 140) + 'px';
              this.updateMenu();
            }}
            @keydown=${(e: KeyboardEvent) => this.onInputKeydown(e)}
          ></textarea>
          <div class="chat-composer-bar">
            <div class="chat-mode-seg" title="Agent mode (Ctrl+Shift+B / Ctrl+Shift+P)">
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
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      this.switchMode('plan');
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      this.switchMode('build');
    }
  }
}
