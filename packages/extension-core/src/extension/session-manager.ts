import { injectable } from 'inversify';
import type { ACPClientService, SessionInfo } from './acp-client.js';
import { LEGACY_KEYS, readStateWithMigration } from './legacy-settings-compat.js';

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

/**
 * Session Manager for per-workflow session persistence
 * Sessions are scoped to individual workflow files and cannot be shared
 */
@injectable()
export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private currentSessionId: string | null = null;
  private storageKey = LEGACY_KEYS.sessions.current;

  constructor(
    private acpClient: ACPClientService,
    private workspaceStorage: WorkspaceStorage
  ) {}

  /**
   * Initialize session manager and restore sessions from storage
   */
  async initialize(): Promise<void> {
    await this.restoreSessions();
  }

  /**
   * Create a new session for a workflow file
   */
  async createSession(
    workflowFile: string,
    name?: string,
    mode: 'plan' | 'build' = 'build'
  ): Promise<SessionData> {
    const cwd = this.getWorkflowDirectory(workflowFile);
    const sessionId = await this.acpClient.createSession(cwd, name, mode, workflowFile);

    const sessionData: SessionData = {
      id: sessionId,
      name: name || `Session ${this.getSessionsForWorkflow(workflowFile).length + 1}`,
      workflowFile,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      provider: this.acpClient.getSession(sessionId)?.provider,
      messages: [],
    };

    this.sessions.set(sessionId, sessionData);
    this.currentSessionId = sessionId;

    await this.saveSessions();

    return sessionData;
  }

  /**
   * Load an existing session
   */
  async loadSession(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    try {
      // Pass the stored workflow file + its directory so the ACP client can
      // re-load the session in the agent even after an extension restart (when
      // its in-memory session map is empty).
      await this.acpClient.loadSession(
        sessionId,
        this.getWorkflowDirectory(session.workflowFile),
        session.workflowFile
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

    this.sessions.delete(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    await this.saveSessions();
  }

  /**
   * Get current active session
   */
  getCurrentSession(): SessionData | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.sessions.get(this.currentSessionId) || null;
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
    return Array.from(this.sessions.values())
      .filter((s) => s.workflowFile === workflowFile)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionData[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
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
    void this.saveSessions();
  }

  /**
   * Get the persisted messages for a specific session.
   */
  getSessionMessages(sessionId: string): MessageData[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /**
   * Add message to current session
   */
  addMessage(message: MessageData): void {
    if (!this.currentSessionId) {
      return;
    }

    const session = this.sessions.get(this.currentSessionId);
    if (session) {
      session.messages.push(message);
      session.updatedAt = Date.now();
      this.saveSessions(); // Save asynchronously
    }
  }

  /**
   * Update last message in current session (for streaming)
   */
  updateLastMessage(updates: Partial<MessageData>): void {
    if (!this.currentSessionId) {
      return;
    }

    const session = this.sessions.get(this.currentSessionId);
    if (session && session.messages.length > 0) {
      const lastMessage = session.messages[session.messages.length - 1];
      Object.assign(lastMessage, updates);
      session.updatedAt = Date.now();
    }
  }

  /**
   * Get messages for current session
   */
  getMessages(): MessageData[] {
    if (!this.currentSessionId) {
      return [];
    }

    const session = this.sessions.get(this.currentSessionId);
    return session?.messages || [];
  }

  /**
   * Clear messages for current session
   */
  clearMessages(): void {
    if (!this.currentSessionId) {
      return;
    }

    const session = this.sessions.get(this.currentSessionId);
    if (session) {
      session.messages = [];
      session.updatedAt = Date.now();
      this.saveSessions();
    }
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
      await this.saveSessions();
    }
  }

  /**
   * Update session provider
   */
  async updateSessionProvider(provider: string): Promise<void> {
    if (!this.currentSessionId) {
      return;
    }

    const session = this.sessions.get(this.currentSessionId);
    if (session) {
      session.provider = provider;
      session.updatedAt = Date.now();
      await this.saveSessions();
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
      await this.saveSessions();
    }
  }

  /**
   * Search messages across all sessions for a workflow
   */
  searchMessages(workflowFile: string, query: string): MessageData[] {
    const sessions = this.getSessionsForWorkflow(workflowFile);
    const results: MessageData[] = [];

    const lowerQuery = query.toLowerCase();

    for (const session of sessions) {
      for (const message of session.messages) {
        if (message.content.toLowerCase().includes(lowerQuery)) {
          results.push({
            ...message,
            // Add session context to message
            sessionId: session.id,
            sessionName: session.name,
          } as any);
        }
      }
    }

    return results;
  }

  /**
   * Look up a session by id
   */
  getSession(sessionId: string): SessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Export session history as JSON
   */
  exportSession(sessionId: string): SessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Export all sessions for a workflow
   */
  exportWorkflowSessions(workflowFile: string): SessionData[] {
    return this.getSessionsForWorkflow(workflowFile);
  }

  /**
   * Save sessions to workspace storage
   */
  private async saveSessions(): Promise<void> {
    const data = Array.from(this.sessions.values());
    await this.workspaceStorage.update(this.storageKey, data);
  }

  /**
   * Restore sessions from workspace storage
   */
  private async restoreSessions(): Promise<void> {
    const data = await readStateWithMigration<SessionData[]>(
      this.workspaceStorage,
      LEGACY_KEYS.sessions.current,
      LEGACY_KEYS.sessions.legacy,
      [],
    );

    for (const session of data) {
      this.sessions.set(session.id, session);
    }

    // Try to restore current session
    if (data.length > 0) {
      const mostRecent = data.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      this.currentSessionId = mostRecent.id;
    }
  }

  /**
   * Get workflow directory from file path
   */
  private getWorkflowDirectory(workflowFile: string): string {
    const path = require('path');
    return path.dirname(workflowFile);
  }

  /**
   * Cleanup sessions for a workflow file
   */
  async cleanupWorkflowSessions(workflowFile: string): Promise<void> {
    const sessions = this.getSessionsForWorkflow(workflowFile);

    for (const session of sessions) {
      await this.deleteSession(session.id);
    }
  }

  /**
   * Get session statistics
   */
  getStatistics(): {
    totalSessions: number;
    totalMessages: number;
    workflows: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const workflows = new Set(sessions.map((s) => s.workflowFile));
    const totalMessages = sessions.reduce(
      (sum, s) => sum + s.messages.length,
      0
    );

    return {
      totalSessions: sessions.length,
      totalMessages,
      workflows: workflows.size,
    };
  }
}
