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
import type { ChatMessageSink, ChatProfile, ChatProfileHandle, DiagramProfile, DiagramProfileHandle } from '../api';
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
        const config: ChatRuntimeConfig = {
            key: profile.key,
            displayName: profile.chat.fullName ?? profile.displayName,
            settingsSection: `${profile.settingsNamespace}.chat`,
            skill: profile.chat.skill,
            sourceMimeType: profile.chat.sourceMimeType,
            graphContextProvider: capability ? f => capability!.graphContextProvider(f) : undefined,
            stdioMcpServers: capability ? f => capability!.stdioMcpServers(f) : undefined,
            slashCommands: capability?.slashCommands ?? [],
            postTurnHook: capability ? (f, t) => capability!.postTurnHook(f, t) : undefined
        };
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

/** Chat-only activation — the implementation behind `activateChatProfile`. */
export function activateChatRuntime(
    context: vscode.ExtensionContext,
    profile: ChatProfile,
    postToWebview: ChatMessageSink
): ChatProfileHandle {
    const runtime = new ChatRuntime(context, chatProfileToConfig(profile), postToWebview);
    context.subscriptions.push(runtime);
    return {
        handleMessage: (uri, payload) => runtime.handleMessage(uri, payload),
        setSelection: (uri, selectedNodeIds) => runtime.setSelection(uri, selectedNodeIds),
        dispose: () => runtime.dispose()
    };
}

/**
 * Temporary bridge (removed in Task 6): map the legacy chat-only {@link ChatProfile}
 * onto the unified {@link ChatRuntimeConfig}. `profile.slashCommands` is
 * `ChatSlashCommand[]` (pass-through suggestions), structurally a subset of
 * `ChatCommandContribution[]`, so it typechecks unchanged.
 */
function chatProfileToConfig(profile: ChatProfile): ChatRuntimeConfig {
    return {
        key: profile.key,
        displayName: profile.displayName,
        settingsSection: profile.settingsSection,
        skill: profile.skill,
        graphContextProvider: profile.graphContextProvider,
        turnContextProvider: profile.turnContextProvider,
        selectionContext: profile.selectionContext,
        tools: profile.tools,
        slashCommands: profile.slashCommands
    };
}
