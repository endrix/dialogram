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
      await client.start('/test/workspace');

      // The command may resolve to a full path (e.g. ~/.opencode/bin/opencode)
      // and the env is PATH-augmented, so assert loosely.
      // `opencode acp` is spawned with a pinned HTTP --port (for revert/unrevert).
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
          message: 'OpenCode process exited with code 1',
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
