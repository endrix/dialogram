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
    /** Whether a panel has spoken for `uri` on this connection, i.e. the sink
     *  can reach it: a question posted to nobody would wait for ever. */
    canReach(uri: string): boolean;
    /** Install the messenger listener and start forwarding to the runtime. */
    connect(runtime: { handleMessage(uri: string, payload: ChatPayload): Promise<void> }): void;
    dispose(): void;
}

/**
 * The ids of the webviews the messenger can still reach, or nothing when it
 * cannot say (then every panel is taken as there). The messenger drops a
 * panel's webview when the panel is disposed.
 */
function liveWebviewIds(messenger: GlspVscodeConnector['messenger']): Set<string> | undefined {
    try {
        const info = (messenger as { diagnosticApi?: () => { extensionInfo(): { webviews: Array<{ id: string }> } } })
            .diagnosticApi?.()
            .extensionInfo();
        return info ? new Set(info.webviews.map(webview => webview.id)) : undefined;
    } catch {
        return undefined;
    }
}

function webviewIdOf(participant: MessageParticipant): string | undefined {
    const id = (participant as { webviewId?: unknown }).webviewId;
    return typeof id === 'string' ? id : undefined;
}

function isLive(participant: MessageParticipant, live: Set<string>): boolean {
    const id = webviewIdOf(participant);
    return id === undefined || live.has(id);
}

function sameParticipant(a: MessageParticipant, b: MessageParticipant): boolean {
    const ida = webviewIdOf(a);
    return ida !== undefined ? ida === webviewIdOf(b) : a === b;
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
    // The panels that have spoken for each file, the last to speak last. A
    // file can have two diagram editors, each with its panel: a reply goes to
    // the one that spoke last, and to the other once that one has closed. One
    // panel per file was kept, and a reply after its editor closed went to a
    // webview that was gone, while the editor left open heard nothing.
    const participantsByUri = new Map<string, MessageParticipant[]>();
    let messenger: GlspVscodeConnector['messenger'] | undefined;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    /** The panel of `uri` to reply to: the last to speak whose webview is still there. */
    const participantFor = (uri: string): MessageParticipant | undefined => {
        const participants = participantsByUri.get(uri);
        if (!messenger || !participants || participants.length === 0) {
            return undefined;
        }
        const live = liveWebviewIds(messenger);
        const alive = live ? participants.filter(participant => isLive(participant, live)) : participants;
        if (alive.length === 0) {
            participantsByUri.delete(uri);
            return undefined;
        }
        if (alive.length !== participants.length) {
            participantsByUri.set(uri, alive);
        }
        return alive[alive.length - 1];
    };

    const sink: ChatMessageSink = (uri, payload) => {
        const participant = participantFor(uri);
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
            // The messenger API discards the listener's Disposable by design, so
            // it can't be unregistered — ignore inbound messages after dispose().
            if (disposed) {
                return;
            }
            const uri = typeof env?.data?.workflowUri === 'string' && env.data.workflowUri.length > 0
                ? env.data.workflowUri
                : fallbackUri();
            if (!uri) {
                opts.log(`chat message '${env?.type}' dropped: no workflow URI resolvable`);
                return;
            }
            const others = (participantsByUri.get(uri) ?? []).filter(participant => !sameParticipant(participant, sender));
            participantsByUri.set(uri, [...others, sender]);
            void runtime.handleMessage(uri, { type: env.type, data: env.data });
        });
        opts.log('chat transport wired to GLSP connector (vscode-messenger)');
    };

    return {
        sink,
        canReach: (uri) => participantFor(uri) !== undefined,
        connect(runtime): void {
            wire(runtime);
        },
        dispose(): void {
            disposed = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            participantsByUri.clear();
        }
    };
}
