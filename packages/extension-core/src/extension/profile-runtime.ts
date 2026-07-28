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
import type * as vscode from 'vscode';
import type { DiagramProfile, DiagramProfileHandle } from '../api';
import { activateGlspIntegration } from './diagram/glsp-activation';
import { ChatRuntime, type ChatRuntimeConfig } from './chat/chat-runtime';
import { createEditChatCapability, type EditChatCapability } from './chat/edit-capability';
import { createGlspChatTransport, type GlspChatTransport } from './chat/glsp-chat-transport';

export async function activateProfileRuntime(
    context: vscode.ExtensionContext,
    profile: DiagramProfile,
    assetsUri?: vscode.Uri
): Promise<DiagramProfileHandle> {
    const glsp = await activateGlspIntegration(context, profile, assetsUri);
    context.subscriptions.push(glsp);

    // New-source-file (and any edit-backend) commands are a profile-supplied capability.
    const newSourceDisposable = profile.newSourceFile?.(context);
    if (newSourceDisposable) {
        context.subscriptions.push(newSourceDisposable);
    }

    // Chat activates when the profile carries a chat config; the edit-backed
    // features (slash ops, graph context, stdio MCP, view-op hook) additionally
    // require an edit backend. Read-only profiles get pass-through chat only.
    let chatRuntime: ChatRuntime | undefined;
    let transport: GlspChatTransport | undefined;
    let capability: EditChatCapability | undefined;
    if (profile.chat) {
        const log = (message: string) => chatRuntime?.logLine(message);
        transport = createGlspChatTransport({ getConnector: () => glsp.connector, log: m => log(m) });
        if (profile.editBackend) {
            capability = createEditChatCapability({
                profile,
                editBackend: profile.editBackend,
                getEditorProvider: () => glsp.editorProvider,
                getAssetsPath: () => (assetsUri ?? context.extensionUri).fsPath,
                log: m => log(m)
            });
        }
        const config = assembleChatRuntimeConfig(profile, capability, glsp.mcpServerUrl);
        chatRuntime = new ChatRuntime(context, config, transport.sink);
        transport.connect(chatRuntime);
        context.subscriptions.push(chatRuntime, {
            dispose: () => {
                transport?.dispose();
                capability?.dispose();
            }
        });
    }

    return {
        dispose: () => glsp.dispose(),
        chat: {
            runDiagnostics: () => chatRuntime?.runDiagnostics(),
            showLog: () => chatRuntime?.showLog()
        },
        // Host→client seams for library consumers (e.g. mlir cursor-sync / markers).
        // Both delegate to the editor provider, which owns per-URI client/panel tracking.
        dispatchToWebview: (uri, action) => glsp.editorProvider.dispatchToWebview(uri, action),
        postToWebview: (uri, message) => glsp.editorProvider.postToWebview(uri, message)
    };
}

/**
 * Build the ChatRuntime config for a diagram profile. Pure assembly — the
 * testable seam for the capability/profile merge rules:
 * capability graph provider wins; slash commands are capability-first with
 * profile contributions appended (profile overrides by name via registry
 * map semantics); tools/turn/selection come only from the profile.
 */
export function assembleChatRuntimeConfig(
    profile: DiagramProfile,
    capability: EditChatCapability | undefined,
    mcpServerUrl?: string
): ChatRuntimeConfig {
    const chat = profile.chat!;
    return {
        key: profile.key,
        displayName: chat.fullName ?? profile.displayName,
        settingsSection: `${profile.settingsNamespace}.chat`,
        skill: chat.skill,
        sourceMimeType: chat.sourceMimeType,
        graphContextProvider: capability
            ? f => capability.graphContextProvider(f)
            : chat.graphContextProvider,
        turnContextProvider: chat.turnContextProvider,
        selectionContext: chat.selectionContext,
        tools: chat.tools,
        // GLSP-MCP parallel-run (0.5.0): the coarse profile gate plus the URL the
        // in-host diagram server announced. The chat runtime consults the finer
        // `<ns>.chat.useGlspMcp` per-user setting before advertising it (T6).
        glspMcpEnabled: profile.mcp?.enabled === true,
        mcpServerUrl,
        stdioMcpServers: capability ? f => capability.stdioMcpServers(f) : undefined,
        slashCommands: [...(capability?.slashCommands ?? []), ...(chat.slashCommands ?? [])],
        postTurnHook: capability ? (f, t) => capability.postTurnHook(f, t) : undefined
    };
}
