/**
 * Per-profile platform activation — the implementation behind
 * `DialogramApi.activateDiagramProfile`.
 *
 * NOTE ON ISOLATION: all state lives in per-profile instances
 * (ChatRuntime, GlspIntegrationHandle). The platform
 * module is shared across profiles, loaded once by the host (see main.ts).
 * Each profile gets its own runtime instances, providing complete isolation.
 *
 * This module consumes ONLY the neutral {@link DiagramProfile}: the model
 * source, server modules, edit backend, run driver and new-source-file command
 * arrive as profile-supplied capabilities. No external-tool/product vocabulary and no
 * toolkit import appear here.
 */
import type * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import type { DiagramProfile, DiagramProfileHandle } from "../api";
import { activateGlspIntegration } from "./diagram/glsp-activation";
import { ChatRuntime, type ChatRuntimeConfig } from "./chat/chat-runtime";
import { createAcpAgentResolver, createConnectorResumeResolver } from "./chat/acp-connectors";
import { createViewerEditorsTool } from "./chat/viewer-editors-tool";
import { GlspMcpClient } from "./chat/glsp-mcp-client";
import type { ChatCommandContribution } from "./chat/slash-commands";
import { platformChatCommands } from "./chat/untangle-command";
import {
  createEditChatCapability,
  type EditChatCapability,
} from "./chat/edit-capability";
import {
  createGlspChatTransport,
  type GlspChatTransport,
} from "./chat/glsp-chat-transport";

export async function activateProfileRuntime(
  context: vscode.ExtensionContext,
  profile: DiagramProfile,
  assetsUri?: vscode.Uri,
): Promise<DiagramProfileHandle> {
  const glsp = await activateGlspIntegration(context, profile, assetsUri);
  context.subscriptions.push(glsp);

  // New-source-file (and any edit-backend) commands are a profile-supplied capability.
  const newSourceDisposable = profile.newSourceFile?.(context);
  if (newSourceDisposable) {
    context.subscriptions.push(newSourceDisposable);
  }

  // Chat activates when the profile carries a chat config; the edit-backed
  // features (slash ops, graph context, in-process MCP tools, view-op hook) additionally
  // require an edit backend. Read-only profiles get pass-through chat only.
  let chatRuntime: ChatRuntime | undefined;
  let transport: GlspChatTransport | undefined;
  let capability: EditChatCapability | undefined;
  if (profile.chat) {
    const log = (message: string) => chatRuntime?.logLine(message);
    transport = createGlspChatTransport({
      getConnector: () => glsp.connector,
      log: (m) => log(m),
    });
    // The diagram's tools, which the slash commands call: one client for
    // them all, only where the profile turns the tools on, as for the agent.
    const diagramTools = profile.mcp?.enabled === true && glsp.mcpServerUrl
      ? new GlspMcpClient(glsp.mcpServerUrl)
      : undefined;
    if (profile.editBackend) {
      capability = createEditChatCapability({
        profile,
        editBackend: profile.editBackend,
        getEditorProvider: () => glsp.editorProvider,
        log: (m) => log(m),
        mcpServerUrl: diagramTools ? glsp.mcpServerUrl : undefined,
        mcpClient: diagramTools,
      });
    }
    // The platform's own commands, in every product whose diagram tools are
    // on and whose diagrams the platform's module serves: `/untangle` lays
    // the diagram out (its port orders kept with the layout, or written
    // where the product's source takes them).
    const platformCommands = platformChatCommands(
      profile,
      diagramTools,
      () => glsp.editorProvider,
    );
    const config = assembleChatRuntimeConfig(
      profile,
      capability,
      glsp.mcpServerUrl,
      platformCommands,
    );
    chatRuntime = new ChatRuntime(context, config, transport.sink, transport.canReach);
    transport.connect(chatRuntime);
    // The run driver's human port: a running agent's question goes to the
    // chat panel open on the diagram (the chat is the run's viewer there).
    const runtime = chatRuntime;
    glsp.setRunQuestionHandler((question, uri) => runtime.askRunQuestion(uri, question));
    glsp.setChatTaskHandler(async (task, uri) => runtime.startTask(uri, task));
    glsp.setChatConfirmHandler((confirm, uri) => runtime.confirmInChat(uri, confirm));
    // A diagram's session putting a card or a message to the person (the chat's untangle).
    glsp.setDiagramChatHost({
      canAsk: (uri) => runtime.canAsk(uri),
      confirm: (uri, card) => runtime.confirmInChat(uri, card),
      post: async (uri, message) => runtime.postInChat(uri, message),
    });
    context.subscriptions.push(chatRuntime, {
      dispose: () => {
        transport?.dispose();
        capability?.dispose();
      },
    });
  }

  return {
    dispose: () => glsp.dispose(),
    // The product's selection, shown in the outline (outline-host.ts).
    revealOutlineRow: (uri, row) =>
      glsp.outline.reveal(typeof uri === "string" ? uri : uri.toString(), row),
    chat: {
      runDiagnostics: () => chatRuntime?.runDiagnostics(),
      showLog: () => chatRuntime?.showLog(),
    },
    // Host→client seams for library consumers (e.g. mlir cursor-sync / markers).
    // Both delegate to the editor provider, which owns per-URI client/panel tracking.
    dispatchToWebview: (uri, action) =>
      glsp.editorProvider.dispatchToWebview(uri, action),
    postToWebview: (uri, message) =>
      glsp.editorProvider.postToWebview(uri, message),
    // The diagram's own loading indicator, for what the product does for it
    // outside `getGraph` (a layout streamed in after the graph is drawn).
    loading: {
      report: (uri, progress) =>
        glsp.editorProvider.postLoadingToDocument(uri, { state: "progress", ...progress }),
      end: (uri) => glsp.editorProvider.postLoadingToDocument(uri, { state: "done" }),
    },
    // The reader's view options, held by the host per file.
    getViewOptions: (uri) => glsp.viewOptions.get(uriString(uri)),
    setViewOptions: (uri, changes) => glsp.viewOptions.set(uriString(uri), changes),
  };
}

/** A file named as a `vscode.Uri`, a URI string or an absolute path, as a URI string. */
function uriString(uri: string | vscode.Uri): string {
  if (typeof uri !== "string") {
    return uri.toString();
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(uri) ? uri : pathToFileURL(uri).toString();
}

/**
 * Build the ChatRuntime config for a diagram profile. Pure assembly — the
 * testable seam for the capability/profile merge rules:
 * capability graph provider wins; slash commands are capability-first, then
 * the platform's own (`/untangle`), with profile contributions appended
 * (profile overrides by name via registry map semantics); tools/turn/selection
 * come only from the profile.
 */
export function assembleChatRuntimeConfig(
  profile: DiagramProfile,
  capability: EditChatCapability | undefined,
  mcpServerUrl?: string,
  platformCommands: ChatCommandContribution[] = [],
): ChatRuntimeConfig {
  const chat = profile.chat!;
  return {
    key: profile.key,
    displayName: chat.fullName ?? profile.displayName,
    settingsSection: `${profile.settingsNamespace}.chat`,
    skill: chat.skill,
    sourceMimeType: chat.sourceMimeType,
    sourceMaxBytes: chat.sourceMaxBytes,
    // A profile that renders its own graph context (a summary by reference,
    // say) is heard; otherwise the edit capability's export, as before.
    graphContextProvider: chat.graphContextProvider
      ?? (capability ? (f) => capability.graphContextProvider(f) : undefined),
    turnContextProvider: chat.turnContextProvider,
    acpAgent: chat.acpConnector
      ? createAcpAgentResolver(profile.settingsNamespace, chat.acpConnector)
      : undefined,
    connectorResume: chat.acpConnector
      ? createConnectorResumeResolver(chat.acpConnector)
      : undefined,
    selectionContext: chat.selectionContext,
    // The profile's own tools, plus the platform's: "what can open this file"
    // is a question about the EDITOR, not about any one product's graph, so it
    // is answered here rather than contributed by every shell in turn.
    tools: [...(chat.tools ?? []), createViewerEditorsTool()],
    // GLSP-MCP parallel-run (0.5.0): the coarse profile gate plus the URL the
    // in-host diagram server announced. The chat runtime consults the finer
    // `<ns>.chat.useGlspMcp` per-user setting before advertising it (T6).
    glspMcpEnabled: profile.mcp?.enabled === true,
    mcpServerUrl,
    slashCommands: [
      ...(capability?.slashCommands ?? []),
      ...platformCommands,
      ...(chat.slashCommands ?? []),
    ],
    postTurnHook: capability
      ? (f, t) => capability.postTurnHook(f, t)
      : undefined,
  };
}
