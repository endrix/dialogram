/**
 * Chat Box Webview Message Handler
 *
 * Handles messages from the diagram webview and communicates with opencode ACP.
 */

import * as vscode from 'vscode';
import type { ChatBackend } from './chat-backend.js';

/** High-resolution monotonic clock (ms) for the [perf] timing logs. */
function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * After a free-text turn, run any diagram VIEW operations the prompt asked for —
 * "layout", "center", "fit (to screen)". These are deterministic keyword matches,
 * not agent tools: the MCP server is a separate process and can't run VS Code
 * commands, so the extension does it here. Operations run in a stable order
 * (arrange → frame) and only after a short settle, so an edit-driven diagram
 * refresh (the FileSystemWatcher force-reload) lands first and they apply to the
 * final node set. Best-effort; failures are logged, not surfaced.
 */
async function runDiagramOpsFromPrompt(backend: ChatBackend, text: unknown): Promise<void> {
  if (typeof text !== 'string' || text.trim() === '') return;
  const profile = backend.getProfile();
  const lower = text.toLowerCase();
  const ops: Array<{ test: RegExp; command: string; label: string }> = [
    { test: /\b(?:auto-?)?lay\s?out\b/, command: profile.commands.layoutDiagram, label: 'layout' },
    { test: /\bcent(?:er|re)\b/, command: profile.commands.center, label: 'center' },
    { test: /\bfit(?:\s+to\s+screen)?\b/, command: profile.commands.fitToScreen, label: 'fit to screen' },
  ];
  const toRun = ops.filter((op) => op.test.test(lower));
  if (toRun.length === 0) return;

  // Let an edit-driven refresh settle so layout/framing sees the final nodes.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const op of toRun) {
    try {
      await vscode.commands.executeCommand(op.command);
      backend.log(`diagram op from prompt: ${op.label}`);
    } catch (err) {
      backend.log(`diagram op '${op.label}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Resolve the workflow file the chat is scoped to.
 *
 * A focused GLSP diagram is a custom editor, so `activeTextEditor` is usually
 * undefined. We prefer the diagram's own URI (sent by the webview), then the
 * active custom editor tab, then any active text editor.
 */
function resolveWorkflowFile(data?: any): string | undefined {
  // 1. URI supplied by the diagram webview.
  const fromWebview = data?.workflowUri;
  if (typeof fromWebview === 'string' && fromWebview.length > 0) {
    try {
      return vscode.Uri.parse(fromWebview).fsPath;
    } catch {
      // fall through
    }
  }

  // 2. Active text editor (when a .py file itself is focused).
  const fromEditor = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (fromEditor) return fromEditor;

  // 3. Active custom editor tab (the diagram), via the tabs API.
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const input = activeTab?.input as { uri?: vscode.Uri } | undefined;
  if (input?.uri) return input.uri.fsPath;

  return undefined;
}

/**
 * Apply the user's preferred model to a freshly created session, if one is set
 * and it is a valid model. Best-effort.
 */
async function applyPreferredModel(backend: ChatBackend, acpClient: any, sessionId: string): Promise<void> {
  const preferred = backend.getPreferredModel();
  if (!acpClient || !preferred) return;
  try {
    const models = await acpClient.listProviders();
    if (Array.isArray(models) && models.some((m: any) => m.id === preferred)) {
      await acpClient.setProvider(sessionId, preferred);
    }
  } catch {
    // best effort
  }
}

/**
 * Handle chat messages from the diagram webview
 */
export async function handleWebviewChatMessage(
  backend: ChatBackend,
  webview: vscode.Webview,
  message: any
): Promise<void> {
  // Webview-originated log lines (so both directions show in one channel).
  if (message.type === 'chat.log') {
    backend.log(`webview: ${message.data?.message ?? ''}`);
    return;
  }

  backend.log(`webview → ${message.type}`);

  const acpClient = backend.getACPClient();
  const sessionManager = backend.getSessionManager();
  const intentResolver = backend.getIntentResolver();

  switch (message.type) {
    case 'chat.ready':
    case 'chat.getStatus':
      handleReady(backend, webview, acpClient, sessionManager, message.data);
      break;

    case 'chat.sendMessage':
      await handleSendMessage(backend, webview, message.data, acpClient, sessionManager, intentResolver);
      break;

    case 'chat.createSession':
      await handleCreateSession(backend, webview, message.data, sessionManager);
      break;

    case 'chat.loadSession':
      await handleLoadSession(backend, webview, message.data, acpClient, sessionManager);
      break;

    case 'chat.revert':
      await handleRevert(backend, webview, message.data, acpClient, sessionManager);
      break;

    case 'chat.unrevert':
      await handleUnrevert(backend, webview, message.data, acpClient, sessionManager);
      break;

    case 'chat.getCommands':
      handleGetCommands(webview, message.data, intentResolver);
      break;

    case 'chat.cancel':
      await handleCancel(message.data, acpClient, sessionManager);
      break;

    case 'chat.permissionResponse':
      acpClient?.respondToPermission?.(message.data?.requestId, message.data?.optionId ?? null);
      break;

    case 'chat.deleteSession':
      await handleDeleteSession(webview, message.data, sessionManager);
      break;

    case 'chat.renameSession':
      await handleRenameSession(webview, message.data, sessionManager);
      break;

    case 'chat.setMode':
      await handleSetMode(message.data, acpClient, sessionManager);
      break;

    case 'chat.setProvider':
      await handleSetProvider(backend, message.data, acpClient, sessionManager);
      break;

    case 'chat.getProviders':
      await handleGetProviders(backend, webview, acpClient);
      break;

    case 'chat.getSessions':
      await handleGetSessions(webview, sessionManager, message.data);
      break;
  }
}

/**
 * Respond to the webview's readiness handshake with the current backend state.
 * This is a pull (rather than relying on the extension's immediate push) so the
 * status never gets lost to a listener-registration race.
 */
function handleReady(backend: ChatBackend, webview: vscode.Webview, acpClient: any, sessionManager: any, data?: any): void {
  const status = backend.getStatus();
  backend.log(`handleReady → posting connectionStatus connected=${status.connected}${status.reason ? ` reason=${status.reason}` : ''}`);
  void Promise.resolve(
    webview.postMessage({
      type: 'chat.connectionStatus',
      data: { connected: status.connected, reason: status.reason },
    })
  ).then(
    (ok) => backend.log(`postMessage(connectionStatus) delivered=${ok}`),
    (err) => backend.log(`postMessage(connectionStatus) FAILED: ${err}`)
  );

  // Push providers + sessions so the selectors populate immediately.
  void handleGetProviders(backend, webview, acpClient);
  void handleGetSessions(webview, sessionManager, data);
}

/**
 * Handle send message
 */
async function handleSendMessage(
  backend: ChatBackend,
  webview: vscode.Webview,
  data: any,
  acpClient: any,
  sessionManager: any,
  intentResolver: any
): Promise<void> {
  if (!acpClient || !sessionManager) {
    webview.postMessage({
      type: 'chat.message',
      data: {
        role: 'system',
        content: 'Error: ACP client or session manager not initialized',
        timestamp: Date.now(),
      },
    });
    return;
  }

  try {
    let sessionId = data.sessionId || sessionManager.getCurrentSessionId();

    // Create session if none exists
    if (!sessionId) {
      const workflowFile = resolveWorkflowFile(data);
      if (!workflowFile) {
        webview.postMessage({
          type: 'chat.message',
          data: {
            role: 'system',
            content: 'Error: No workflow file open',
            timestamp: Date.now(),
          },
        });
        return;
      }

      const session = await sessionManager.createSession(workflowFile, 'Default Session', data.mode || 'build');
      sessionId = session.id;
      sessionManager.setCurrentSession(sessionId);

      // Apply the user's preferred model to the fresh session.
      await applyPreferredModel(backend, acpClient, sessionId);

      // A session now exists, so the model catalog is known — refresh the UI.
      postModelState(webview, acpClient, sessionId);
    }

    // Ensure subsequent persistence/streaming targets this session.
    sessionManager.setCurrentSession(sessionId);

    // Persist the user's message.
    const mode = acpClient.getSessionMode(sessionId);
    sessionManager.addMessageToSession(sessionId, {
      role: 'user',
      content: data.text,
      timestamp: Date.now(),
      mode,
    });

    // Resolve intent
    const intent = await intentResolver.resolve(data.text, mode);

    // Execute intent
    if (intent.handler) {
      await intent.handler(intent.args);

      // Send success message for commands
      if (intent.command !== 'natural-language') {
        webview.postMessage({
          type: 'chat.message',
          data: {
            role: 'system',
            content: `✓ Executed: /${intent.command}`,
            timestamp: Date.now(),
            mode,
          },
        });
      } else {
        // A free-text prompt to the agent has now finished (any node-adding via
        // MCP is applied). If the prompt asked for diagram view operations
        // ("layout", "center", "fit"), run them last, on the settled diagram.
        await runDiagramOpsFromPrompt(backend, data.text);
      }
    }
  } catch (error) {
    webview.postMessage({
      type: 'chat.message',
      data: {
        role: 'system',
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Handle create session
 */
async function handleCreateSession(
  backend: ChatBackend,
  webview: vscode.Webview,
  data: any,
  sessionManager: any
): Promise<void> {
  if (!sessionManager) return;

  try {
    const workflowFile = resolveWorkflowFile(data);
    if (!workflowFile) {
      webview.postMessage({
        type: 'chat.error',
        data: { message: 'No workflow file open' },
      });
      return;
    }

    // Collect the name via a native input box (webview prompt() is blocked).
    let name: string | undefined = data?.name;
    if (!name) {
      const existing = sessionManager.getSessionsForWorkflow?.(workflowFile) ?? [];
      name = await vscode.window.showInputBox({
        title: 'New Chat Session',
        prompt: 'Name for the new chat session',
        value: `Session ${existing.length + 1}`,
        ignoreFocusOut: true,
      });
      if (!name) {
        // User cancelled the name prompt — tell the panel to drop its spinner.
        webview.postMessage({ type: 'chat.sessionCreateAborted' });
        return;
      }
    }

    const session = await sessionManager.createSession(workflowFile, name, data?.mode);
    sessionManager.setCurrentSession(session.id);

    // Apply the user's preferred model to the new session.
    await applyPreferredModel(backend, backend.getACPClient(), session.id);

    webview.postMessage({
      type: 'chat.sessionCreated',
      data: { session },
    });

    // Refresh model catalog + current selection now that a session exists.
    postModelState(webview, backend.getACPClient(), session.id);
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to create session: ${error}` },
    });
  }
}

/**
 * Handle load session
 */
async function handleLoadSession(
  backend: ChatBackend,
  webview: vscode.Webview,
  data: any,
  acpClient: any,
  sessionManager: any
): Promise<void> {
  if (!sessionManager) return;

  const sessionId = data.sessionId;
  // Profiling: loading a session fans out to several opencode round-trips
  // (re-attaching MCP servers, model restore, message + revert-state fetches),
  // any of which can dominate. Time each so the slow one is identifiable from
  // the [ChatBox] log. Low-frequency user action, so always on.
  const t0 = perfNow();
  let tLoad = t0;
  let tProvider = t0;
  try {
    const session = await sessionManager.loadSession(sessionId);
    tLoad = perfNow();
    if (!session) {
      // The agent couldn't re-load the session (e.g. it no longer exists in
      // opencode). Surface it instead of silently letting the user type into a
      // session the agent will reject on the next prompt.
      webview.postMessage({
        type: 'chat.error',
        data: { message: `Could not restore session ${sessionId}. It may have expired — start a new chat.` },
      });
      return;
    }
    sessionManager.setCurrentSession(sessionId);

    // Restore the session's model on the opencode side so it's authoritative.
    const model = session?.provider ?? acpClient?.getSessionModel?.(sessionId);
    if (acpClient && model) {
      try {
        await acpClient.setProvider(sessionId, model);
      } catch {
        // best effort
      }
    }
    tProvider = perfNow();

    // Send the full conversation so the panel can render it (with revert ids).
    await postSessionHistory(backend, webview, acpClient, sessionManager, sessionId, {
      mode: session?.mode ?? acpClient?.getSessionMode?.(sessionId),
      model,
    });
    const tDone = perfNow();
    backend.log(
      `[perf] loadSession ${sessionId.slice(0, 8)}: reload=${Math.round(tLoad - t0)} provider=${Math.round(tProvider - tLoad)} history=${Math.round(tDone - tProvider)} total=${Math.round(tDone - t0)}ms`
    );
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to load session: ${error}` },
    });
  }
}

/**
 * Post the full conversation for a session, with each user message annotated
 * with its opencode message id (for revert targeting) and the session's
 * reverted state (for the redo affordance).
 *
 * User messages are aligned to opencode's message list by content (in order) —
 * not by index — so locally-only entries (slash commands that never hit
 * opencode) don't shift the mapping onto the wrong message.
 */
/**
 * Resolve the opencode message id for each user message (in order), by aligning
 * against opencode's authoritative message list. Matching is by content with an
 * `endsWith` test — the actual prompt is always the last text block, but the
 * first prompt of a session also has workflow *context* text prepended, so an
 * exact match would miss it. Locally-only messages (slash commands that never
 * hit opencode) resolve to `undefined` without consuming an opencode entry, so
 * they don't shift the mapping onto the wrong message.
 */
async function alignUserMessageIds(
  acpClient: any,
  sessionId: string,
  userContents: string[]
): Promise<Array<string | undefined>> {
  let oc: Array<{ id: string; text: string }> = [];
  try {
    const ocMessages = (await acpClient?.getMessagesWithIds?.(sessionId)) ?? [];
    oc = ocMessages
      .filter((m: any) => m?.role === 'user' && typeof m.id === 'string')
      .map((m: any) => ({ id: m.id, text: String(m.text ?? '').trim() }));
  } catch {
    return userContents.map(() => undefined);
  }

  const out: Array<string | undefined> = [];
  let i = 0;
  for (const raw of userContents) {
    const content = (raw ?? '').trim();
    if (i < oc.length && content !== '' && (oc[i].text === content || oc[i].text.endsWith(content))) {
      out.push(oc[i].id);
      i++;
    } else {
      out.push(undefined);
    }
  }
  return out;
}

async function postSessionHistory(
  backend: ChatBackend,
  webview: vscode.Webview,
  acpClient: any,
  sessionManager: any,
  sessionId: string,
  extra?: { mode?: string; model?: string }
): Promise<void> {
  const stored = sessionManager.getSessionMessages(sessionId) as Array<{ role: string; content: string }>;

  const userContents = stored.filter((m) => m.role === 'user').map((m) => m.content ?? '');
  const tAlign0 = perfNow();
  const ids = await alignUserMessageIds(acpClient, sessionId, userContents);
  const tAlign1 = perfNow();
  let reverted = false;
  try {
    reverted = Boolean(await acpClient?.getRevertState?.(sessionId));
  } catch {
    // HTTP API unavailable — render history without revert ids.
  }
  const tRevert = perfNow();
  backend.log(
    `[perf] postSessionHistory ${sessionId.slice(0, 8)}: messages=${stored.length} listMessages=${Math.round(tAlign1 - tAlign0)} revertState=${Math.round(tRevert - tAlign1)}ms`
  );

  let k = 0;
  const messages = stored.map((m) => {
    if (m.role !== 'user') return m;
    const messageId = ids[k++];
    return messageId ? { ...m, messageId } : m;
  });

  webview.postMessage({
    type: 'chat.sessionHistory',
    data: {
      sessionId,
      messages,
      mode: extra?.mode ?? acpClient?.getSessionMode?.(sessionId),
      model: extra?.model,
      reverted,
    },
  });
}

/**
 * Push freshly-resolved message ids for the live timeline (after a turn ends),
 * so just-sent user messages get a revert affordance without rebuilding the
 * panel's timeline. `ids` is one entry per user message, in order.
 */
async function postLiveMessageIds(webview: vscode.Webview, acpClient: any, sessionManager: any, sessionId: string): Promise<void> {
  if (!acpClient || !sessionManager || !sessionId) return;
  const stored = (sessionManager.getSessionMessages(sessionId) ?? []) as Array<{ role: string; content: string }>;
  const userContents = stored.filter((m) => m.role === 'user').map((m) => m.content ?? '');
  const ids = await alignUserMessageIds(acpClient, sessionId, userContents);
  let reverted = false;
  try {
    reverted = Boolean(await acpClient.getRevertState?.(sessionId));
  } catch {
    // ignore
  }
  webview.postMessage({ type: 'chat.messageIds', data: { sessionId, ids, reverted } });
}

/**
 * Revert the session to before a given opencode message — undoing that prompt,
 * all later messages, and the file changes they made. Re-posts the (now
 * truncated) history so the panel re-renders, with the redo affordance enabled.
 */
async function handleRevert(
  backend: ChatBackend,
  webview: vscode.Webview,
  data: any,
  acpClient: any,
  sessionManager: any
): Promise<void> {
  const sessionId = data?.sessionId || sessionManager?.getCurrentSessionId?.();
  const messageId = data?.messageId;
  if (!acpClient || !sessionManager || !sessionId || !messageId) return;
  try {
    await acpClient.revertToMessage(sessionId, messageId);
    await postSessionHistory(backend, webview, acpClient, sessionManager, sessionId);
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to revert: ${error instanceof Error ? error.message : String(error)}` },
    });
  }
}

/** Restore whatever the most recent revert undid, then re-post the history. */
async function handleUnrevert(
  backend: ChatBackend,
  webview: vscode.Webview,
  data: any,
  acpClient: any,
  sessionManager: any
): Promise<void> {
  const sessionId = data?.sessionId || sessionManager?.getCurrentSessionId?.();
  if (!acpClient || !sessionManager || !sessionId) return;
  try {
    await acpClient.unrevert(sessionId);
    await postSessionHistory(backend, webview, acpClient, sessionManager, sessionId);
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to redo: ${error instanceof Error ? error.message : String(error)}` },
    });
  }
}

/**
 * Delete a session after a modal confirmation. Picks the next session (if any)
 * for the same workflow so the UI can switch to it.
 */
async function handleDeleteSession(
  webview: vscode.Webview,
  data: any,
  sessionManager: any
): Promise<void> {
  if (!sessionManager || !data?.sessionId) return;

  const all: any[] = sessionManager.getAllSessions?.() ?? [];
  const target = all.find((s) => s.id === data.sessionId);
  const label = target?.name ?? data.sessionId;

  const choice = await vscode.window.showWarningMessage(
    `Delete chat session "${label}"? This cannot be undone.`,
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') return;

  // Choose the next session for the same workflow before deleting.
  const workflowFile = target?.workflowFile;
  let nextSessionId: string | undefined;
  if (workflowFile) {
    const siblings: any[] = sessionManager.getSessionsForWorkflow?.(workflowFile) ?? [];
    nextSessionId = siblings.find((s) => s.id !== data.sessionId)?.id;
  }

  try {
    await sessionManager.deleteSession(data.sessionId);
    if (nextSessionId) {
      sessionManager.setCurrentSession(nextSessionId);
    }
    webview.postMessage({
      type: 'chat.sessionDeleted',
      data: { sessionId: data.sessionId, nextSessionId },
    });
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to delete session: ${error}` },
    });
  }
}

/**
 * Rename a session via a native input box.
 */
async function handleRenameSession(
  webview: vscode.Webview,
  data: any,
  sessionManager: any
): Promise<void> {
  if (!sessionManager || !data?.sessionId) return;

  const all: any[] = sessionManager.getAllSessions?.() ?? [];
  const current = all.find((s) => s.id === data.sessionId);

  const name = await vscode.window.showInputBox({
    title: 'Rename Chat Session',
    prompt: 'New session name',
    value: current?.name ?? '',
    ignoreFocusOut: true,
  });
  if (!name) return;

  try {
    await sessionManager.renameSession(data.sessionId, name);
    webview.postMessage({
      type: 'chat.sessionRenamed',
      data: { sessionId: data.sessionId, name },
    });
  } catch (error) {
    webview.postMessage({
      type: 'chat.error',
      data: { message: `Failed to rename session: ${error}` },
    });
  }
}

/**
 * Cancel the in-flight prompt turn for a session.
 */
async function handleCancel(data: any, acpClient: any, sessionManager: any): Promise<void> {
  if (!acpClient) return;
  const sessionId = data?.sessionId || sessionManager?.getCurrentSessionId?.();
  if (!sessionId) return;
  try {
    await acpClient.cancelPrompt(sessionId);
  } catch {
    // best effort
  }
}

/**
 * Return the slash commands available in the given mode for the '/' menu.
 */
function handleGetCommands(webview: vscode.Webview, data: any, intentResolver: any): void {
  if (!intentResolver) {
    webview.postMessage({ type: 'chat.commands', data: { commands: [] } });
    return;
  }
  const mode: 'plan' | 'build' = data?.mode === 'plan' ? 'plan' : 'build';
  const map = intentResolver.getIntentsForMode(mode);
  const commands = Array.from(map.entries()).map(([name, handler]: [string, any]) => ({
    command: name,
    description: handler?.description ?? '',
    usage: handler?.usage ?? '',
  }));
  webview.postMessage({ type: 'chat.commands', data: { mode, commands } });
}

/**
 * Handle set mode
 */
async function handleSetMode(
  data: any,
  acpClient: any,
  sessionManager: any
): Promise<void> {
  if (!acpClient || !sessionManager) return;

  try {
    const sessionId = data.sessionId || sessionManager.getCurrentSessionId();
    if (sessionId) {
      await acpClient.setSessionMode(sessionId, data.mode);
      await sessionManager.updateSessionMode(data.mode);
    }
  } catch (error) {
    console.error('Failed to set mode:', error);
  }
}

/**
 * Handle set provider
 */
async function handleSetProvider(
  backend: ChatBackend,
  data: any,
  acpClient: any,
  sessionManager: any
): Promise<void> {
  if (!acpClient || !sessionManager) return;

  try {
    const sessionId = data.sessionId || sessionManager.getCurrentSessionId();
    if (sessionId) {
      await acpClient.setProvider(sessionId, data.providerId);
      await sessionManager.updateSessionProvider(data.providerId);
      // Remember as the default for future sessions.
      backend.setPreferredModel(data.providerId);
    }
  } catch (error) {
    console.error('Failed to set provider:', error);
  }
}

/**
 * Handle get providers
 */
async function handleGetProviders(backend: ChatBackend, webview: vscode.Webview, acpClient: any): Promise<void> {
  // Always respond so the model selector never hangs on "Loading...".
  let providers: any[] = [];
  let current: string | undefined;
  if (acpClient) {
    try {
      providers = await acpClient.listProviders();
    } catch {
      providers = [];
    }
    const sm = backend.getSessionManager();
    const sessionId = sm?.getCurrentSessionId?.();
    if (sessionId) {
      // Prefer the agent's in-memory model, but fall back to the model persisted
      // on the session — after a restart the agent map is empty until a session
      // is loaded, so without this the selector would wrongly show "Default".
      current = acpClient.getSessionModel?.(sessionId) ?? sm?.getCurrentSession?.()?.provider;
    }
  }
  webview.postMessage({
    type: 'chat.providers',
    data: { providers, current },
  });
}

/**
 * Push the current model catalog + selected model/mode for a session to the
 * webview. Used after a session is (auto-)created so the selectors populate.
 */
function postModelState(webview: vscode.Webview, acpClient: any, sessionId: string): void {
  if (!acpClient) return;
  try {
    const providers = acpClient.modelOptions ? acpClient.modelOptions : [];
    const list = typeof acpClient.listProviders === 'function' ? acpClient.listProviders() : providers;
    Promise.resolve(list).then((resolved) => {
      webview.postMessage({
        type: 'chat.providers',
        data: { providers: resolved ?? [], current: acpClient.getSessionModel?.(sessionId) },
      });
    }, () => undefined);

    const mode = acpClient.getSessionMode?.(sessionId);
    if (mode) {
      webview.postMessage({ type: 'chat.modeChanged', data: { sessionId, mode } });
    }
  } catch {
    // best-effort UI sync
  }
}

/**
 * Handle get sessions
 */
async function handleGetSessions(webview: vscode.Webview, sessionManager: any, data?: any): Promise<void> {
  if (!sessionManager) return;

  try {
    const workflowFile = resolveWorkflowFile(data);
    const sessions = workflowFile ? sessionManager.getSessionsForWorkflow(workflowFile) : [];
    webview.postMessage({
      type: 'chat.sessions',
      data: { sessions },
    });
  } catch (error) {
    webview.postMessage({
      type: 'chat.sessions',
      data: { sessions: [] },
    });
  }
}

/**
 * Forward ACP session updates to a webview.
 *
 * Returns a disposer that removes the listeners — callers MUST invoke it when
 * the webview is disposed, otherwise listeners accumulate on the singleton ACP
 * client and post to dead webviews.
 */
export function setupACPEventForwarding(backend: ChatBackend, webview: vscode.Webview): () => void {
  const post = (type: string, data: any) => {
    // postMessage on a disposed webview throws; ignore those.
    Promise.resolve(webview.postMessage({ type, data })).then(undefined, () => undefined);
  };

  const acpClient = backend.getACPClient();
  if (!acpClient) {
    // Chat backend never initialized (e.g. no workspace / opencode missing).
    post('chat.connectionStatus', { connected: false, reason: 'Chat backend not initialized' });
    return () => undefined;
  }

  // Coalesce streamed text chunks: opencode emits one notification per token, and
  // each becomes a postMessage → a webview re-render. Buffer chunk text and flush
  // on a short timer so the webview renders far less often during a turn (it
  // accumulates the text anyway, so larger increments are visually identical).
  // Non-chunk updates flush the buffer first to preserve ordering.
  let chunkBuffer: { sessionId: any; kind: string; text: string } | null = null;
  let flushTimer: NodeJS.Timeout | undefined;
  const flushChunks = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!chunkBuffer) return;
    const b = chunkBuffer;
    chunkBuffer = null;
    post('chat.sessionUpdate', {
      notification: {
        sessionId: b.sessionId,
        update: { sessionUpdate: b.kind, content: { type: 'text', text: b.text } },
      },
    });
  };
  const CHUNK_FLUSH_MS = 50;

  const onSessionUpdate = (notification: any) => {
    const update = notification?.update;
    const kind = update?.sessionUpdate;
    const content = update?.content;
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined;
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && text !== undefined) {
      // Switching session or chunk kind (answer↔thinking) flushes first to keep order.
      if (chunkBuffer && (chunkBuffer.sessionId !== notification?.sessionId || chunkBuffer.kind !== kind)) {
        flushChunks();
      }
      if (!chunkBuffer) {
        chunkBuffer = { sessionId: notification?.sessionId, kind, text: '' };
      }
      chunkBuffer.text += text;
      if (!flushTimer) {
        flushTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS);
      }
      return;
    }
    // Non-chunk update (tool call, etc.): emit any buffered text first, then this.
    flushChunks();
    post('chat.sessionUpdate', { notification });
  };
  const onModeChanged = (data: any) => post('chat.modeChanged', data);
  const onProviderChanged = (data: any) => post('chat.providerChanged', data);
  const onTurnComplete = (data: any) => {
    flushChunks(); // ensure the last tokens reach the webview before turn end
    const sessionId = data?.sessionId;
    post('chat.turnEnd', { sessionId });
    // Resolve opencode message ids for the just-completed turn so the live
    // user messages gain their "revert to here" affordance.
    void postLiveMessageIds(webview, acpClient, backend.getSessionManager(), sessionId);
  };
  const onPermissionRequest = (data: any) => post('chat.permissionRequest', data);
  const onConnected = () => post('chat.connectionStatus', { connected: true });
  const onDisconnected = () => post('chat.connectionStatus', { connected: false, reason: 'opencode disconnected' });
  const onError = (err: Error) =>
    post('chat.connectionStatus', { connected: false, reason: err?.message ?? 'opencode error' });

  acpClient.on('sessionUpdate', onSessionUpdate);
  acpClient.on('modeChanged', onModeChanged);
  acpClient.on('providerChanged', onProviderChanged);
  acpClient.on('turnComplete', onTurnComplete);
  acpClient.on('permissionRequest', onPermissionRequest);
  acpClient.on('connected', onConnected);
  acpClient.on('disconnected', onDisconnected);
  acpClient.on('error', onError);

  // Push the current status immediately so the panel reflects reality on open.
  post('chat.connectionStatus', { connected: acpClient.isClientConnected() });

  return () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    acpClient.off('sessionUpdate', onSessionUpdate);
    acpClient.off('modeChanged', onModeChanged);
    acpClient.off('providerChanged', onProviderChanged);
    acpClient.off('turnComplete', onTurnComplete);
    acpClient.off('permissionRequest', onPermissionRequest);
    acpClient.off('connected', onConnected);
    acpClient.off('disconnected', onDisconnected);
    acpClient.off('error', onError);
  };
}
