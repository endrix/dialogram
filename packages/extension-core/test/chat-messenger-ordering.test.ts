/**
 * Host half of the chat "disconnected" race, retargeted at the unified
 * transport: the messenger listener MUST be installed at connect() time —
 * before any ACP/opencode spawn — so a webview that posts `chat.ready`
 * immediately still reaches the runtime. Replies are routed per-URI to the
 * panel that owns the document, not to "whoever spoke last".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlspChatTransport } from '../src/extension/chat/glsp-chat-transport';

afterEach(() => {
    vi.useRealTimers();
});

function makeMessenger() {
    const handlers = new Map<string, (env: any, sender: any) => void>();
    return {
        onNotification: vi.fn((type: { method: string }, fn: any) => handlers.set(type.method, fn)),
        sendNotification: vi.fn(),
        emitToHost(env: any, sender: any) {
            handlers.get('dialogram/chat/toHost')!(env, sender);
        }
    };
}

describe('GlspChatTransport', () => {
    it('wires the toHost listener on connect and forwards with the workflowUri', async () => {
        const messenger = makeMessenger();
        const transport = createGlspChatTransport({
            getConnector: () => ({ messenger }) as any,
            log: () => undefined
        });
        const handleMessage = vi.fn(async () => undefined);
        transport.connect({ handleMessage });

        expect(messenger.onNotification).toHaveBeenCalled(); // listener installed before any ACP work

        messenger.emitToHost(
            { type: 'chat.ready', data: { workflowUri: 'file:///ws/a.py' } },
            { webviewId: 'panel-a' }
        );
        expect(handleMessage).toHaveBeenCalledWith('file:///ws/a.py', {
            type: 'chat.ready',
            data: { workflowUri: 'file:///ws/a.py' }
        });
        transport.dispose();
    });

    it('replies per-URI to the panel that owns the document', () => {
        const messenger = makeMessenger();
        const transport = createGlspChatTransport({
            getConnector: () => ({ messenger }) as any,
            log: () => undefined
        });
        transport.connect({ handleMessage: async () => undefined });

        messenger.emitToHost({ type: 'chat.ready', data: { workflowUri: 'file:///ws/a.py' } }, { webviewId: 'panel-a' });
        messenger.emitToHost({ type: 'chat.ready', data: { workflowUri: 'file:///ws/b.py' } }, { webviewId: 'panel-b' });

        transport.sink('file:///ws/a.py', { type: 'chat.turnEnd', data: {} });
        expect(messenger.sendNotification).toHaveBeenLastCalledWith(
            expect.objectContaining({ method: 'dialogram/chat/toClient' }),
            { webviewId: 'panel-a' },
            { type: 'chat.turnEnd', data: {} }
        );
        transport.dispose();
    });

    it('retries while the connector is not yet registered', async () => {
        vi.useFakeTimers();
        const messenger = makeMessenger();
        let connector: any;
        const transport = createGlspChatTransport({
            getConnector: () => connector,
            log: () => undefined
        });
        transport.connect({ handleMessage: async () => undefined });
        expect(messenger.onNotification).not.toHaveBeenCalled();
        connector = { messenger };
        await vi.advanceTimersByTimeAsync(300);
        expect(messenger.onNotification).toHaveBeenCalled();
        vi.useRealTimers();
        transport.dispose();
    });
});
