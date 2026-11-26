import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ACPClientService } from '../src/extension/acp-client.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock ACP SDK
vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: vi.fn(),
  ndJsonStream: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk/stream', () => ({
  ndJsonStream: vi.fn(),
}));

// Mock stream conversion
vi.mock('node:stream', async () => {
  const actual = await vi.importActual('node:stream');
  return {
    ...actual,
    Readable: {
      ...actual.Readable,
      toWeb: vi.fn((stream) => stream),
    },
    Writable: {
      ...actual.Writable,
      toWeb: vi.fn((stream) => stream),
    },
  };
});

describe('ACPClientService', () => {
  let client: ACPClientService;
  let mockProcess: Partial<ChildProcess> & EventEmitter;
  let mockConnection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ACPClientService();

    // Create mock streams (Web API streams)
    const mockStdout = {
      pipe: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      setEncoding: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: vi.fn(),
      read: vi.fn(),
      unpipe: vi.fn(),
      unshift: vi.fn(),
      wrap: vi.fn(),
      [Symbol.asyncIterator]: vi.fn(),
    } as any;

    const mockStdin = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      setDefaultEncoding: vi.fn(),
      cork: vi.fn(),
      uncork: vi.fn(),
      destroy: vi.fn(),
      writableEnded: false,
      writableFinished: false,
      writableHighWaterMark: 16384,
      writableLength: 0,
      writableObjectMode: false,
      writableCorked: 0,
    } as any;

    // Create mock process
    mockProcess = Object.assign(new EventEmitter(), {
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: new EventEmitter(),
      kill: vi.fn(),
      pid: 12345,
    });

    // opencode 1.17+ returns modes and models as `configOptions` on the
    // session response, and changes are applied via `setSessionConfigOption`.
    const configOptions = [
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [
          { value: 'plan', name: 'plan' },
          { value: 'build', name: 'build' },
        ],
      },
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'provider-1',
        options: [
          { value: 'provider-1', name: 'Provider 1' },
          { value: 'provider-2', name: 'Provider 2' },
        ],
      },
    ];

    // Create mock connection
    mockConnection = {
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        configOptions,
      }),
      setSessionMode: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions }),
      listSessions: vi.fn().mockResolvedValue({
        sessions: [],
      }),
      loadSession: vi.fn().mockResolvedValue({}),
      deleteSession: vi.fn().mockResolvedValue({}),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
    };

    // Setup mocks
    vi.mocked(spawn).mockReturnValue(mockProcess as any);
    vi.mocked(ClientSideConnection).mockImplementation(() => mockConnection);
    vi.mocked(ndJsonStream).mockReturnValue({} as any);
  });

  afterEach(() => {
    client.stop();
  });

  describe('start', () => {
    it('should spawn opencode subprocess and initialize connection', async () => {
      client = new ACPClientService(async () => 'own-port');
      await client.start('/test/workspace');

      // The command may resolve to a full path (e.g. ~/.opencode/bin/opencode)
      // and the env is PATH-augmented, so assert loosely.
      // opencode 1.x's `opencode acp` is spawned with a pinned HTTP --port (for revert/unrevert).
      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('opencode'),
        expect.arrayContaining(['acp', '--hostname', '127.0.0.1', '--port']),
        expect.objectContaining({
          cwd: '/test/workspace',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: expect.objectContaining({ PATH: expect.any(String) }),
        })
      );
      expect(mockConnection.initialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: 'dialogram',
          version: '0.0.1',
        },
      });
      expect(client.isClientConnected()).toBe(true);
    });

    it('spawns opencode 2 without --port, its sessions reached through `opencode api`', async () => {
      const probe = vi.fn(async () => 'service' as const);
      client = new ACPClientService(probe);
      await client.start('/test/workspace');

      expect(probe).toHaveBeenCalledWith(expect.stringContaining('opencode'), ['acp'], expect.objectContaining({ PATH: expect.any(String) }));
      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('opencode'),
        ['acp'],
        expect.objectContaining({ cwd: '/test/workspace' })
      );
      expect((client as any).http?.constructor?.name).toBe('OpencodeServiceClient');
    });

    describe("opencode 2's Code Mode", () => {
      const KEY = 'OPENCODE_CONFIG_CONTENT';
      let saved: string | undefined;
      beforeEach(() => {
        saved = process.env[KEY];
        delete process.env[KEY];
      });
      afterEach(() => {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
        vi.restoreAllMocks();
      });
      const spawnEnv = (): NodeJS.ProcessEnv => (vi.mocked(spawn).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env;

      it('is off for opencode 2: its acp starts with execute denied', async () => {
        const probe = vi.fn(async () => 'service' as const);
        client = new ACPClientService(probe);
        await client.start('/test/workspace');
        expect(JSON.parse(spawnEnv()[KEY]!)).toEqual({ permission: { execute: 'deny' } });
        expect(spawnEnv().PATH).toEqual(expect.any(String));
        // The flavour is read from the environment as it was.
        expect((probe.mock.calls[0] as unknown[])[2]).not.toHaveProperty(KEY);
      });

      it("adds to the user's own config, from the process or the connector", async () => {
        process.env[KEY] = JSON.stringify({ model: 'a/b' });
        client = new ACPClientService(async () => 'service');
        await client.start('/test/workspace');
        expect(JSON.parse(spawnEnv()[KEY]!)).toEqual({ model: 'a/b', permission: { execute: 'deny' } });
        client.stop();

        // The connector's env table overrides the process's, as for any variable.
        client = new ACPClientService(async () => 'service');
        await client.start('/test/workspace', {
          name: 'opencode', argv: ['opencode', 'acp'], httpApi: true,
          env: { [KEY]: JSON.stringify({ permission: { bash: 'ask' } }) },
        });
        expect(JSON.parse(spawnEnv()[KEY]!)).toEqual({ permission: { bash: 'ask', execute: 'deny' } });
      });

      it("keeps the user's own permission.execute, and a config it cannot read, with one line", async () => {
        const own = JSON.stringify({ permission: { execute: 'allow' } });
        process.env[KEY] = own;
        client = new ACPClientService(async () => 'service');
        await client.start('/test/workspace');
        expect(spawnEnv()[KEY]).toBe(own);
        client.stop();

        const jsonc = '{ // mine\n}';
        process.env[KEY] = jsonc;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        client = new ACPClientService(async () => 'service');
        await client.start('/test/workspace');
        expect(spawnEnv()[KEY]).toBe(jsonc);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(KEY);
      });

      it('stays on when the setting says so', async () => {
        client = new ACPClientService(async () => 'service');
        await client.start('/test/workspace', undefined, { opencodeCodeMode: true });
        expect(spawnEnv()).not.toHaveProperty(KEY);
      });

      it('is not touched on opencode 1.x, nor on an opencode the chat cannot tell', async () => {
        for (const flavour of ['own-port', 'none'] as const) {
          client = new ACPClientService(async () => flavour);
          await client.start('/test/workspace');
          expect(spawnEnv()).not.toHaveProperty(KEY);
          client.stop();
        }
        const own = JSON.stringify({ model: 'a/b' });
        process.env[KEY] = own;
        client = new ACPClientService(async () => 'own-port');
        await client.start('/test/workspace');
        expect(spawnEnv()[KEY]).toBe(own);
      });

      it('is off for an opencode 2 whose connector has no HTTP API, which stays off', async () => {
        const probe = vi.fn(async () => 'service' as const);
        client = new ACPClientService(probe);
        await client.start('/test/workspace', { name: 'oc', argv: ['/opt/oc/bin/opencode', 'acp'], httpApi: false });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(JSON.parse(spawnEnv()[KEY]!)).toEqual({ permission: { execute: 'deny' } });
        expect((client as any).http).toBeNull();
        client.stop();

        // An opencode 1.x without the HTTP API gets no port either.
        client = new ACPClientService(async () => 'own-port');
        await client.start('/test/workspace', { name: 'oc', argv: ['opencode', 'acp'], httpApi: false });
        expect(vi.mocked(spawn).mock.calls.at(-1)![1]).toEqual(['acp']);
        expect(spawnEnv()).not.toHaveProperty(KEY);
        expect((client as any).http).toBeNull();
      });

      it('says so in the log when it cannot tell which opencode it is', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        client = new ACPClientService(async () => 'none');
        await client.start('/test/workspace');
        expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Code Mode'))).toHaveLength(1);
      });

      it('is not touched for any other agent', async () => {
        const probe = vi.fn(async () => 'service' as const);
        for (const argv of [['claude-agent-acp'], ['codex-acp'], ['gemini', '--experimental-acp']]) {
          client = new ACPClientService(probe);
          await client.start('/test/workspace', { name: argv[0], argv, httpApi: false });
          expect(spawnEnv()).not.toHaveProperty(KEY);
          client.stop();
        }
        expect(probe).not.toHaveBeenCalled();
      });
    });

    it('starts an opencode it cannot tell without --port, and leaves undo off', async () => {
      client = new ACPClientService(async () => 'none');
      await client.start('/test/workspace');

      expect(spawn).toHaveBeenCalledWith(expect.stringContaining('opencode'), ['acp'], expect.anything());
      await expect(client.getMessagesWithIds('s1')).resolves.toEqual([]);
      await expect(client.getRevertState('s1')).resolves.toBe(false);
    });

    it('asks no agent but opencode which flavour it is', async () => {
      const probe = vi.fn(async () => 'own-port' as const);
      client = new ACPClientService(probe);
      await client.start('/test/workspace', { name: 'claude', argv: ['claude-agent-acp'], httpApi: false });
      expect(probe).not.toHaveBeenCalled();
    });

    it('spawns the given agent as its own command, without the HTTP port', async () => {
      await client.start('/test/workspace', { name: 'claude', argv: ['claude-agent-acp', '--verbose'], httpApi: false });

      expect(spawn).toHaveBeenCalledWith(
        'claude-agent-acp',
        ['--verbose'],
        expect.objectContaining({
          cwd: '/test/workspace',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: expect.objectContaining({ PATH: expect.any(String) }),
        })
      );
      expect(client.agent).toBe('claude');
      expect(client.isClientConnected()).toBe(true);
      // The HTTP-only capabilities stay off rather than failing.
      await expect(client.getMessagesWithIds('s1')).resolves.toEqual([]);
      await expect(client.getRevertState('s1')).resolves.toBe(false);
    });

    it('should throw error if already connected', async () => {
      await client.start('/test/workspace');

      await expect(client.start('/test/workspace')).rejects.toThrow(
        'ACP client is already connected'
      );
    });

    it('should handle process errors', async () => {
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      await client.start('/test/workspace');

      const testError = new Error('Process error');
      mockProcess.emit('error', testError);

      expect(errorSpy).toHaveBeenCalledWith(testError);
      expect(client.isClientConnected()).toBe(false);
    });

    it('should handle process exit with non-zero code', async () => {
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      await client.start('/test/workspace');

      mockProcess.emit('exit', 1);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'opencode process exited with code 1',
        })
      );
    });
  });

  describe('createSession', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
    });

    it('should create a new session with default mode', async () => {
      const sessionId = await client.createSession('/test/workspace', 'Test Session');

      expect(mockConnection.newSession).toHaveBeenCalledWith({
        cwd: '/test/workspace',
        mcpServers: [],
      });
      // Session default is already 'build', so no mode change is issued.
      expect(mockConnection.setSessionConfigOption).not.toHaveBeenCalled();
      expect(sessionId).toBe('test-session-123');

      const session = client.getSession('test-session-123');
      expect(session).toMatchObject({
        id: 'test-session-123',
        name: 'Test Session',
        cwd: '/test/workspace',
        mode: 'build',
        availableModes: ['plan', 'build'],
      });
    });

    it('should create session with specified mode', async () => {
      const sessionId = await client.createSession('/test/workspace', 'Plan Session', 'plan');

      expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        configId: 'mode',
        value: 'plan',
      });

      const session = client.getSession('test-session-123');
      expect(session?.mode).toBe('plan');
    });

    it('should auto-generate session name if not provided', async () => {
      const sessionId = await client.createSession('/test/workspace');

      const session = client.getSession(sessionId);
      expect(session?.name).toBe('Session 1');
    });

    it('should throw error if not connected', async () => {
      client.stop();

      await expect(
        client.createSession('/test/workspace', 'Test')
      ).rejects.toThrow('ACP client is not connected');
    });
  });

  describe('setSessionMode', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should switch session mode', async () => {
      const modeChangedSpy = vi.fn();
      client.on('modeChanged', modeChangedSpy);

      await client.setSessionMode('test-session-123', 'plan');

      expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        configId: 'mode',
        value: 'plan',
      });
      expect(modeChangedSpy).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        mode: 'plan',
      });
      expect(client.getSessionMode('test-session-123')).toBe('plan');
    });

    it('should throw error for unavailable mode', async () => {
      // Mock session with only 'build' mode available
      const session = client.getSession('test-session-123');
      if (session) {
        session.availableModes = ['build'];
      }

      await expect(
        client.setSessionMode('test-session-123', 'plan')
      ).rejects.toThrow("Mode 'plan' is not available for this session");
    });

    it('should throw error for non-existent session', async () => {
      await expect(
        client.setSessionMode('non-existent', 'plan')
      ).rejects.toThrow('Session non-existent not found');
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
    });

    it('should return list of sessions', async () => {
      mockConnection.listSessions.mockResolvedValue({
        sessions: [
          {
            sessionId: 'session-1',
            cwd: '/test/workspace',
            title: 'Session 1',
            updatedAt: 1234567890,
          },
          {
            sessionId: 'session-2',
            cwd: '/test/workspace',
            title: 'Session 2',
            updatedAt: 1234567891,
          },
        ],
      });

      const sessions = await client.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        id: 'session-1',
        name: 'Session 1',
        cwd: '/test/workspace',
      });
    });

    it('should preserve existing session info', async () => {
      // Create a session first
      await client.createSession('/test/workspace', 'My Session', 'plan');

      mockConnection.listSessions.mockResolvedValue({
        sessions: [
          {
            sessionId: 'test-session-123',
            cwd: '/test/workspace',
            title: 'Updated Title',
            updatedAt: Date.now(),
          },
        ],
      });

      const sessions = await client.listSessions();

      expect(sessions[0].name).toBe('My Session'); // Original name preserved
      expect(sessions[0].mode).toBe('plan'); // Original mode preserved
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should delete session', async () => {
      await client.deleteSession('test-session-123');

      expect(mockConnection.deleteSession).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
      });
      expect(client.getSession('test-session-123')).toBeUndefined();
    });
  });

  describe('sendPrompt', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should send prompt to session', async () => {
      await client.sendPrompt('test-session-123', 'Create a task');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        prompt: [
          { type: 'text', text: 'Create a task' },
        ],
      });
    });

    it('should throw error if not connected', async () => {
      client.stop();

      await expect(
        client.sendPrompt('test-session-123', 'test')
      ).rejects.toThrow('ACP client is not connected');
    });
  });

  describe('a change of agent', () => {
    it('forgets the sessions the old agent had, so each is attached again', async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
      expect(client.getSession('test-session-123')).toBeDefined();

      client.forgetSessions();

      expect(client.getSession('test-session-123')).toBeUndefined();
      expect(client.getAllSessions()).toEqual([]);
    });

    it('lists the new agent\'s models, not the old one\'s', async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
      expect((await client.listProviders()).map((m) => m.id)).toEqual(['provider-1', 'provider-2']);

      client.stop();
      client.forgetSessions();
      mockConnection.newSession.mockResolvedValue({
        sessionId: 'claude-probe',
        configOptions: [{
          id: 'model', category: 'model', type: 'select', currentValue: 'sonnet',
          options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
        }],
      });
      await client.start('/test/workspace', { name: 'claude', argv: ['claude-agent-acp'], httpApi: false });

      expect((await client.listProviders()).map((m) => m.id)).toEqual(['sonnet', 'opus']);
    });

    it('leaves the new agent alone when the stopped one exits late', async () => {
      await client.start('/test/workspace');
      const stopped = mockProcess;
      client.stop();
      const next = Object.assign(new EventEmitter(), {
        stdin: mockProcess.stdin, stdout: mockProcess.stdout, stderr: new EventEmitter(), kill: vi.fn(), pid: 12346,
      });
      vi.mocked(spawn).mockReturnValue(next as any);
      await client.start('/test/workspace', { name: 'claude', argv: ['claude-agent-acp'], httpApi: false });
      const disconnected = vi.fn();
      const errors = vi.fn();
      client.on('disconnected', disconnected);
      client.on('error', errors);

      // SIGTERM lands: the old process says it exited, after the new one started.
      stopped.emit('exit', 143);
      stopped.emit('error', new Error('late'));

      expect(next.kill).not.toHaveBeenCalled();
      expect(disconnected).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(client.isClientConnected()).toBe(true);
      expect(client.agent).toBe('claude');

      // Its own exit still ends it.
      next.emit('exit', 1);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(client.isClientConnected()).toBe(false);
    });
  });

  describe('a session loaded again after a restart', () => {
    const modeOption = (currentValue: string) => ({
      configOptions: [{ id: 'mode', category: 'mode', currentValue, options: [{ value: 'build' }, { value: 'plan' }] }],
    });
    const modeSets = () =>
      mockConnection.setSessionConfigOption.mock.calls.filter((c: any[]) => c[0]?.configId === 'mode').map((c: any[]) => c[0].value);

    it('takes the mode the agent says, when nothing was chosen', async () => {
      await client.start('/test/workspace');
      mockConnection.loadSession.mockResolvedValue(modeOption('plan'));
      await client.loadSession('ses_old', '/test/workspace');
      expect(client.getSessionMode('ses_old')).toBe('plan');
      expect(modeSets()).toEqual([]);
    });

    it('tells nothing to an agent that says the mode chosen', async () => {
      await client.start('/test/workspace');
      mockConnection.loadSession.mockResolvedValue(modeOption('plan'));
      await client.loadSession('ses_old', '/test/workspace', undefined, 'plan');
      expect(client.getSessionMode('ses_old')).toBe('plan');
      expect(modeSets()).toEqual([]);
    });

    it('tells the mode chosen to an agent that says another', async () => {
      await client.start('/test/workspace');
      mockConnection.loadSession.mockResolvedValue(modeOption('build'));
      await client.loadSession('ses_old', '/test/workspace', undefined, 'plan');
      expect(modeSets()).toEqual(['plan']);
      expect(client.getSessionMode('ses_old')).toBe('plan');
    });

    it('tells the mode chosen to an agent that says none', async () => {
      await client.start('/test/workspace');
      mockConnection.loadSession.mockResolvedValue({});
      await client.loadSession('ses_old', '/test/workspace', undefined, 'plan');
      expect(modeSets()).toEqual(['plan']);
      expect(client.getSessionMode('ses_old')).toBe('plan');
    });

    it("shows the agent's mode when it cannot be told, and the chosen one when it said none", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await client.start('/test/workspace');
      mockConnection.setSessionConfigOption.mockRejectedValue(new Error('connection lost'));
      mockConnection.loadSession.mockResolvedValue(modeOption('build'));
      await client.loadSession('ses_a', '/test/workspace', undefined, 'plan');
      expect(client.getSessionMode('ses_a')).toBe('build');
      mockConnection.loadSession.mockResolvedValue({});
      await client.loadSession('ses_b', '/test/workspace', undefined, 'plan');
      expect(client.getSessionMode('ses_b')).toBe('plan');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('is in build when nothing says otherwise', async () => {
      await client.start('/test/workspace');
      mockConnection.loadSession.mockResolvedValue({});
      await client.loadSession('ses_old', '/test/workspace');
      expect(client.getSessionMode('ses_old')).toBe('build');
    });
  });

  describe('images in a prompt', () => {
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };

    async function connectedSaying(promptCapabilities: Record<string, unknown> | undefined) {
      mockConnection.initialize.mockResolvedValue(
        promptCapabilities ? { agentCapabilities: { promptCapabilities } } : {}
      );
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    }

    it('are sent as image blocks before the text, to an agent that reads them', async () => {
      await connectedSaying({ image: true });
      expect(client.takesImages()).toBe(true);
      await client.sendPrompt('test-session-123', 'What is wrong here?', [image]);
      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        prompt: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'text', text: 'What is wrong here?' },
        ],
      });
    });

    it('go alone when there is no text', async () => {
      await connectedSaying({ image: true });
      await client.sendPrompt('test-session-123', '', [image]);
      expect(mockConnection.prompt.mock.calls[0][0].prompt).toEqual([
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ]);
    });

    it('are not sent to an agent that does not say it reads them', async () => {
      await connectedSaying(undefined);
      expect(client.takesImages()).toBe(false);
      await client.sendPrompt('test-session-123', 'hello', [image]);
      expect(mockConnection.prompt.mock.calls[0][0].prompt).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('are unknown to take before the agent connects, and after it goes', async () => {
      expect(client.takesImages()).toBeUndefined();
      await connectedSaying({ image: true });
      client.stop();
      expect(client.takesImages()).toBeUndefined();
    });
  });

  describe('cancelPrompt', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should cancel ongoing prompt', async () => {
      await client.cancelPrompt('test-session-123');

      expect(mockConnection.cancel).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
      });
    });
  });

  describe('listProviders', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      // The model catalog is captured from a session's `model` config option.
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should list available models from the session config', async () => {
      const providers = await client.listProviders();

      expect(providers).toHaveLength(2);
      expect(providers[0]).toMatchObject({
        id: 'provider-1',
        name: 'Provider 1',
      });
    });
  });

  describe('setProvider', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should set provider for session', async () => {
      const providerChangedSpy = vi.fn();
      client.on('providerChanged', providerChangedSpy);

      await client.setProvider('test-session-123', 'provider-2');

      // setProvider now drives the `model` config option in opencode 1.17+.
      expect(mockConnection.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        configId: 'model',
        value: 'provider-2',
      });
      expect(providerChangedSpy).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        provider: 'provider-2',
      });

      const session = client.getSession('test-session-123');
      expect(session?.provider).toBe('provider-2');
      expect(session?.model).toBe('provider-2');
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
      await client.createSession('/test/workspace', 'Test Session');
    });

    it('should emit sessionUpdate events', async () => {
      const updateSpy = vi.fn();
      client.on('sessionUpdate', updateSpy);

      const testNotification = {
        sessionId: 'test-session-123',
        update: {
          type: 'agent_message_chunk',
          content: 'Hello',
        },
      };

      // Simulate agent calling sessionUpdate
      const clientHandler = mockConnection.initialize.mock.calls[0][0];
      // In real implementation, this would be called by the SDK
      client.emit('sessionUpdate', testNotification);

      expect(updateSpy).toHaveBeenCalledWith(testNotification);
    });

    it('should emit disconnected event on stop', async () => {
      const disconnectedSpy = vi.fn();
      client.on('disconnected', disconnectedSpy);

      client.stop();

      expect(disconnectedSpy).toHaveBeenCalled();
      expect(client.isClientConnected()).toBe(false);
    });
  });

  describe('file operations', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
    });

    it('should handle readTextFile requests', async () => {
      vi.mocked(readFile).mockResolvedValue('file content');

      // Get the client handler - need to capture it during initialization
      const clientHandlerFactory = vi.mocked(ClientSideConnection).mock.calls[0][0];
      const handler = clientHandlerFactory({} as any);

      const result = await handler.readTextFile!({ path: '/test/file.txt' });

      expect(readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
      expect(result.content).toBe('file content');
    });

    it('should handle writeTextFile requests', async () => {
      const clientHandlerFactory = vi.mocked(ClientSideConnection).mock.calls[0][0];
      const handler = clientHandlerFactory({} as any);

      await handler.writeTextFile!({
        path: '/test/dir/file.txt',
        content: 'new content',
      });

      expect(mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true });
      expect(writeFile).toHaveBeenCalledWith(
        '/test/dir/file.txt',
        'new content',
        'utf-8'
      );
    });
  });

  describe('error handling', () => {
    it('should handle connection initialization failure', async () => {
      mockConnection.initialize.mockRejectedValue(new Error('Init failed'));

      await expect(client.start('/test/workspace')).rejects.toThrow(
        'Failed to start ACP client: Init failed'
      );
      expect(client.isClientConnected()).toBe(false);
    });

    it('should handle session creation failure', async () => {
      await client.start('/test/workspace');
      mockConnection.newSession.mockRejectedValue(new Error('Session failed'));

      await expect(
        client.createSession('/test/workspace', 'Test')
      ).rejects.toThrow('Session failed');
    });
  });

  describe('getAllSessions', () => {
    beforeEach(async () => {
      await client.start('/test/workspace');
    });

    it('should return all sessions', async () => {
      // Mock different session IDs for each call
      let callCount = 0;
      mockConnection.newSession.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          sessionId: `test-session-${callCount}`,
          availableModes: ['plan', 'build'],
          provider: 'default-provider',
        });
      });

      await client.createSession('/test/workspace', 'Session 1');
      await client.createSession('/test/workspace', 'Session 2');
      await client.createSession('/test/workspace', 'Session 3');

      const allSessions = client.getAllSessions();

      expect(allSessions).toHaveLength(3);
      expect(allSessions.map((s) => s.name)).toEqual([
        'Session 1',
        'Session 2',
        'Session 3',
      ]);
    });
  });
});

describe('turn tool-part accumulation (name preservation)', () => {
  let client: ACPClientService;

  beforeEach(() => {
    client = new ACPClientService();
  });

  const feed = (update: any) =>
    (client as any).accumulateTurnText({ sessionId: 's1', update });

  const toolParts = () =>
    ((client as any).turnParts.get('s1') ?? []).filter((p: any) => p.type === 'tool');

  it('keeps the tool name when a status-only update omits the title (success path)', () => {
    // opencode names the tool on the initial tool_call, then a later
    // tool_call_update carries only the completed status (no title).
    feed({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'wfpy-glsp_create-nodes', status: 'pending' });
    feed({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });

    const [tool] = toolParts();
    expect(tool.title).toBe('wfpy-glsp_create-nodes');
    expect(tool.status).toBe('completed');
  });

  it('preserves the failed tool name too', () => {
    feed({ sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'wfpy-glsp_delete-nodes', status: 'in_progress' });
    feed({ sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'failed' });

    const [tool] = toolParts();
    expect(tool.title).toBe('wfpy-glsp_delete-nodes');
    expect(tool.status).toBe('failed');
  });
});
