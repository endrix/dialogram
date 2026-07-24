/**
 * ACP → webview event forwarding for the unified chat runtime, with the
 * legacy handler's chunk coalescing: opencode emits one notification per
 * token, and each becomes a postMessage → a webview re-render. Chunk text is
 * buffered and flushed on a short timer (50 ms), so panels render far less
 * often during a turn. Non-chunk updates, kind/session switches and turn end
 * flush first to preserve ordering.
 */
import type { ChatPayload } from '../../api';

export interface AcpEmitterLike {
    on(event: string, fn: (...a: any[]) => void): any;
    off(event: string, fn: (...a: any[]) => void): any;
}

export interface AcpEventSinks {
    postToSession(sessionId: string, payload: ChatPayload): void;
    broadcast(payload: ChatPayload): void;
    /** Invoked AFTER buffered chunks are flushed; the runtime persists the
     *  reply, posts `chat.turnEnd` and refreshes live message ids. */
    onTurnComplete(data: { sessionId: string; text?: string; thinking?: string; model?: string }): void;
}

const CHUNK_FLUSH_MS = 50;

export function attachAcpEventForwarding(acp: AcpEmitterLike, sinks: AcpEventSinks): () => void {
    let chunkBuffer: { sessionId: any; kind: string; text: string } | null = null;
    let flushTimer: NodeJS.Timeout | undefined;

    const flushChunks = () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
        if (!chunkBuffer) {
            return;
        }
        const b = chunkBuffer;
        chunkBuffer = null;
        sinks.postToSession(String(b.sessionId), {
            type: 'chat.sessionUpdate',
            data: {
                notification: {
                    sessionId: b.sessionId,
                    update: { sessionUpdate: b.kind, content: { type: 'text', text: b.text } }
                }
            }
        });
    };

    const onSessionUpdate = (notification: any) => {
        const update = notification?.update;
        const kind = update?.sessionUpdate;
        const content = update?.content;
        const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined;
        if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && text !== undefined) {
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
        flushChunks();
        const sessionId = notification?.sessionId;
        if (sessionId) {
            sinks.postToSession(String(sessionId), { type: 'chat.sessionUpdate', data: { notification } });
        }
    };

    const scoped = (type: string) => (data: any) => {
        const payload: ChatPayload = { type, data };
        if (data?.sessionId) {
            sinks.postToSession(String(data.sessionId), payload);
        } else {
            sinks.broadcast(payload);
        }
    };
    const onModeChanged = scoped('chat.modeChanged');
    const onProviderChanged = scoped('chat.providerChanged');
    const onTurnComplete = (data: any) => {
        flushChunks();
        sinks.onTurnComplete(data);
    };
    const onPermissionRequest = (data: any) => sinks.broadcast({ type: 'chat.permissionRequest', data });
    const onConnected = () => sinks.broadcast({ type: 'chat.connectionStatus', data: { connected: true } });
    const onDisconnected = () =>
        sinks.broadcast({ type: 'chat.connectionStatus', data: { connected: false, reason: 'opencode disconnected' } });
    const onError = (err: any) =>
        sinks.broadcast({ type: 'chat.error', data: { message: err?.message ?? String(err) } });

    acp.on('sessionUpdate', onSessionUpdate);
    acp.on('modeChanged', onModeChanged);
    acp.on('providerChanged', onProviderChanged);
    acp.on('turnComplete', onTurnComplete);
    acp.on('permissionRequest', onPermissionRequest);
    acp.on('connected', onConnected);
    acp.on('disconnected', onDisconnected);
    acp.on('error', onError);

    return () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
        chunkBuffer = null;
        acp.off('sessionUpdate', onSessionUpdate);
        acp.off('modeChanged', onModeChanged);
        acp.off('providerChanged', onProviderChanged);
        acp.off('turnComplete', onTurnComplete);
        acp.off('permissionRequest', onPermissionRequest);
        acp.off('connected', onConnected);
        acp.off('disconnected', onDisconnected);
        acp.off('error', onError);
    };
}
