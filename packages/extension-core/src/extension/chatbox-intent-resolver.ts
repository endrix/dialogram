import { injectable } from 'inversify';
import type { ACPClientService } from './acp-client.js';
import type { SessionManager } from './session-manager.js';
import type { DiagramChatConfig } from '../api.js';

/** Default node-creation commands when the chat config supplies none. */
const DEFAULT_NODE_COMMANDS: Array<{ command: string; nodeType: string; description: string }> = [
  { command: 'create-task', nodeType: 'task', description: 'Create a new task node' },
  { command: 'create-agent', nodeType: 'agent', description: 'Create a new agent node' },
  { command: 'create-viewer', nodeType: 'viewer', description: 'Create a new viewer node' },
  { command: 'create-workflow', nodeType: 'workflow', description: 'Create a new workflow node' },
];

export interface Intent {
  command: string;
  args: Record<string, any>;
  mode?: 'plan' | 'build';
  handler?: (args: Record<string, any>) => Promise<void>;
}

export interface IntentHandler {
  modes: ('plan' | 'build')[];
  handler: (args: Record<string, any>) => Promise<void>;
  prompt?: (args: Record<string, any>) => string;
  description: string;
  /** Short argument hint shown in the '/' menu, e.g. "<name>". */
  usage?: string;
}

export interface OperationDispatcher {
  dispatch(operation: string, params: Record<string, any>): Promise<any>;
}

export interface DiagramContextService {
  getSelectedNodes(): any[];
  getCurrentWorkflowFile(): string;
}

/**
 * Chat Box Intent Resolver
 * Provides mode-aware command handling and tight integration with the
 * chat box UI
 */
@injectable()
export class ChatBoxIntentResolver {
  private intents: Map<string, IntentHandler> = new Map();

  constructor(
    private acpClient: ACPClientService,
    private sessionManager: SessionManager,
    private operationDispatcher: OperationDispatcher,
    private diagramContext: DiagramContextService,
    private chatConfig?: DiagramChatConfig
  ) {
    this.registerBuiltinIntents();
  }

  /** Internal op-dispatcher namespace for this runtime, supplied by the chat config. */
  private get opPrefix(): string {
    return this.chatConfig?.operationPrefix ?? '';
  }

  /**
   * Register built-in intents
   */
  private registerBuiltinIntents(): void {
    // Create operations (build mode only) — profile-specific terminology
    // (runtime-specific entity vocabulary).
    for (const nc of this.chatConfig?.nodeCommands ?? DEFAULT_NODE_COMMANDS) {
      this.register(nc.command, {
        modes: ['build'],
        handler: async (args) => this.dispatchCreateNode(nc.nodeType, args),
        prompt: (args) => `Create a new ${nc.nodeType} named "${args.name}"`,
        description: nc.description,
        usage: '<name>',
      });
    }

    // Connect operations (build mode only)
    this.register('connect', {
      modes: ['build'],
      handler: async (args) => this.dispatchConnect(args),
      prompt: (args) => `Connect ${args.source} to ${args.target}`,
      description: 'Connect two nodes',
      usage: '<source> <target>',
    });

    this.register('auto-connect', {
      modes: ['build'],
      handler: async () => this.dispatchAutoConnect(),
      prompt: () => 'Auto-connect compatible ports',
      description: 'Automatically connect compatible ports',
    });

    // Delete operations (build mode only)
    this.register('delete', {
      modes: ['build'],
      handler: async (args) => this.dispatchDelete(args),
      prompt: (args) => `Delete node ${args.name}`,
      description: 'Delete a node',
      usage: '<name>',
    });

    this.register('delete-selected', {
      modes: ['build'],
      handler: async () => this.dispatchDeleteSelected(),
      prompt: () => 'Delete selected nodes',
      description: 'Delete all selected nodes',
    });

    // Update operations (build mode only)
    this.register('update', {
      modes: ['build'],
      handler: async (args) => this.dispatchUpdate(args),
      prompt: (args) => `Update ${args.name} parameters`,
      description: 'Update node parameters',
      usage: '<name> key=value …',
    });

    this.register('rename', {
      modes: ['build'],
      handler: async (args) => this.dispatchRename(args),
      prompt: (args) => `Rename ${args.oldName} to ${args.newName}`,
      description: 'Rename a node',
      usage: '<oldName> <newName>',
    });

    // Layout operations (both modes, but only executes in build)
    this.register('layout', {
      modes: ['plan', 'build'],
      handler: async (args) => this.dispatchLayout(args),
      prompt: () => 'Apply auto-layout to the workflow',
      description: 'Apply automatic layout',
    });

    this.register('align', {
      modes: ['build'],
      handler: async (args) => this.dispatchAlign(args),
      prompt: (args) => `Align selected nodes ${args.direction}`,
      description: 'Align selected nodes',
    });

    this.register('distribute', {
      modes: ['build'],
      handler: async (args) => this.dispatchDistribute(args),
      prompt: (args) => `Distribute selected nodes ${args.direction}`,
      description: 'Distribute selected nodes evenly',
    });

    // Analysis operations (both modes)
    this.register('analyze', {
      modes: ['plan', 'build'],
      handler: async () => this.analyzeGraph(),
      prompt: () => 'Analyze the current workflow graph',
      description: 'Analyze workflow for issues',
    });

    this.register('validate', {
      modes: ['plan', 'build'],
      handler: async () => this.validateWorkflow(),
      prompt: () => 'Validate the workflow',
      description: 'Validate workflow and check for errors',
    });

    this.register('list-types', {
      modes: ['plan', 'build'],
      handler: async () => this.listTaskTypes(),
      prompt: () => 'List available task types',
      description: 'List available task and agent types',
    });

    this.register('list-nodes', {
      modes: ['plan', 'build'],
      handler: async () => this.listNodes(),
      prompt: () => 'List all nodes in the workflow',
      description: 'List all nodes in the current workflow',
    });

    // Execution operations (build mode only)
    this.register('run', {
      modes: ['build'],
      handler: async () => this.runWorkflow(),
      prompt: () => 'Execute the current workflow',
      description: 'Run the workflow',
    });

    this.register('export', {
      modes: ['plan', 'build'],
      handler: async () => this.exportWorkflow(),
      prompt: () => 'Export workflow as JSON',
      description: 'Export workflow graph as JSON',
    });

    // Utility operations (build mode only)
    this.register('fix', {
      modes: ['build'],
      handler: async () => this.fixIssues(),
      prompt: () => 'Fix workflow issues',
      description: 'Identify and fix workflow issues',
    });

    this.register('optimize', {
      modes: ['plan', 'build'],
      handler: async () => this.optimizeWorkflow(),
      prompt: () => 'Suggest workflow optimizations',
      description: 'Suggest optimizations for the workflow',
    });

    this.register('docs', {
      modes: ['plan', 'build'],
      handler: async () => this.generateDocs(),
      prompt: () => 'Generate workflow documentation',
      description: 'Generate documentation for the workflow',
    });

    // Help command
    this.register('help', {
      modes: ['plan', 'build'],
      handler: async () => this.showHelp(),
      prompt: () => 'Show available commands',
      description: 'Show help information',
    });
  }

  /**
   * Register a new intent
   */
  register(name: string, handler: IntentHandler): void {
    this.intents.set(name, handler);
  }

  /**
   * Resolve user input to an intent
   */
  async resolve(userInput: string, currentMode: 'plan' | 'build'): Promise<Intent> {
    // Check for slash commands first
    if (userInput.startsWith('/')) {
      const parsed = this.parseSlashCommand(userInput);
      if (parsed) {
        const intent = this.intents.get(parsed.command);
        if (!intent) {
          throw new Error(`Unknown command: ${parsed.command}. Type /help for available commands.`);
        }

        // Check mode restrictions
        if (!intent.modes.includes(currentMode)) {
          throw new Error(
            `Command '${parsed.command}' requires ${intent.modes.join(' or ')} mode. ` +
            `Switch to ${intent.modes[0]} mode to use this command.`
          );
        }

        return {
          command: parsed.command,
          args: parsed.args,
          mode: currentMode,
          handler: intent.handler,
        };
      }
    }

    // For natural language, send to ACP agent with mode context
    return {
      command: 'natural-language',
      args: { text: userInput, mode: currentMode },
      mode: currentMode,
      handler: async (args) => {
        const sessionId = this.sessionManager.getCurrentSessionId();
        if (!sessionId) {
          throw new Error('No active session. Please create or select a session first.');
        }
        await this.acpClient.sendPrompt(sessionId, args.text);
      },
    };
  }

  /**
   * Get all available intents for a mode
   */
  getIntentsForMode(mode: 'plan' | 'build'): Map<string, IntentHandler> {
    const filtered = new Map<string, IntentHandler>();

    for (const [name, handler] of this.intents.entries()) {
      if (handler.modes.includes(mode)) {
        filtered.set(name, handler);
      }
    }

    return filtered;
  }

  /**
   * Get intent description
   */
  getIntentDescription(command: string): string | undefined {
    return this.intents.get(command)?.description;
  }

  /**
   * Parse slash command
   */
  private parseSlashCommand(input: string): { command: string; args: Record<string, any> } | null {
    const match = input.match(/^\/([\w-]+)(?:\s+(.+))?$/);
    if (!match) return null;

    const [, command, argsString] = match;
    const args = argsString ? this.parseArgs(argsString) : {};

    return { command, args };
  }

  /**
   * Parse arguments from string
   */
  private parseArgs(argsString: string): Record<string, any> {
    const args: Record<string, any> = {};
    const parts = argsString.split(/\s+/);

    parts.forEach((part) => {
      const [key, value] = part.split('=');
      if (key && value) {
        // Remove quotes from value
        args[key] = value.replace(/^["']|["']$/g, '');
      } else if (key) {
        // Positional argument
        args['_positional'] = args['_positional'] || [];
        args['_positional'].push(key);
      }
    });

    return args;
  }

  /**
   * Dispatch an operation and throw if it failed, so the error surfaces in chat
   * (stub operations return success and never throw).
   */
  private async dispatchOrThrow(operation: string, params: Record<string, any>): Promise<void> {
    const result = await this.operationDispatcher.dispatch(operation, params);
    if (result && result.success === false) {
      throw new Error(result.error ?? `Operation ${operation} failed`);
    }
  }

  /**
   * Dispatch create node operation
   */
  private async dispatchCreateNode(nodeType: string, args: Record<string, any>): Promise<void> {
    const name = args.name || args._positional?.[0];
    if (!name) {
      throw new Error(`Please provide a name for the ${nodeType}. Usage: /create-${nodeType} <name>`);
    }

    await this.dispatchOrThrow(`${this.opPrefix}.createNode`, {
      node_type: nodeType,
      name,
      ...args,
    });
  }

  /**
   * Dispatch connect operation
   */
  private async dispatchConnect(args: Record<string, any>): Promise<void> {
    const source = args.source || args._positional?.[0];
    const target = args.target || args._positional?.[1];

    if (!source || !target) {
      throw new Error('Please provide source and target nodes. Usage: /connect <source> <target>');
    }

    await this.dispatchOrThrow(`${this.opPrefix}.connect`, {
      source,
      target,
      ...args,
    });
  }

  /**
   * Dispatch auto-connect operation
   */
  private async dispatchAutoConnect(): Promise<void> {
    await this.dispatchOrThrow(`${this.opPrefix}.autoConnect`, {});
  }

  /**
   * Dispatch delete operation
   */
  private async dispatchDelete(args: Record<string, any>): Promise<void> {
    const name = args.name || args._positional?.[0];
    if (!name) {
      throw new Error('Please provide a node name to delete. Usage: /delete <name>');
    }

    await this.dispatchOrThrow(`${this.opPrefix}.deleteNode`, {
      name,
    });
  }

  /**
   * Dispatch delete selected operation
   */
  private async dispatchDeleteSelected(): Promise<void> {
    const selected = this.diagramContext.getSelectedNodes();
    if (selected.length === 0) {
      throw new Error('No nodes selected. Please select nodes to delete.');
    }

    for (const node of selected) {
      await this.dispatchOrThrow(`${this.opPrefix}.deleteNode`, {
        nodeId: node.id,
      });
    }
  }

  /**
   * Dispatch update operation
   */
  private async dispatchUpdate(args: Record<string, any>): Promise<void> {
    const name = args.name || args._positional?.[0];
    if (!name) {
      throw new Error('Please provide a node name to update. Usage: /update <name> param=value');
    }

    const params = { ...args };
    delete params.name;
    delete params._positional;

    await this.dispatchOrThrow(`${this.opPrefix}.updateNodeParameter`, {
      name,
      ...params,
    });
  }

  /**
   * Dispatch rename operation
   */
  private async dispatchRename(args: Record<string, any>): Promise<void> {
    const oldName = args.oldName || args._positional?.[0];
    const newName = args.newName || args._positional?.[1];

    if (!oldName || !newName) {
      throw new Error('Please provide old and new names. Usage: /rename <oldName> <newName>');
    }

    await this.dispatchOrThrow(`${this.opPrefix}.renameNode`, {
      oldName,
      newName,
    });
  }

  /**
   * Dispatch layout operation
   */
  private async dispatchLayout(_args: Record<string, any>): Promise<void> {
    await this.dispatchOrThrow('layout', {});
  }

  /**
   * Dispatch align operation
   */
  private async dispatchAlign(args: Record<string, any>): Promise<void> {
    const direction = args.direction || args._positional?.[0] || 'horizontal';

    await this.dispatchOrThrow('align', {
      direction,
      nodeIds: this.diagramContext.getSelectedNodes().map((n) => n.id),
    });
  }

  /**
   * Dispatch distribute operation
   */
  private async dispatchDistribute(args: Record<string, any>): Promise<void> {
    const direction = args.direction || args._positional?.[0] || 'horizontal';

    await this.dispatchOrThrow('distribute', {
      direction,
      nodeIds: this.diagramContext.getSelectedNodes().map((n) => n.id),
    });
  }

  /**
   * Analyze workflow graph
   */
  private async analyzeGraph(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Analyze the current workflow graph for potential issues, bottlenecks, or optimization opportunities.'
    );
  }

  /**
   * Validate workflow
   */
  private async validateWorkflow(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Validate the workflow and check for errors, missing connections, or configuration issues.'
    );
  }

  /**
   * List task types
   */
  private async listTaskTypes(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'List all available task types and agent profiles.'
    );
  }

  /**
   * List nodes
   */
  private async listNodes(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'List all nodes in the current workflow with their types and configurations.'
    );
  }

  /**
   * Run workflow
   */
  private async runWorkflow(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Execute the current workflow and report the results.'
    );
  }

  /**
   * Export workflow
   */
  private async exportWorkflow(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Export the workflow graph as JSON with full type information and metadata.'
    );
  }

  /**
   * Fix issues
   */
  private async fixIssues(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Identify and automatically fix any issues in the workflow.'
    );
  }

  /**
   * Optimize workflow
   */
  private async optimizeWorkflow(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Suggest optimizations for the workflow (parallelization, caching, resource usage, etc.).'
    );
  }

  /**
   * Generate documentation
   */
  private async generateDocs(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    await this.acpClient.sendPrompt(
      sessionId,
      'Generate comprehensive documentation for this workflow, including all tasks, agents, and their configurations.'
    );
  }

  /**
   * Show help
   */
  private async showHelp(): Promise<void> {
    const sessionId = this.sessionManager.getCurrentSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    const currentMode = this.acpClient.getSessionMode(sessionId);
    const intents = this.getIntentsForMode(currentMode);

    let helpText = `# Available Commands (${currentMode} mode)\n\n`;

    for (const [name, handler] of intents.entries()) {
      helpText += `**/${name}** - ${handler.description}\n`;
    }

    helpText += '\n\nType `/` followed by a command name to execute it.';

    // Add help message to chat
    this.sessionManager.addMessage({
      role: 'system',
      content: helpText,
      timestamp: Date.now(),
    });
  }
}
