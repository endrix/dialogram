# Chat Box Integration Guide

## Overview

This guide explains how to integrate the chat box feature into your VS Code extension.

## Components

The chat box feature consists of the following components:

1. **ACPClientService** - TypeScript ACP client for opencode communication
2. **SessionManager** - Per-workflow session persistence
3. **ChatBoxIntentResolver** - Mode-aware command routing
4. **OperationDispatcher** - Sidecar operation execution
5. **ChatPanel** - UI component for the diagram client
6. **CommandPalette** - Command search overlay

## Integration Steps

### 1. Install Dependencies

```bash
cd packages/extension-core
npm install @agentclientprotocol/sdk@0.25.0
```

### 2. Register Services in Extension Activation

In your extension's `activate()` function:

```typescript
import { ACPClientService } from './extension/acp-client.js';
import { SessionManager } from './extension/session-manager.js';
import { ChatBoxIntentResolver } from './extension/chatbox-intent-resolver.js';
import { OperationDispatcher } from './extension/operation-dispatcher.js';

export async function activate(context: vscode.ExtensionContext) {
  // Initialize ACP client
  const acpClient = new ACPClientService();

  // Initialize operation dispatcher
  const operationDispatcher = new OperationDispatcher();

  // Connect operation dispatcher to sidecar
  // (This depends on your sidecar implementation)
  operationDispatcher.register('wfpy.createNode', async (params) => {
    return await sidecar.send({
      op: 'createNode',
      params,
    });
  });

  // Initialize session manager
  const workspaceStorage = {
    get: (key, defaultValue) => context.workspaceState.get(key, defaultValue),
    update: (key, value) => context.workspaceState.update(key, value),
  };
  const sessionManager = new SessionManager(acpClient, workspaceStorage);
  await sessionManager.initialize();

  // Initialize diagram context service
  const diagramContext = {
    getSelectedNodes: () => {
      // Return selected nodes from your diagram
      return [];
    },
    getCurrentWorkflowFile: () => {
      // Return current workflow file path
      return vscode.window.activeTextEditor?.document.uri.fsPath || '';
    },
  };

  // Initialize intent resolver
  const intentResolver = new ChatBoxIntentResolver(
    acpClient,
    sessionManager,
    operationDispatcher,
    diagramContext
  );

  // Store in context for disposal
  context.subscriptions.push({
    dispose: () => acpClient.stop(),
  });

  // Register command to open chat
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.chat.open', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace open');
        return;
      }

      await acpClient.start(workspaceRoot);

      // Create or load session
      const workflowFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (workflowFile) {
        const sessions = sessionManager.getSessionsForWorkflow(workflowFile);
        if (sessions.length === 0) {
          await sessionManager.createSession(workflowFile, 'Default Session');
        } else {
          await sessionManager.loadSession(sessions[0].id);
        }
      }

      // The chat panel will be initialized in the diagram client
    })
  );
}
```

### 3. Initialize Chat Panel in Diagram Client

In your diagram client's startup code (e.g., `grid-startup.ts`):

```typescript
import { ChatPanel } from './chat-panel.js';

export function startDiagramClient(container: Container) {
  // ... existing diagram client setup ...

  // Get services (these should be registered in your DI container)
  const acpClient = container.get(ACPClientService);
  const sessionManager = container.get(SessionManager);
  const intentResolver = container.get(ChatBoxIntentResolver);

  // Initialize chat panel
  const chatPanel = new ChatPanel();
  chatPanel.initialize(acpClient, sessionManager, intentResolver);

  // Add toggle button to toolbar
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'mini-btn icon-only';
  toggleBtn.textContent = '💬';
  toggleBtn.title = 'Toggle Chat Panel (Ctrl+Shift+C)';
  toggleBtn.addEventListener('click', () => chatPanel.toggle());
  toolbar.appendChild(toggleBtn);

  // Register keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      chatPanel.toggle();
    }
  });
}
```

### 4. Connect Operation Dispatcher to Sidecar

Update the `OperationDispatcher` to connect to your actual sidecar:

```typescript
import { OperationDispatcher } from './operation-dispatcher.js';

const operationDispatcher = new OperationDispatcher();

// Override handlers to use actual sidecar
operationDispatcher.register('wfpy.createNode', async (params) => {
  try {
    const result = await wfpySidecar.send({
      op: 'createNode',
      params: {
        node_type: params.node_type,
        name: params.name,
        ...params,
      },
    });

    return {
      success: result.status === 'ok',
      message: result.message,
      data: result.diagnostic,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// Repeat for other operations...
```

### 5. Handle ACP Permissions

Implement permission handling in your extension:

```typescript
acpClient.on('permissionRequest', async (request) => {
  const result = await vscode.window.showWarningMessage(
    `Agent requests permission: ${request.description}`,
    'Allow',
    'Deny'
  );

  return {
    outcome: result === 'Allow' ? 'granted' : 'denied',
  };
});
```

## Usage

### Opening the Chat Panel

- **Keyboard shortcut**: `Ctrl+Shift+C`
- **Command**: `workflow.chat.open`
- **Toolbar button**: 💬 icon

### Creating Sessions

1. Click "+ New" in the session selector
2. Enter a session name
3. Choose mode (Plan or Build)

### Using Commands

#### Slash Commands

Type `/` followed by a command name:

```
/create-task MyTask
/create-agent MyAgent
/connect TaskA TaskB
/analyze
/help
```

#### Quick Commands

Click buttons in the quick commands bar:
- 🔍 Analyze
- 🧪 Validate
- 🚀 Run
- 📊 Export
- 🔧 Fix
- 📝 Docs

#### Command Palette

Press `/` or click the `/` button to open the command palette:
- Search commands by name or description
- Navigate with arrow keys
- Press Enter to execute

### Switching Modes

- **Dropdown**: Select Plan or Build mode
- **Keyboard shortcuts**:
  - `Ctrl+Shift+P` → Plan mode
  - `Ctrl+Shift+B` → Build mode

### Selecting Models

Use the provider dropdown to switch between available models/providers.

## Mode Differences

### Plan Mode (Read-Only)
- ✅ Analyze, validate, list operations
- ✅ Generate documentation
- ✅ Export workflow
- ❌ Create, delete, modify nodes
- ❌ Run workflow
- ❌ Fix issues

### Build Mode (Read-Write)
- ✅ All Plan mode operations
- ✅ Create, delete, modify nodes
- ✅ Connect nodes
- ✅ Run workflow
- ✅ Fix issues

## Troubleshooting

### Chat Panel Not Opening

1. Ensure ACP client is started: `workflow.chat.open` command
2. Check for errors in VS Code Developer Console
3. Verify opencode is installed and in PATH

### Commands Not Working

1. Check mode restrictions (some commands only work in Build mode)
2. Verify session is active
3. Check operation dispatcher is connected to sidecar

### Sessions Not Persisting

1. Ensure workspace is open
2. Check workspace storage permissions
3. Verify session manager is initialized

## Testing

Run the test suite:

```bash
cd packages/extension-core
npm test
```

All 82 tests should pass.

## API Reference

### ACPClientService

```typescript
// Start client
await acpClient.start(cwd: string);

// Session management
const sessionId = await acpClient.createSession(cwd, name?, mode?);
await acpClient.loadSession(sessionId);
await acpClient.deleteSession(sessionId);

// Mode switching
await acpClient.setSessionMode(sessionId, mode);
const mode = acpClient.getSessionMode(sessionId);

// Provider selection
const providers = await acpClient.listProviders();
await acpClient.setProvider(sessionId, providerId);

// Messaging
await acpClient.sendPrompt(sessionId, prompt);
await acpClient.cancelPrompt(sessionId);
```

### SessionManager

```typescript
// Create session
const session = await sessionManager.createSession(workflowFile, name?, mode?);

// Load session
await sessionManager.loadSession(sessionId);

// Message management
sessionManager.addMessage(message);
sessionManager.updateLastMessage(updates);
sessionManager.clearMessages();

// Search
const results = sessionManager.searchMessages(workflowFile, query);
```

### ChatBoxIntentResolver

```typescript
// Resolve intent
const intent = await intentResolver.resolve(userInput, currentMode);

// Execute intent
await intent.handler(intent.args);

// Get commands for mode
const commands = intentResolver.getIntentsForMode(mode);
```

## Next Steps

1. Test with real workflow files
2. Customize operation handlers for your sidecar
3. Add custom commands as needed
4. Implement permission UI dialogs
5. Add terminal integration for command execution

## Support

For issues or questions:
- Check the test files for usage examples
- Review the ACP SDK documentation
- Consult the wfpy sidecar documentation
