import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatBoxIntentResolver } from '../src/extension/chatbox-intent-resolver.js';
import type { ACPClientService } from '../src/extension/acp-client.js';
import type { SessionManager } from '../src/extension/session-manager.js';
import type { OperationDispatcher, DiagramContextService } from '../src/extension/chatbox-intent-resolver.js';

describe('ChatBoxIntentResolver', () => {
  let intentResolver: ChatBoxIntentResolver;
  let mockACPClient: any;
  let mockSessionManager: any;
  let mockOperationDispatcher: any;
  let mockDiagramContext: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockACPClient = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      getSessionMode: vi.fn().mockReturnValue('build'),
    };

    mockSessionManager = {
      getCurrentSessionId: vi.fn().mockReturnValue('test-session-123'),
      addMessage: vi.fn(),
    };

    mockOperationDispatcher = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };

    mockDiagramContext = {
      getSelectedNodes: vi.fn().mockReturnValue([]),
      getCurrentWorkflowFile: vi.fn().mockReturnValue('/test/workflow.py'),
    };

    intentResolver = new ChatBoxIntentResolver(
      mockACPClient as any,
      mockSessionManager as any,
      mockOperationDispatcher as any,
      mockDiagramContext as any,
      { name: 'wfpy', fullName: 'WFPY', operationPrefix: 'wfpy' }
    );
  });

  describe('resolve', () => {
    it('should resolve slash command', async () => {
      const intent = await intentResolver.resolve('/create-task MyTask', 'build');

      expect(intent.command).toBe('create-task');
      expect(intent.args).toMatchObject({
        _positional: ['MyTask'],
      });
    });

    it('should resolve slash command with named args', async () => {
      const intent = await intentResolver.resolve('/create-task name=MyTask type=processor', 'build');

      expect(intent.command).toBe('create-task');
      expect(intent.args).toMatchObject({
        name: 'MyTask',
        type: 'processor',
      });
    });

    it('should throw error for unknown command', async () => {
      await expect(
        intentResolver.resolve('/unknown-command', 'build')
      ).rejects.toThrow('Unknown command: unknown-command');
    });

    it('should throw error for command in wrong mode', async () => {
      await expect(
        intentResolver.resolve('/create-task MyTask', 'plan')
      ).rejects.toThrow("Command 'create-task' requires build mode");
    });

    it('should resolve natural language to ACP prompt', async () => {
      const intent = await intentResolver.resolve('Create a task', 'build');

      expect(intent.command).toBe('natural-language');
      expect(intent.args.text).toBe('Create a task');

      await intent.handler!(intent.args);
      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        'Create a task'
      );
    });

    it('should throw error when no session for natural language', async () => {
      mockSessionManager.getCurrentSessionId.mockReturnValue(null);

      const intent = await intentResolver.resolve('Create a task', 'build');

      await expect(intent.handler!(intent.args)).rejects.toThrow('No active session');
    });
  });

  describe('create operations', () => {
    it('should create task with positional arg', async () => {
      const intent = await intentResolver.resolve('/create-task MyTask', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.createNode',
        expect.objectContaining({
          node_type: 'task',
          name: 'MyTask',
        })
      );
    });

    it('should create task with named arg', async () => {
      const intent = await intentResolver.resolve('/create-task name=MyTask', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.createNode',
        expect.objectContaining({
          node_type: 'task',
          name: 'MyTask',
        })
      );
    });

    it('should create agent', async () => {
      const intent = await intentResolver.resolve('/create-agent MyAgent', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.createNode',
        expect.objectContaining({
          node_type: 'agent',
          name: 'MyAgent',
        })
      );
    });

    it('should create viewer', async () => {
      const intent = await intentResolver.resolve('/create-viewer MyViewer', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.createNode',
        expect.objectContaining({
          node_type: 'viewer',
          name: 'MyViewer',
        })
      );
    });

    it('should throw error when name not provided', async () => {
      const intent = await intentResolver.resolve('/create-task', 'build');

      await expect(intent.handler!(intent.args)).rejects.toThrow(
        'Please provide a name for the task'
      );
    });
  });

  describe('connect operations', () => {
    it('should connect nodes', async () => {
      const intent = await intentResolver.resolve('/connect TaskA TaskB', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.connect',
        expect.objectContaining({
          source: 'TaskA',
          target: 'TaskB',
        })
      );
    });

    it('should throw error when source/target not provided', async () => {
      const intent = await intentResolver.resolve('/connect TaskA', 'build');

      await expect(intent.handler!(intent.args)).rejects.toThrow(
        'Please provide source and target nodes'
      );
    });
  });

  describe('delete operations', () => {
    it('should delete node', async () => {
      const intent = await intentResolver.resolve('/delete MyTask', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.deleteNode',
        expect.objectContaining({
          name: 'MyTask',
        })
      );
    });

    it('should delete selected nodes', async () => {
      mockDiagramContext.getSelectedNodes.mockReturnValue([
        { id: 'node-1' },
        { id: 'node-2' },
      ]);

      const intent = await intentResolver.resolve('/delete-selected', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.deleteNode',
        expect.objectContaining({
          nodeId: 'node-1',
        })
      );
    });

    it('should throw error when no nodes selected', async () => {
      const intent = await intentResolver.resolve('/delete-selected', 'build');

      await expect(intent.handler!(intent.args)).rejects.toThrow('No nodes selected');
    });
  });

  describe('update operations', () => {
    it('should update node parameters', async () => {
      const intent = await intentResolver.resolve('/update MyTask param1=value1 param2=value2', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.updateNodeParameter',
        expect.objectContaining({
          name: 'MyTask',
          param1: 'value1',
          param2: 'value2',
        })
      );
    });

    it('should rename node', async () => {
      const intent = await intentResolver.resolve('/rename OldName NewName', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'wfpy.renameNode',
        expect.objectContaining({
          oldName: 'OldName',
          newName: 'NewName',
        })
      );
    });
  });

  describe('layout operations', () => {
    it('should apply layout', async () => {
      const intent = await intentResolver.resolve('/layout', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith('layout', {});
    });

    it('should align nodes', async () => {
      mockDiagramContext.getSelectedNodes.mockReturnValue([
        { id: 'node-1' },
        { id: 'node-2' },
      ]);

      const intent = await intentResolver.resolve('/align horizontal', 'build');
      await intent.handler!(intent.args);

      expect(mockOperationDispatcher.dispatch).toHaveBeenCalledWith(
        'align',
        expect.objectContaining({
          direction: 'horizontal',
          nodeIds: ['node-1', 'node-2'],
        })
      );
    });
  });

  describe('analysis operations', () => {
    it('should analyze graph', async () => {
      const intent = await intentResolver.resolve('/analyze', 'plan');
      await intent.handler!(intent.args);

      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        expect.stringContaining('Analyze')
      );
    });

    it('should validate workflow', async () => {
      const intent = await intentResolver.resolve('/validate', 'plan');
      await intent.handler!(intent.args);

      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        expect.stringContaining('Validate')
      );
    });

    it('should list task types', async () => {
      const intent = await intentResolver.resolve('/list-types', 'plan');
      await intent.handler!(intent.args);

      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        expect.stringContaining('task types')
      );
    });
  });

  describe('execution operations', () => {
    it('should run workflow', async () => {
      const intent = await intentResolver.resolve('/run', 'build');
      await intent.handler!(intent.args);

      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        expect.stringContaining('Execute')
      );
    });

    it('should export workflow', async () => {
      const intent = await intentResolver.resolve('/export', 'build');
      await intent.handler!(intent.args);

      expect(mockACPClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-123',
        expect.stringContaining('Export')
      );
    });
  });

  describe('help command', () => {
    it('should show help', async () => {
      const intent = await intentResolver.resolve('/help', 'build');
      await intent.handler!(intent.args);

      expect(mockSessionManager.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Available Commands'),
        })
      );
    });
  });

  describe('getIntentsForMode', () => {
    it('should return intents for build mode', () => {
      const intents = intentResolver.getIntentsForMode('build');

      expect(intents.has('create-task')).toBe(true);
      expect(intents.has('create-agent')).toBe(true);
      expect(intents.has('delete')).toBe(true);
      expect(intents.has('analyze')).toBe(true); // Both modes
    });

    it('should return intents for plan mode', () => {
      const intents = intentResolver.getIntentsForMode('plan');

      expect(intents.has('create-task')).toBe(false); // Build only
      expect(intents.has('analyze')).toBe(true);
      expect(intents.has('validate')).toBe(true);
    });
  });

  describe('getIntentDescription', () => {
    it('should return intent description', () => {
      const description = intentResolver.getIntentDescription('create-task');

      expect(description).toBe('Create a new task node');
    });

    it('should return undefined for unknown intent', () => {
      const description = intentResolver.getIntentDescription('unknown');

      expect(description).toBeUndefined();
    });
  });
});
