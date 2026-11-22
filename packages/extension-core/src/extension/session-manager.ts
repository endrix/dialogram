import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ACPClientService, SessionInfo } from './acp-client.js';
import type { SessionStore } from './session-store.js';

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
 * Another window on the same folder changes the same files, so the store is
 * what a session is; the map is what this window knows of it. A change (a
 * message, a rename, a mode) is applied to the copy kept now, never by writing
 * this window's copy over it. {@link refresh} and {@link loadSession} read the
 * store again, so a session another window made, extended or deleted shows.
 */
export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  /** The sessions this window has seen kept: one missing later was deleted. */
  private stored = new Set<string>();
  private currentSessionId: string | null = null;
  private ready: Promise<void> | undefined;

  constructor(
    private acpClient: ACPClientService,
    private store: SessionStore,
    /** Where chats were kept before; moved into the store once. */
    private legacyStorage?: WorkspaceStorage,
    /** Told when a session cannot be kept or read; the chat goes on. */
    private onStoreError: (error: unknown) => void = (error) => console.error('Chat session store:', error)
  ) {}

  /**
   * Move chats kept in workspaceState into the store. Everything else waits
   * for it, so a list is never read before they are in; if some could not be
   * moved, the next list tries again.
   */
  initialize(): Promise<void> {
    if (!this.ready) {
      const moving = this.moveLegacySessions().then((allMoved) => {
        if (!allMoved && this.ready === moving) this.ready = undefined;
      });
      this.ready = moving;
    }
    return this.ready;
  }

  /**
   * Read the store's sessions of a diagram file into this window: those
   * another window made appear, the kept copy replaces this one's, and those
   * deleted elsewhere go. A session this window holds but has not seen kept
   * (made while the list was read, or one whose write failed) stays.
   */
  async refresh(workflowFile: string): Promise<void> {
    await this.initialize();
    await this.store.idle();
    const seenKept = new Set(this.stored);
    const kept = await this.store.list(workflowFile);
    const keptIds = new Set(kept.map((session) => session.id));
    for (const [id, session] of this.sessions) {
      if (session.workflowFile === workflowFile && seenKept.has(id) && !keptIds.has(id)) {
        this.forget(id);
      }
    }
    for (const session of kept) {
      this.sessions.set(session.id, session);
      this.stored.add(session.id);
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
    if (!name) await this.refresh(workflowFile).catch((error) => this.onStoreError(error));
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

    await this.change(sessionData, () => undefined);

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
   * Load an existing session
   */
  async loadSession(sessionId: string): Promise<SessionData | null> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // Another window may have gone on with it, or deleted it, since this one
    // listed it: the kept copy is the session.
    try {
      await this.store.idle();
      const kept = await this.store.read(session.workflowFile, sessionId);
      if (kept) {
        this.sessions.set(sessionId, kept);
        this.stored.add(sessionId);
        session = kept;
      } else if (this.stored.has(sessionId)) {
        this.forget(sessionId);
        return null;
      }
    } catch (error) {
      this.onStoreError(error);
    }

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

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.acpClient.deleteSession(sessionId);
    } catch (error) {
      console.error('Failed to delete ACP session:', error);
    }

    const session = this.sessions.get(sessionId);
    this.forget(sessionId);

    if (session) {
      try {
        await this.store.remove(session.workflowFile, sessionId);
      } catch (error) {
        this.onStoreError(error);
      }
    }
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
    session.messages.push(added);
    session.updatedAt = Date.now();
    void this.change(session, (kept) => {
      if (!kept.messages.some((m) => m.key === added.key)) kept.messages.push(added);
    });
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
      await this.change(session, (kept) => {
        kept.mode = mode;
      });
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
      await this.change(session, (kept) => {
        kept.name = newName;
      });
    }
  }

  /**
   * Look up a session by id
   */
  getSession(sessionId: string): SessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Apply a change, already made to this window's copy, to the kept one.
   *
   * None kept: a session this window saw kept was deleted in another, and is
   * not written again but forgotten here; one never kept (just made, or whose
   * write failed) is written whole. A failure is reported and the session
   * stays, so a later change can keep it.
   */
  private async change(session: SessionData, edit: (kept: SessionData) => void): Promise<void> {
    let deletedElsewhere = false;
    try {
      await this.store.update(session.workflowFile, session.id, (kept) => {
        if (!kept) {
          if (this.stored.has(session.id)) {
            deletedElsewhere = true;
            return undefined;
          }
          return structuredClone(session);
        }
        edit(kept);
        kept.updatedAt = Math.max(kept.updatedAt, session.updatedAt);
        return kept;
      });
    } catch (error) {
      this.onStoreError(error);
      return;
    }
    if (deletedElsewhere) {
      this.forget(session.id);
    } else {
      this.stored.add(session.id);
    }
  }

  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.stored.delete(sessionId);
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
   * Move the chats workspaceState holds into the store, keeping the newer copy
   * of a session both have (another window may have kept it since), and clear
   * them there once all are in. Each is in this window's map either way, so
   * one that could not be moved still shows. Resolves whether all moved.
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
    let allMoved = true;
    for (const session of legacy) {
      if (typeof session?.id !== 'string' || typeof session.workflowFile !== 'string') continue;
      session.messages ??= [];
      if (!this.sessions.has(session.id)) this.sessions.set(session.id, session);
      try {
        let newer: SessionData | undefined;
        await this.store.update(session.workflowFile, session.id, (kept) => {
          if (kept && kept.updatedAt >= session.updatedAt) {
            newer = kept;
            return undefined;
          }
          return session;
        });
        this.sessions.set(session.id, newer ?? session);
        this.stored.add(session.id);
      } catch (error) {
        allMoved = false;
        this.onStoreError(error);
      }
    }
    if (allMoved) {
      await this.legacyStorage?.update(LEGACY_SESSIONS_KEY, undefined);
    }
    return allMoved;
  }
}

/** A key no other message of any window has. */
function newMessageKey(): string {
  return randomUUID();
}
