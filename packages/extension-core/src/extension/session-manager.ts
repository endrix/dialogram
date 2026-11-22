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
 * The map is what this window knows; {@link refresh} and {@link loadSession}
 * read the store again, so a session another window made or extended shows.
 */
export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private currentSessionId: string | null = null;
  private ready: Promise<void> | undefined;

  constructor(
    private acpClient: ACPClientService,
    private store: SessionStore,
    /** Where chats were kept before; moved into the store once. */
    private legacyStorage?: WorkspaceStorage
  ) {}

  /**
   * Move chats kept in workspaceState into the store. Everything else waits
   * for it, so a list is never read before they are in.
   */
  initialize(): Promise<void> {
    this.ready ??= this.moveLegacySessions().catch((error) => {
      console.error('Failed to move chat sessions into the session store:', error);
    });
    return this.ready;
  }

  /**
   * Read the store's sessions of a diagram file into this window: those
   * another window made appear, a newer copy replaces this one's, and those
   * deleted elsewhere go.
   */
  async refresh(workflowFile: string): Promise<void> {
    await this.initialize();
    const stored = await this.store.list(workflowFile);
    const storedIds = new Set(stored.map((session) => session.id));
    for (const [id, session] of this.sessions) {
      if (session.workflowFile === workflowFile && !storedIds.has(id)) {
        this.sessions.delete(id);
      }
    }
    for (const session of stored) {
      this.adopt(session);
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

    await this.save(sessionData);

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

    // Another window may have gone on with it since this one listed it.
    try {
      const stored = await this.store.read(session.workflowFile, sessionId);
      if (stored) {
        this.adopt(stored);
        session = this.sessions.get(sessionId) ?? session;
      }
    } catch (error) {
      console.error('Failed to read the stored chat session:', error);
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
    this.sessions.delete(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    if (session) {
      try {
        await this.store.remove(session.workflowFile, sessionId);
      } catch (error) {
        console.error('Failed to remove the stored chat session:', error);
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
    session.messages.push(message);
    session.updatedAt = Date.now();
    void this.save(session);
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
      await this.save(session);
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
      await this.save(session);
    }
  }

  /**
   * Look up a session by id
   */
  getSession(sessionId: string): SessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /** Keep a session in the store; a failure is logged, the chat goes on. */
  private async save(session: SessionData): Promise<void> {
    try {
      await this.store.write(session);
    } catch (error) {
      console.error('Failed to store the chat session:', error);
    }
  }

  /** Take the stored copy of a session unless this window's is as new. */
  private adopt(stored: SessionData): void {
    const known = this.sessions.get(stored.id);
    if (!known || stored.updatedAt > known.updatedAt) {
      this.sessions.set(stored.id, stored);
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
   * of a session both have, then clear them there. A session the store kept
   * newer from another window wins. Nothing is cleared unless all are in.
   *
   * Deliberately no current session is chosen: the chat panel opens on an
   * explicit empty state, and a session becomes current only when the user
   * loads or creates one.
   */
  private async moveLegacySessions(): Promise<void> {
    const legacy = this.legacyStorage?.get<SessionData[] | undefined>(LEGACY_SESSIONS_KEY, undefined);
    if (!Array.isArray(legacy) || legacy.length === 0) {
      return;
    }
    for (const session of legacy) {
      if (typeof session?.id !== 'string' || typeof session.workflowFile !== 'string') continue;
      session.messages ??= [];
      const stored = await this.store.read(session.workflowFile, session.id);
      if (!stored || stored.updatedAt < session.updatedAt) {
        await this.store.write(session);
        this.adopt(session);
      } else {
        this.adopt(stored);
      }
    }
    await this.legacyStorage?.update(LEGACY_SESSIONS_KEY, undefined);
  }
}
