import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager, type WorkspaceStorage } from '../src/extension/session-manager.js';
import { ACPClientService } from '../src/extension/acp-client.js';

// Mock ACP Client
vi.mock('../src/extension/acp-client.js', () => ({
  ACPClientService: vi.fn(),
}));

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockACPClient: any;
  let mockStorage: WorkspaceStorage;
  let storageData: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    storageData = new Map();

    // Mock workspace storage
    mockStorage = {
      get: vi.fn((key: string, defaultValue: any) => {
        return storageData.get(key) || defaultValue;
      }),
      update: vi.fn(async (key: string, value: any) => {
        storageData.set(key, value);
      }),
    };

    // Mock ACP client
    mockACPClient = {
      createSession: vi.fn().mockResolvedValue('test-session-123'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue({
        id: 'test-session-123',
        provider: 'default-provider',
      }),
      getSessionMode: vi.fn().mockReturnValue('build'),
    };

    sessionManager = new SessionManager(mockACPClient as any, mockStorage);
  });

  describe('initialize', () => {
    it('should restore sessions from storage', async () => {
      const savedSessions = [
        {
          id: 'session-1',
          name: 'Session 1',
          workflowFile: '/test/workflow.py',
          createdAt: 1000,
          updatedAt: 2000,
          mode: 'build',
          messages: [],
        },
      ];
      storageData.set('workflow.sessions', savedSessions);

      await sessionManager.initialize();

      expect(sessionManager.getAllSessions()).toHaveLength(1);
      // Restoring sessions must NOT auto-select one: the chat panel opens on an
      // explicit empty state, and the user picks or creates a session. Auto-
      // selecting here made a phantom "current" session leak into the panel.
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });

    it('should handle empty storage', async () => {
      await sessionManager.initialize();

      expect(sessionManager.getAllSessions()).toHaveLength(0);
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create new session and save to storage', async () => {
      const session = await sessionManager.createSession(
        '/test/workflow.py',
        'My Session',
        'plan'
      );

      expect(mockACPClient.createSession).toHaveBeenCalledWith(
        '/test',
        'My Session',
        'plan',
        '/test/workflow.py'
      );
      expect(session).toMatchObject({
        id: 'test-session-123',
        name: 'My Session',
        workflowFile: '/test/workflow.py',
        mode: 'plan',
      });
      expect(sessionManager.getCurrentSessionId()).toBe('test-session-123');
      expect(mockStorage.update).toHaveBeenCalled();
    });

    it('should auto-generate session name', async () => {
      const session = await sessionManager.createSession('/test/workflow.py');

      expect(session.name).toBe('Session 1');
    });

    it('should increment session number', async () => {
      await sessionManager.createSession('/test/workflow.py');

      mockACPClient.createSession.mockResolvedValue('test-session-456');
      const session2 = await sessionManager.createSession('/test/workflow.py');

      expect(session2.name).toBe('Session 2');
    });

    it('should not reuse a default name after an interior session is deleted', async () => {
      mockACPClient.createSession.mockResolvedValueOnce('s1');
      const s1 = await sessionManager.createSession('/test/workflow.py');
      mockACPClient.createSession.mockResolvedValueOnce('s2');
      const s2 = await sessionManager.createSession('/test/workflow.py');
      mockACPClient.createSession.mockResolvedValueOnce('s3');
      const s3 = await sessionManager.createSession('/test/workflow.py');

      expect([s1.name, s2.name, s3.name]).toEqual([
        'Session 1',
        'Session 2',
        'Session 3',
      ]);

      // Delete the interior session, then create a new one: the default name
      // must be unique (max existing number + 1), never a duplicate.
      await sessionManager.deleteSession('s2');
      mockACPClient.createSession.mockResolvedValueOnce('s4');
      const s4 = await sessionManager.createSession('/test/workflow.py');

      expect(s4.name).toBe('Session 4');
      const names = sessionManager
        .getSessionsForWorkflow('/test/workflow.py')
        .map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('passes the resolved default name down to the ACP client (no second resolver)', async () => {
      // The default name must be resolved once, up front, and handed to the
      // agent — so the SessionInfo the ACP client builds cannot compute a
      // divergent count-based name of its own.
      mockACPClient.createSession.mockResolvedValueOnce('s1');
      await sessionManager.createSession('/test/workflow.py');
      mockACPClient.createSession.mockResolvedValueOnce('s2');
      await sessionManager.createSession('/test/workflow.py');

      expect(mockACPClient.createSession).toHaveBeenLastCalledWith(
        '/test',
        'Session 2',
        'build',
        '/test/workflow.py'
      );
    });

    it('nextDefaultSessionName / sessionNameExists back a duplicate-safe input default', async () => {
      mockACPClient.createSession.mockResolvedValueOnce('s1');
      await sessionManager.createSession('/test/workflow.py');
      mockACPClient.createSession.mockResolvedValueOnce('s2');
      await sessionManager.createSession('/test/workflow.py');
      mockACPClient.createSession.mockResolvedValueOnce('s3');
      await sessionManager.createSession('/test/workflow.py');

      // Interior delete leaves a gap-y list (Session 1, Session 3) — the helper
      // still yields the next unused number, never a live duplicate.
      await sessionManager.deleteSession('s2');
      expect(sessionManager.nextDefaultSessionName('/test/workflow.py')).toBe(
        'Session 4'
      );

      expect(sessionManager.sessionNameExists('/test/workflow.py', 'Session 1')).toBe(true);
      expect(sessionManager.sessionNameExists('/test/workflow.py', 'Session 2')).toBe(false);
      expect(sessionManager.sessionNameExists('/test/workflow.py', 'Session 4')).toBe(false);
      // Scoped per workflow: a name used in another file is not a duplicate here.
      expect(sessionManager.sessionNameExists('/test/other.py', 'Session 1')).toBe(false);
    });

    it('should ignore renamed/custom names when computing the default number', async () => {
      mockACPClient.createSession.mockResolvedValueOnce('s1');
      await sessionManager.createSession('/test/workflow.py', 'My Custom Chat');
      mockACPClient.createSession.mockResolvedValueOnce('s2');
      const s2 = await sessionManager.createSession('/test/workflow.py');

      // Custom-named session does not count toward "Session N"; first default is 1.
      expect(s2.name).toBe('Session 1');
    });
  });

  describe('loadSession', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Test Session');
    });

    it('should load existing session', async () => {
      const session = await sessionManager.loadSession('test-session-123');

      // loadSession now threads the workflow dir + file through so the ACP
      // client can re-load the session in the agent after a restart.
      expect(mockACPClient.loadSession).toHaveBeenCalledWith('test-session-123', '/test', '/test/workflow.py');
      expect(session).toBeDefined();
      expect(session?.id).toBe('test-session-123');
      expect(sessionManager.getCurrentSessionId()).toBe('test-session-123');
    });

    it('should return null for non-existent session', async () => {
      const session = await sessionManager.loadSession('non-existent');

      expect(session).toBeNull();
    });

    it('should handle load failure', async () => {
      mockACPClient.loadSession.mockRejectedValue(new Error('Load failed'));

      const session = await sessionManager.loadSession('test-session-123');

      expect(session).toBeNull();
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Test Session');
    });

    it('should delete session from storage and ACP', async () => {
      await sessionManager.deleteSession('test-session-123');

      expect(mockACPClient.deleteSession).toHaveBeenCalledWith('test-session-123');
      expect(sessionManager.getAllSessions()).toHaveLength(0);
      expect(sessionManager.getCurrentSessionId()).toBeNull();
      expect(mockStorage.update).toHaveBeenCalled();
    });

    it('should handle ACP delete failure gracefully', async () => {
      mockACPClient.deleteSession.mockRejectedValue(new Error('Delete failed'));

      await sessionManager.deleteSession('test-session-123');

      // Should still delete from local storage
      expect(sessionManager.getAllSessions()).toHaveLength(0);
    });
  });

  describe('getSessionsForWorkflow', () => {
    it('should return sessions for specific workflow', async () => {
      await sessionManager.createSession('/test/workflow1.py', 'Session 1');
      mockACPClient.createSession.mockResolvedValue('session-2');
      await sessionManager.createSession('/test/workflow2.py', 'Session 2');
      mockACPClient.createSession.mockResolvedValue('session-3');
      await sessionManager.createSession('/test/workflow1.py', 'Session 3');

      const sessions = sessionManager.getSessionsForWorkflow('/test/workflow1.py');

      expect(sessions).toHaveLength(2);
      // Sessions are sorted by updatedAt descending (most recent first)
      expect(sessions.map((s) => s.name)).toEqual(['Session 1', 'Session 3']);
    });

    it('should return empty array for workflow with no sessions', () => {
      const sessions = sessionManager.getSessionsForWorkflow('/test/no-sessions.py');

      expect(sessions).toHaveLength(0);
    });
  });

  describe('message management', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Test Session');
    });

    it('should add message to current session', () => {
      sessionManager.addMessage({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const messages = sessionManager.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('should update last message', () => {
      sessionManager.addMessage({
        role: 'assistant',
        content: 'Hello',
        timestamp: Date.now(),
      });

      sessionManager.updateLastMessage({
        content: 'Hello, how can I help?',
      });

      const messages = sessionManager.getMessages();
      expect(messages[0].content).toBe('Hello, how can I help?');
    });

    it('should clear messages', () => {
      sessionManager.addMessage({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      sessionManager.clearMessages();

      expect(sessionManager.getMessages()).toHaveLength(0);
    });

    it('should not add message when no current session', () => {
      sessionManager = new SessionManager(mockACPClient as any, mockStorage);

      sessionManager.addMessage({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      expect(sessionManager.getMessages()).toHaveLength(0);
    });
  });

  describe('session updates', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Test Session');
    });

    it('should update session mode', async () => {
      await sessionManager.updateSessionMode('plan');

      const session = sessionManager.getCurrentSession();
      expect(session?.mode).toBe('plan');
      expect(mockStorage.update).toHaveBeenCalled();
    });

    it('should update session provider', async () => {
      await sessionManager.updateSessionProvider('new-provider');

      const session = sessionManager.getCurrentSession();
      expect(session?.provider).toBe('new-provider');
    });

    it('should rename session', async () => {
      await sessionManager.renameSession('test-session-123', 'New Name');

      const session = sessionManager.getCurrentSession();
      expect(session?.name).toBe('New Name');
    });
  });

  describe('searchMessages', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Session 1');
      sessionManager.addMessage({
        role: 'user',
        content: 'Create a task',
        timestamp: Date.now(),
      });
      sessionManager.addMessage({
        role: 'assistant',
        content: 'I will create a task for you',
        timestamp: Date.now(),
      });

      mockACPClient.createSession.mockResolvedValue('session-2');
      await sessionManager.createSession('/test/workflow.py', 'Session 2');
      sessionManager.addMessage({
        role: 'user',
        content: 'Create an agent',
        timestamp: Date.now(),
      });
    });

    it('should search messages across sessions', () => {
      const results = sessionManager.searchMessages('/test/workflow.py', 'task');

      expect(results).toHaveLength(2);
      expect(results[0].content).toContain('task');
    });

    it('should be case-insensitive', () => {
      const results = sessionManager.searchMessages('/test/workflow.py', 'TASK');

      expect(results).toHaveLength(2);
    });

    it('should return empty array for no matches', () => {
      const results = sessionManager.searchMessages('/test/workflow.py', 'xyz123');

      expect(results).toHaveLength(0);
    });
  });

  describe('export', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Session 1');
      mockACPClient.createSession.mockResolvedValue('session-2');
      await sessionManager.createSession('/test/workflow.py', 'Session 2');
    });

    it('should export single session', () => {
      const exported = sessionManager.exportSession('test-session-123');

      expect(exported).toBeDefined();
      expect(exported?.id).toBe('test-session-123');
    });

    it('should export all sessions for workflow', () => {
      const exported = sessionManager.exportWorkflowSessions('/test/workflow.py');

      expect(exported).toHaveLength(2);
    });
  });

  describe('statistics', () => {
    it('should calculate statistics', async () => {
      await sessionManager.createSession('/test/workflow1.py', 'Session 1');
      sessionManager.addMessage({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      mockACPClient.createSession.mockResolvedValue('session-2');
      await sessionManager.createSession('/test/workflow2.py', 'Session 2');
      sessionManager.addMessage({
        role: 'user',
        content: 'Hi',
        timestamp: Date.now(),
      });

      const stats = sessionManager.getStatistics();

      expect(stats.totalSessions).toBe(2);
      expect(stats.totalMessages).toBe(2);
      expect(stats.workflows).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all sessions for workflow', async () => {
      await sessionManager.createSession('/test/workflow.py', 'Session 1');
      mockACPClient.createSession.mockResolvedValue('session-2');
      await sessionManager.createSession('/test/workflow.py', 'Session 2');
      mockACPClient.createSession.mockResolvedValue('session-3');
      await sessionManager.createSession('/test/other.py', 'Session 3');

      await sessionManager.cleanupWorkflowSessions('/test/workflow.py');

      expect(sessionManager.getSessionsForWorkflow('/test/workflow.py')).toHaveLength(0);
      expect(sessionManager.getSessionsForWorkflow('/test/other.py')).toHaveLength(1);
    });
  });
});
