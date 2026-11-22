import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager, type SessionData, type WorkspaceStorage } from '../src/extension/session-manager.js';
import { FileSessionStore, type SessionChange } from '../src/extension/session-store.js';
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
  let store: FileSessionStore;

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

    // The setup file gives each test its own data folder.
    store = new FileSessionStore(process.env.DIALOGRAM_DATA_DIR!);
    sessionManager = new SessionManager(mockACPClient as any, store, mockStorage);
  });

  describe('initialize', () => {
    it('moves the chats workspaceState kept into the store, once', async () => {
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
      storageData.set('dialogram.sessions', savedSessions);

      await sessionManager.initialize();

      expect(sessionManager.getSessionsForWorkflow('/test/workflow.py')).toHaveLength(1);
      expect((await store.list('/test/workflow.py')).map((s) => s.id)).toEqual(['session-1']);
      // Cleared where it was, so a session deleted later does not come back.
      expect(storageData.get('dialogram.sessions')).toBeUndefined();
      // Restoring sessions must NOT auto-select one: the chat panel opens on an
      // explicit empty state, and the user picks or creates a session. Auto-
      // selecting here made a phantom "current" session leak into the panel.
      expect(sessionManager.getCurrentSessionId()).toBeNull();
    });

    it('should handle empty storage', async () => {
      await sessionManager.initialize();

      expect(sessionManager.getSessionsForWorkflow('/test/workflow.py')).toHaveLength(0);
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
      expect(await store.read('/test/workflow.py', 'test-session-123')).toMatchObject({
        name: 'My Session',
        mode: 'plan',
        messages: [],
      });
      // Nothing goes to workspaceState any more.
      expect(mockStorage.update).not.toHaveBeenCalled();
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

      // loadSession threads the workflow dir + file through so the ACP client
      // can re-load the session in the agent after a restart, and the stored
      // mode, which the session is in when the agent does not say.
      expect(mockACPClient.loadSession).toHaveBeenCalledWith('test-session-123', '/test', '/test/workflow.py', 'build');
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
      expect(sessionManager.getSessionsForWorkflow('/test/workflow.py')).toHaveLength(0);
      expect(sessionManager.getCurrentSessionId()).toBeNull();
      expect(await store.list('/test/workflow.py')).toEqual([]);
    });

    it('should handle ACP delete failure gracefully', async () => {
      mockACPClient.deleteSession.mockRejectedValue(new Error('Delete failed'));

      await sessionManager.deleteSession('test-session-123');

      // Should still delete from local storage
      expect(sessionManager.getSessionsForWorkflow('/test/workflow.py')).toHaveLength(0);
    });
  });

  describe('getSessionsForWorkflow', () => {
    it('should return sessions for specific workflow', async () => {
      // Each session at its own time, so the order is the updatedAt sort's.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        await sessionManager.createSession('/test/workflow1.py', 'Session 1');
        vi.setSystemTime(2_000);
        mockACPClient.createSession.mockResolvedValue('session-2');
        await sessionManager.createSession('/test/workflow2.py', 'Session 2');
        vi.setSystemTime(3_000);
        mockACPClient.createSession.mockResolvedValue('session-3');
        await sessionManager.createSession('/test/workflow1.py', 'Session 3');
      } finally {
        vi.useRealTimers();
      }

      const sessions = sessionManager.getSessionsForWorkflow('/test/workflow1.py');

      expect(sessions).toHaveLength(2);
      // Sessions are sorted by updatedAt descending (most recent first)
      expect(sessions.map((s) => s.name)).toEqual(['Session 3', 'Session 1']);
    });

    it('should put the later of two sessions with the same time first', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(5_000);
        await sessionManager.createSession('/test/same.py', 'Earlier');
        mockACPClient.createSession.mockResolvedValue('session-later');
        await sessionManager.createSession('/test/same.py', 'Later');
      } finally {
        vi.useRealTimers();
      }

      expect(sessionManager.getSessionsForWorkflow('/test/same.py').map((s) => s.name)).toEqual(['Later', 'Earlier']);
    });

    it('should return empty array for workflow with no sessions', () => {
      const sessions = sessionManager.getSessionsForWorkflow('/test/no-sessions.py');

      expect(sessions).toHaveLength(0);
    });
  });

  describe('session updates', () => {
    beforeEach(async () => {
      await sessionManager.createSession('/test/workflow.py', 'Test Session');
    });

    it('should update session mode', async () => {
      await sessionManager.updateSessionMode('plan');

      const session = sessionManager.getSession('test-session-123');
      expect(session?.mode).toBe('plan');
      expect((await store.read('/test/workflow.py', 'test-session-123'))?.mode).toBe('plan');
    });

    it('should rename session', async () => {
      await sessionManager.renameSession('test-session-123', 'New Name');

      const session = sessionManager.getSession('test-session-123');
      expect(session?.name).toBe('New Name');
    });
  });

  describe('two windows on one store (a local and a Remote-SSH window)', () => {
    const FILE = '/test/workflow.py';
    const root = () => process.env.DIALOGRAM_DATA_DIR!;
    const window = (store = new FileSessionStore(root()), legacy?: WorkspaceStorage, onError?: (e: unknown) => void) =>
      new SessionManager(mockACPClient as any, store, legacy, onError);
    const said = async (id = 'test-session-123') =>
      (await new FileSessionStore(root()).read(FILE, id))?.messages.map((m) => m.content);
    const message = (content: string) => ({ role: 'user' as const, content, timestamp: Date.now() });

    it("keeps each window's messages on a session both have open", async () => {
      const local = window();
      const ssh = window();
      await local.createSession(FILE, 'Review');
      await ssh.refresh(FILE);
      await ssh.loadSession('test-session-123');

      local.addMessageToSession('test-session-123', message('first'));
      await local.idle();
      // The SSH window's copy has not seen "first": its message is added, not written over it.
      ssh.addMessageToSession('test-session-123', message('second'));
      await ssh.idle();
      local.addMessageToSession('test-session-123', message('third'));
      await local.idle();

      expect(await said()).toEqual(['first', 'second', 'third']);
      await ssh.loadSession('test-session-123');
      expect(ssh.getSessionMessages('test-session-123').map((m) => m.content)).toEqual(['first', 'second', 'third']);
    });

    it('keeps listed a session made while the list was being read', async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      class SlowList extends FileSessionStore {
        override async list(workflowFile: string) {
          const listed = await super.list(workflowFile);
          await gate;
          return listed;
        }
      }
      const manager = window(new SlowList(root()));
      const refreshing = manager.refresh(FILE);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await manager.createSession(FILE, 'Made meanwhile');
      open();
      await refreshing;
      expect(manager.getSessionsForWorkflow(FILE).map((s) => s.name)).toEqual(['Made meanwhile']);
    });

    it('keeps a session it could not store, says so, and stores it whole with the next change', async () => {
      let failing = true;
      class Failing extends FileSessionStore {
        override create(session: SessionData) {
          return failing ? Promise.reject(new Error('EACCES: permission denied')) : super.create(session);
        }
      }
      const onError = vi.fn();
      const manager = window(new Failing(root()), undefined, onError);
      await manager.createSession(FILE, 'Unsaved');
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EACCES: permission denied' }));
      await manager.refresh(FILE);
      expect(manager.getSessionsForWorkflow(FILE)).toHaveLength(1);

      failing = false;
      manager.addMessageToSession('test-session-123', message('kept at last'));
      await manager.idle();
      expect(await said()).toEqual(['kept at last']);
    });

    it('keeps a message it could not store through a read, and stores it with the next', async () => {
      let failing = false;
      class Failing extends FileSessionStore {
        override append(...args: Parameters<FileSessionStore['append']>) {
          return failing ? Promise.reject(new Error('ENOSPC')) : super.append(...args);
        }
      }
      const onError = vi.fn();
      const manager = window(new Failing(root()), undefined, onError);
      await manager.createSession(FILE, 'Review');
      failing = true;
      manager.addMessageToSession('test-session-123', message('one'));
      await manager.idle();
      expect(onError).toHaveBeenCalled();
      await manager.refresh(FILE);
      await manager.loadSession('test-session-123');
      expect(manager.getSessionMessages('test-session-123').map((m) => m.content)).toEqual(['one']);

      failing = false;
      manager.addMessageToSession('test-session-123', message('two'));
      await manager.idle();
      expect(await said()).toEqual(['one', 'two']);
    });

    it('does not bring back a session another window deleted, and says it is gone', async () => {
      const local = window();
      const ssh = window();
      await local.createSession(FILE, 'Review');
      await ssh.refresh(FILE);
      await ssh.deleteSession('test-session-123');

      expect(await local.isGone('test-session-123')).toBe(true);
      expect(local.getSession('test-session-123')).toBeNull();
      expect(local.getCurrentSessionId()).toBeNull();

      const desk = window();
      await desk.refresh(FILE);
      expect(desk.getSessionsForWorkflow(FILE)).toHaveLength(0);
    });

    it('does not bring back a deleted session it writes to', async () => {
      const local = window();
      const ssh = window();
      await local.createSession(FILE, 'Review');
      await ssh.refresh(FILE);
      await ssh.deleteSession('test-session-123');
      local.addMessageToSession('test-session-123', message('late'));
      await local.idle();
      expect(await said()).toBeUndefined();
      expect(local.getSession('test-session-123')).toBeNull();
    });

    it('takes a session whose file cannot be read as there, not deleted', async () => {
      const onError = vi.fn();
      const local = window(undefined, undefined, onError);
      await local.createSession(FILE, 'Review');
      const [dir] = await fs.readdir(root());
      const [name] = await fs.readdir(path.join(root(), dir));
      await fs.writeFile(path.join(root(), dir, name), 'damaged\n');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await local.refresh(FILE);
      } finally {
        warn.mockRestore();
      }
      expect(local.getSessionsForWorkflow(FILE)).toHaveLength(1);
      expect(await local.isGone('test-session-123')).toBe(false);
      expect(await local.loadSession('test-session-123')).not.toBeNull();
      // Said as a read that failed, not as chats that cannot be saved.
      expect(onError).toHaveBeenCalledWith(expect.anything(), 'read');
    });

    it('keeps a session whose file could not be removed, and says so', async () => {
      class NoRemove extends FileSessionStore {
        override remove() {
          return Promise.reject(new Error('EPERM'));
        }
      }
      const onError = vi.fn();
      const manager = window(new NoRemove(root()), undefined, onError);
      await manager.createSession(FILE, 'Review');
      mockACPClient.deleteSession.mockClear();
      expect(await manager.deleteSession('test-session-123')).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EPERM' }));
      // The agent's session stays with it, so the chat goes on whole.
      expect(mockACPClient.deleteSession).not.toHaveBeenCalled();
      await manager.refresh(FILE);
      expect(manager.getSessionsForWorkflow(FILE)).toHaveLength(1);
    });

    it('keeps a rename made before a create that found the session there', async () => {
      let failures = 1;
      class FailsAfterWriting extends FileSessionStore {
        override async create(session: SessionData) {
          const made = await super.create(session);
          if (failures-- > 0) throw new Error('EIO');
          return made;
        }
      }
      const manager = window(new FailsAfterWriting(root()), undefined, vi.fn());
      await manager.createSession(FILE, 'Review');
      await manager.renameSession('test-session-123', 'Design');
      await manager.updateSessionMode('plan');
      await manager.idle();
      expect(await new FileSessionStore(root()).read(FILE, 'test-session-123')).toMatchObject({ name: 'Design', mode: 'plan' });
    });

    it('shows two windows\' messages in the order they were made', async () => {
      const local = window();
      const ssh = window();
      await local.createSession(FILE, 'Review');
      await ssh.refresh(FILE);
      await ssh.loadSession('test-session-123');
      ssh.addMessageToSession('test-session-123', { role: 'user', content: 'later', timestamp: 20 });
      await ssh.idle();
      // Made first, kept second: the read puts it first all the same.
      local.addMessageToSession('test-session-123', { role: 'user', content: 'earlier', timestamp: 10 });
      await local.refresh(FILE);
      expect(local.getSessionMessages('test-session-123').map((m) => m.content)).toEqual(['earlier', 'later']);
      await local.idle();
      await local.loadSession('test-session-123');
      expect(local.getSessionMessages('test-session-123').map((m) => m.content)).toEqual(['earlier', 'later']);
    });

    it("names a new session past the ones another window made", async () => {
      const desk = window();
      await desk.createSession(FILE);
      mockACPClient.createSession.mockResolvedValueOnce('ses-laptop');
      const laptop = window();
      const made = await laptop.createSession(FILE);
      expect(made.name).toBe('Session 2');
    });

    it('shows old chats it could not move, and moves them on the next list', async () => {
      const kept = (id: string) => ({ id, name: id, workflowFile: FILE, createdAt: 1, updatedAt: 1, mode: 'build', messages: [] });
      storageData.set('dialogram.sessions', [kept('old-1'), kept('old-2')]);
      let failures = 1;
      class FailsOnce extends FileSessionStore {
        override create(session: SessionData) {
          return failures-- > 0 ? Promise.reject(new Error('ENOSPC')) : super.create(session);
        }
      }
      const onError = vi.fn();
      const manager = window(new FailsOnce(root()), mockStorage, onError);
      await manager.initialize();
      expect(manager.getSessionsForWorkflow(FILE).map((s) => s.id).sort()).toEqual(['old-1', 'old-2']);
      expect(onError).toHaveBeenCalledTimes(1);
      // The one moved is no longer there; the one not moved waits for the next try.
      expect(storageData.get('dialogram.sessions')).toHaveLength(1);

      await manager.refresh(FILE);
      expect(storageData.get('dialogram.sessions')).toBeUndefined();
      expect((await new FileSessionStore(root()).list(FILE)).map((s) => s.id).sort()).toEqual(['old-1', 'old-2']);
      expect(manager.getSessionsForWorkflow(FILE)).toHaveLength(2);
    });

    it('does not move again an old chat it moved and was then deleted, while another fails', async () => {
      const kept = (id: string) => ({ id, name: id, workflowFile: FILE, createdAt: 1, updatedAt: 1, mode: 'build', messages: [] });
      storageData.set('dialogram.sessions', [kept('old-1'), kept('old-2')]);
      class OldTwoFails extends FileSessionStore {
        override create(session: SessionData) {
          return session.id === 'old-2' ? Promise.reject(new Error('ENOSPC')) : super.create(session);
        }
      }
      const manager = window(new OldTwoFails(root()), mockStorage, vi.fn());
      await manager.initialize();
      // Only the one not moved is left there.
      expect(storageData.get('dialogram.sessions').map((s: SessionData) => s.id)).toEqual(['old-2']);
      expect(await manager.deleteSession('old-1')).toBe(true);

      await manager.refresh(FILE);
      expect(manager.getSessionsForWorkflow(FILE).map((s) => s.id)).toEqual(['old-2']);
      expect(await new FileSessionStore(root()).has(FILE, 'old-1')).toBe(false);
    });

    it('does not bring back a session deleted here while a list was being read', async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let slow = false;
      class SlowList extends FileSessionStore {
        override async list(workflowFile: string) {
          const listed = await super.list(workflowFile);
          if (slow) await gate;
          return listed;
        }
      }
      const manager = window(new SlowList(root()));
      await manager.createSession(FILE, 'Review');
      slow = true;
      const refreshing = manager.refresh(FILE);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await manager.deleteSession('test-session-123')).toBe(true);
      open();
      await refreshing;
      expect(manager.getSessionsForWorkflow(FILE)).toHaveLength(0);
      expect(await manager.isGone('test-session-123')).toBe(true);
    });

    it('removes the file of a session it has not read, from the file the panel shows', async () => {
      await window().createSession(FILE, 'Review');
      const fresh = window();
      expect(await fresh.deleteSession('test-session-123', FILE)).toBe(true);
      expect(await new FileSessionStore(root()).has(FILE, 'test-session-123')).toBe(false);
    });

    it('keeps a session whose file is there but holds none yet, and says it cannot be read', async () => {
      const onError = vi.fn();
      const manager = window(undefined, undefined, onError);
      await manager.createSession(FILE, 'Review');
      const [dir] = await fs.readdir(root());
      const [name] = (await fs.readdir(path.join(root(), dir))).filter((n) => n.endsWith('.jsonl'));
      await fs.writeFile(path.join(root(), dir, name), '');
      expect(await manager.loadSession('test-session-123')).not.toBeNull();
      expect(onError).toHaveBeenCalledWith(expect.anything(), 'read');
      expect(await manager.isGone('test-session-123')).toBe(false);
      expect(manager.getSession('test-session-123')).not.toBeNull();
    });

    it('does not say a session it never had is gone', async () => {
      const manager = window();
      expect(await manager.isGone('ses_not_read_yet')).toBe(false);
    });

    it('goes on keeping a session after a change failed in a way nothing caught', async () => {
      let failures = 1;
      class Failing extends FileSessionStore {
        override append(...args: Parameters<FileSessionStore['append']>) {
          return failures-- > 0 ? Promise.reject(new Error('EIO')) : super.append(...args);
        }
      }
      // A report that throws: the failure leaves the change's own catch.
      const manager = window(new Failing(root()), undefined, () => { throw new Error('report failed'); });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await manager.createSession(FILE, 'Review');
        manager.addMessageToSession('test-session-123', message('one'));
        await manager.idle();
        manager.addMessageToSession('test-session-123', message('two'));
        await manager.idle();
      } finally {
        error.mockRestore();
      }
      expect(await said()).toEqual(['one', 'two']);
    });

    it("gives a turn's parts times in the order made, so a read keeps it whatever order the lines landed in", async () => {
      const manager = window();
      await manager.createSession(FILE, 'Review');
      const now = 5_000;
      manager.addMessageToSession('test-session-123', { role: 'assistant', content: 'before the tool', timestamp: now });
      manager.addMessageToSession('test-session-123', { role: 'tool', content: '', timestamp: now });
      manager.addMessageToSession('test-session-123', { role: 'assistant', content: 'after the tool', timestamp: now });
      await manager.idle();
      const kept = (await new FileSessionStore(root()).read(FILE, 'test-session-123'))!.messages;
      expect(kept.map((m) => m.timestamp)).toEqual([5_000, 5_001, 5_002]);

      // Lines landed out of order (written by hand here): the read puts them back.
      const [dir] = await fs.readdir(root());
      const [name] = (await fs.readdir(path.join(root(), dir))).filter((n) => n.endsWith('.jsonl'));
      const file = path.join(root(), dir, name);
      const [head, ...lines] = (await fs.readFile(file, 'utf8')).trim().split('\n');
      await fs.writeFile(file, [head, lines[0], lines[2], lines[1]].join('\n') + '\n');
      expect((await new FileSessionStore(root()).read(FILE, 'test-session-123'))?.messages.map((m) => m.role + ':' + m.content))
        .toEqual(['assistant:before the tool', 'tool:', 'assistant:after the tool']);
    });

    it('lists again after clearing workspaceState failed', async () => {
      storageData.set('dialogram.sessions', [{ id: 'old-1', name: 'old', workflowFile: FILE, createdAt: 1, updatedAt: 1, mode: 'build', messages: [] }]);
      let failures = 1;
      const legacy: WorkspaceStorage = {
        get: mockStorage.get,
        update: async (key: string, value: any) => {
          if (failures-- > 0) throw new Error('state not writable');
          storageData.set(key, value);
        },
      };
      const onError = vi.fn();
      const manager = window(undefined, legacy, onError);
      await manager.initialize();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'state not writable' }));
      await manager.refresh(FILE);
      expect(storageData.get('dialogram.sessions')).toBeUndefined();
      expect(manager.getSessionsForWorkflow(FILE).map((s) => s.id)).toEqual(['old-1']);
    });
  });
});
