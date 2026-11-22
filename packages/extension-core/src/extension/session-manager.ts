import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ACPClientService, SessionInfo } from './acp-client.js';
import { byTime, type SessionChange, type SessionStore } from './session-store.js';

export interface SessionData {
  id: string;
  name: string;
  workflowFile: string;
  createdAt: number;
  updatedAt: number;
  mode: 'plan' | 'build';
  provider?: string;
  messages: MessageData[];
}

export interface MessageData {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  mode?: 'plan' | 'build';
  provider?: string;
  /** Assistant reasoning ("thinking") captured during the turn, persisted so it
   *  survives a panel reload (rendered as a collapsible block). */
  thinking?: string;
  /** How many images a user's message carried (their bytes are not kept). */
  images?: number;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  /** Tool-call status, stored verbatim as the agent reports it (e.g. 'pending',
   *  'in_progress', 'completed', 'failed') so the restored chip matches the live one. */
  toolStatus?: string;
  /** Names the message in the store, so a change that lands twice adds it once. */
  key?: string;
}

export interface WorkspaceStorage {
  get<T>(key: string, defaultValue: T): T;
  // Thenable so vscode.Memento satisfies this interface directly.
  update(key: string, value: any): Thenable<void>;
}

/** The workspaceState key chats were kept under before the session store. */
export const LEGACY_SESSIONS_KEY = 'dialogram.sessions';

/**
 * Chat sessions of each diagram file.
 *
 * They are kept in a {@link SessionStore} on the machine the extension host
 * runs on, beside the agent's own sessions, not in the window's
 * workspaceState: VS Code keeps that on the client, under the window's URI, so
 * a local window and a Remote-SSH window on the same folder (or two people's
 * clients) each saw their own list, and none saw the chats the agent holds.
 *
 * Another window on the same folder changes the same sessions, so the store
 * is what a session is and the map is what this window knows of it: each
 * change (a message, a rename, a mode) is added to the kept session, never
 * written over it, and {@link refresh} and {@link loadSession} read the store
 * again, so a session another window made, extended or deleted shows. What
 * this window holds that is not kept yet (a change on its way, or one that
 * failed and goes again with the next) is never dropped by a read.
 */
export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  /** The sessions this window has seen kept: one missing later was deleted. */
  private stored = new Set<string>();
  /** Changes that failed to land, sent again before a session's next one. */
  private unsent = new Map<string, SessionChange[]>();
  /** Each session's changes, one after the other, in the order made. */
  private queues = new Map<string, Promise<void>>();
  /** Keys of the messages this window made: its panel showed them as they came. */
  private local = new Set<string>();
  private currentSessionId: string | null = null;
  private ready: Promise<void> | undefined;

  constructor(
    private acpClient: ACPClientService,
    private store: SessionStore,
    /** Where chats were kept before; moved into the store once. */
    private legacyStorage?: WorkspaceStorage,
    /** Told when a session cannot be kept or read; the chat goes on. */
    private onStoreError: (error: unknown, failed?: 'save' | 'read') => void = (error) => console.error('Chat session store:', error)
  ) {}

  /**
   * Move chats kept in workspaceState into the store. Everything else waits
   * for it, so a list is never read before they are in; if some could not be
   * moved, the next list tries again.
   */
  initialize(): Promise<void> {
    if (!this.ready) {
      const moving: Promise<void> = this.moveLegacySessions().then(
        (allMoved) => {
          if (!allMoved && this.ready === moving) this.ready = undefined;
        },
        (error) => {
          this.onStoreError(error);
          if (this.ready === moving) this.ready = undefined;
        }
      );
      this.ready = moving;
    }
    return this.ready;
  }

  /** Resolves once every change asked for so far has landed or failed. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled([...this.queues.values()]);
    }
  }

  /**
   * Read the store's sessions of a diagram file into this window: those
   * another window made appear, the kept copy is taken (with what this
   * window has not kept yet), and those deleted elsewhere go. A session this
   * window has not seen kept (made while the list was read, or one whose
   * write failed) stays, and so does one that is there but cannot be read.
   */
  async refresh(workflowFile: string): Promise<void> {
    await this.initialize();
    const seenKept = new Set(this.stored);
    const kept = await this.store.list(workflowFile);
    const keptIds = new Set(kept.map((session) => session.id));
    const missing = [...this.sessions.values()].filter(
      (session) => session.workflowFile === workflowFile && seenKept.has(session.id) && !keptIds.has(session.id)
    );
    for (const session of missing) {
      const there = await this.store.has(workflowFile, session.id).catch(() => true);
      if (!there) this.forget(session.id);
    }
    for (const session of kept) {
      this.take(session);
    }
  }

  /**
   * Create a new session for a workflow file
   */
  async createSession(
    workflowFile: string,
    name?: string,
    mode: 'plan' | 'build' = 'build'
  ): Promise<SessionData> {
    // Another window may have made a "Session N" since this one listed them.
    if (!name) await this.refresh(workflowFile).catch((error) => this.onStoreError(error, 'read'));
    // Resolve the default name BEFORE spawning the session so the same helper is
    // the single source of truth for every default name (agent-side SessionInfo
    // included) — no second count-based resolver may compute a name elsewhere.
    const resolvedName = name || this.nextDefaultSessionName(workflowFile);
    const cwd = this.getWorkflowDirectory(workflowFile);
    const sessionId = await this.acpClient.createSession(cwd, resolvedName, mode, workflowFile);

    const sessionData: SessionData = {
      id: sessionId,
      name: resolvedName,
      workflowFile,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      provider: this.acpClient.getSession(sessionId)?.provider,
      messages: [],
    };

    this.sessions.set(sessionId, sessionData);
    this.currentSessionId = sessionId;

    await this.keep(sessionData);

    return sessionData;
  }

  /**
   * Compute a unique default name ("Session N") for a new session in a workflow.
   *
   * Uses the highest existing "Session <n>" number + 1 rather than the session
   * count, so deleting an interior session can never yield a duplicate default
   * name (e.g. deleting "Session 2" of 3 must still produce "Session 4", not a
   * second "Session 3"). Renamed/custom names that don't match the pattern are
   * ignored.
   */
  nextDefaultSessionName(workflowFile: string): string {
    const pattern = /^Session (\d+)$/;
    let maxNumber = 0;
    for (const session of this.getSessionsForWorkflow(workflowFile)) {
      const match = pattern.exec(session.name);
      if (match) {
        maxNumber = Math.max(maxNumber, Number.parseInt(match[1], 10));
      }
    }
    return `Session ${maxNumber + 1}`;
  }

  /**
   * Whether a session with the given name already exists for this workflow.
   * Backs the new-session input box's duplicate-name guard.
   */
  sessionNameExists(workflowFile: string, name: string): boolean {
    return this.getSessionsForWorkflow(workflowFile).some(
      (session) => session.name === name
    );
  }

  /**
   * Load an existing session. Null when the agent cannot load it, or when
   * another window deleted it (then it is no longer known here either).
   */
  async loadSession(sessionId: string): Promise<SessionData | null> {
    if (!this.sessions.has(sessionId)) {
      return null;
    }

    // Another window may have gone on with it, or deleted it, since this one
    // listed it: take the kept copy.
    const listed = this.sessions.get(sessionId)!;
    try {
      const kept = await this.store.read(listed.workflowFile, sessionId);
      if (kept) {
        this.take(kept);
      } else if (this.stored.has(sessionId)) {
        this.forget(sessionId);
        return null;
      }
    } catch (error) {
      this.onStoreError(error, 'read');
    }
    const session = this.sessions.get(sessionId) ?? listed;

    try {
      // Pass the stored workflow file + its directory so the ACP client can
      // re-load the session in the agent even after an extension restart (when
      // its in-memory session map is empty).
      await this.acpClient.loadSession(
        sessionId,
        this.getWorkflowDirectory(session.workflowFile),
        session.workflowFile,
        session.mode
      );
      this.currentSessionId = sessionId;
      return session;
    } catch (error) {
      console.error('Failed to load session:', error);
      return null;
    }
  }

  /** Whether this window made the message with this key. */
  isLocal(key: string): boolean {
    return this.local.has(key);
  }

  /**
   * Whether a session is gone: deleted in another window since this one saw
   * it kept (it is then forgotten here), or never known. One that cannot be
   * checked is taken as there.
   */
  async isGone(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return true;
    if (!this.stored.has(sessionId)) return false;
    const there = await this.store.has(session.workflowFile, sessionId).catch(() => true);
    if (!there) this.forget(sessionId);
    return !there;
  }

  /**
   * Delete a session: its file, then the agent's session. It is forgotten
   * once its file is gone; one whose file could not be removed stays, whole
   * (the agent's too), the failure is told, and false says so.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      let removed = false;
      await this.enqueue(sessionId, async () => {
        try {
          await this.store.remove(session.workflowFile, sessionId);
          removed = true;
        } catch (error) {
          this.onStoreError(error);
        }
      });
      if (!removed) return false;
      this.forget(sessionId);
    }

    try {
      await this.acpClient.deleteSession(sessionId);
    } catch (error) {
      console.error('Failed to delete ACP session:', error);
    }
    return true;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Set current session
   */
  setCurrentSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.currentSessionId = sessionId;
    }
  }

  /**
   * Get all sessions for a specific workflow file
   */
  getSessionsForWorkflow(workflowFile: string): SessionData[] {
    // Most recent first; between equal times (created or restored in the same
    // millisecond), the one added later.
    return Array.from(this.sessions.values())
      .map((session, order) => ({ session, order }))
      .filter(({ session }) => session.workflowFile === workflowFile)
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt
        || b.session.createdAt - a.session.createdAt
        || b.order - a.order)
      .map(({ session }) => session);
  }

  /**
   * Append a message to a specific session and persist it.
   */
  addMessageToSession(sessionId: string, message: MessageData): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const added: MessageData = { ...message, key: message.key ?? newMessageKey() };
    this.local.add(added.key!);
    session.messages.push(added);
    session.updatedAt = Date.now();
    void this.keep(session, { t: 'message', message: added });
  }

  /**
   * Get the persisted messages for a specific session.
   */
  getSessionMessages(sessionId: string): MessageData[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /**
   * Update session mode
   */
  async updateSessionMode(mode: 'plan' | 'build'): Promise<void> {
    if (!this.currentSessionId) {
      return;
    }

    const session = this.sessions.get(this.currentSessionId);
    if (session) {
      session.mode = mode;
      session.updatedAt = Date.now();
      await this.keep(session, { t: 'mode', mode });
    }
  }

  /**
   * Rename session
   */
  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.name = newName;
      session.updatedAt = Date.now();
      await this.keep(session, { t: 'name', name: newName });
    }
  }

  /**
   * Look up a session by id
   */
  getSession(sessionId: string): SessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Keep a change, already made to this window's copy, in the store.
   *
   * A session never kept (just made, or whose creation failed) is kept whole
   * from this window's copy, which has every change. One kept gets the
   * changes that failed before, then this one; if it is no longer kept, it was
   * deleted in another window and is forgotten here, not made again. A
   * failure is told, and the changes not kept go again with the next.
   */
  private keep(session: SessionData, change?: SessionChange): Promise<void> {
    const id = session.id;
    if (change) this.unsentOf(id).push(change);
    return this.enqueue(id, async () => {
      try {
        if (!this.stored.has(id)) {
          const current = this.sessions.get(id);
          if (!current) return;
          // The copy has every change made so far. Its messages are kept with
          // it (one kept already gets those it lacks); a rename or a mode is
          // added after it as well, as a kept one keeps its own name and mode.
          const changes = this.unsent.get(id);
          const included = changes?.length ?? 0;
          if (!(await this.store.create(structuredClone(current)))) {
            // Deleted meanwhile, in another window: not made again.
            this.forget(id);
            return;
          }
          this.stored.add(id);
          if (changes) changes.unshift(...changes.splice(0, included).filter((c) => c.t !== 'message'));
        }
        const pending = this.unsent.get(id);
        while (pending && pending.length > 0) {
          if (!(await this.store.append(session.workflowFile, id, pending[0]))) {
            this.forget(id);
            return;
          }
          pending.shift();
        }
        if (this.unsent.get(id)?.length === 0) this.unsent.delete(id);
      } catch (error) {
        this.onStoreError(error);
      }
    });
  }

  /** The changes of a session still to be kept, in the order made. */
  private unsentOf(sessionId: string): SessionChange[] {
    let changes = this.unsent.get(sessionId);
    if (!changes) {
      changes = [];
      this.unsent.set(sessionId, changes);
    }
    return changes;
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation);
    this.queues.set(sessionId, next);
    void next.then(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
    });
    return next;
  }

  /**
   * Take the kept copy of a session, with what this window has not kept yet:
   * its messages the copy lacks, and its name and mode if a change of them is
   * still to go.
   */
  private take(kept: SessionData): void {
    const mine = this.sessions.get(kept.id);
    if (mine) {
      const have = new Set(kept.messages.map((m) => m.key).filter(Boolean));
      for (const message of mine.messages) {
        if (message.key && !have.has(message.key)) kept.messages.push(message);
      }
      for (const change of this.unsent.get(kept.id) ?? []) {
        if (change.t === 'name') kept.name = change.name;
        if (change.t === 'mode') kept.mode = change.mode;
      }
      kept.messages = byTime(kept.messages);
    }
    this.sessions.set(kept.id, kept);
    this.stored.add(kept.id);
  }

  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.stored.delete(sessionId);
    this.unsent.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * Get workflow directory from file path
   */
  private getWorkflowDirectory(workflowFile: string): string {
    return path.dirname(workflowFile);
  }

  /**
   * Move the chats workspaceState holds into the store (one another window
   * kept already stays as kept, with what this copy adds), and clear them
   * there once all are in. Each is in this window's map either way, so one
   * that could not be moved still shows. Resolves whether all moved.
   *
   * Deliberately no current session is chosen: the chat panel opens on an
   * explicit empty state, and a session becomes current only when the user
   * loads or creates one.
   */
  private async moveLegacySessions(): Promise<boolean> {
    const legacy = this.legacyStorage?.get<SessionData[] | undefined>(LEGACY_SESSIONS_KEY, undefined);
    if (!Array.isArray(legacy) || legacy.length === 0) {
      return true;
    }
    const left: SessionData[] = [];
    for (const session of legacy) {
      if (typeof session?.id !== 'string' || typeof session.workflowFile !== 'string') continue;
      session.messages ??= [];
      try {
        // Moved before (clearing the key failed), then deleted: not again.
        if (!(await this.store.create(session))) continue;
        if (!this.sessions.has(session.id)) this.sessions.set(session.id, session);
        this.stored.add(session.id);
      } catch (error) {
        if (!this.sessions.has(session.id)) this.sessions.set(session.id, session);
        left.push(session);
        this.onStoreError(error);
      }
    }
    // Only those not moved stay there, for the next try.
    try {
      await this.legacyStorage?.update(LEGACY_SESSIONS_KEY, left.length > 0 ? left : undefined);
    } catch (error) {
      this.onStoreError(error);
      return false;
    }
    return left.length === 0;
  }
}

/** A key no other message of any window has. */
function newMessageKey(): string {
  return randomUUID();
}
