/**
 * GLSP messenger ↔ ChatRuntime adapter for diagram profiles. Chat travels
 * over the GLSP `vscode-messenger` channel (the diagram webview's raw
 * postMessage is owned by GLSP). The method names are a frozen wire contract
 * with `diagram-client/src/chat-panel-integrated.ts`.
 *
 * Every panel message carries `data.workflowUri` (the panel spreads it into
 * each send), which keys both runtime scoping and the reply route: the sink
 * posts to the panel that owns the URI — not to "whoever spoke last".
 */
import * as vscode from 'vscode';
import type { MessageParticipant, NotificationType } from 'vscode-messenger-common';
import type { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import type { ChatMessageSink, ChatPayload } from '../../api';

interface ChatEnvelope {
    type: string;
    data: any;
}
const ChatToHost: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toHost' };
const ChatToClient: NotificationType<ChatEnvelope> = { method: 'dialogram/chat/toClient' };

const CONNECTOR_RETRY_MS = 250;
const CONNECTOR_RETRY_MAX = 20;

export interface GlspChatTransport {
    /** Per-URI reply sink handed to the ChatRuntime constructor. */
    sink: ChatMessageSink;
    /** Install the messenger listener and start forwarding to the runtime. */
    connect(runtime: { handleMessage(uri: string, payload: ChatPayload): Promise<void> }): void;
    dispose(): void;
}

function fallbackUri(): string | undefined {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = activeTab?.input as { uri?: vscode.Uri } | undefined;
    if (input?.uri) {
        return input.uri.toString();
    }
    const editor = vscode.window.activeTextEditor?.document.uri;
    return editor?.toString();
}

export function createGlspChatTransport(opts: {
    getConnector(): GlspVscodeConnector | undefined;
    log(message: string): void;
}): GlspChatTransport {
    const participantByUri = new Map<string, MessageParticipant>();
    let messenger: GlspVscodeConnector['messenger'] | undefined;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const sink: ChatMessageSink = (uri, payload) => {
        const participant = participantByUri.get(uri);
        if (messenger && participant) {
            messenger.sendNotification(ChatToClient, participant, { type: payload.type, data: payload.data });
        }
    };

    const wire = (runtime: { handleMessage(uri: string, payload: ChatPayload): Promise<void> }, attempt = 0): void => {
        if (disposed) {
            return;
        }
        const connector = opts.getConnector();
        if (!connector) {
            if (attempt < CONNECTOR_RETRY_MAX) {
                retryTimer = setTimeout(() => wire(runtime, attempt + 1), CONNECTOR_RETRY_MS);
                return;
            }
            opts.log('WARNING: GLSP connector not available; chat transport not wired');
            return;
        }
        messenger = connector.messenger;
        messenger.onNotification(ChatToHost, (env, sender) => {
            const uri = typeof env?.data?.workflowUri === 'string' && env.data.workflowUri.length > 0
                ? env.data.workflowUri
                : fallbackUri();
            if (!uri) {
                opts.log(`chat message '${env?.type}' dropped: no workflow URI resolvable`);
                return;
            }
            participantByUri.set(uri, sender);
            void runtime.handleMessage(uri, { type: env.type, data: env.data });
        });
        opts.log('chat transport wired to GLSP connector (vscode-messenger)');
    };

    return {
        sink,
        connect(runtime): void {
            wire(runtime);
        },
        dispose(): void {
            disposed = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            participantByUri.clear();
        }
    };
}
