/**
 * DiagramWebviewChannel — first-class handler composition, on a REAL
 * `vscode-messenger-webview` `Messenger` and the real notification wire
 * envelope.
 *
 * This is the canonical successor to the round-6 `installActionMessageRouting`
 * monkey-patch. `vscode-messenger`'s `onNotification` is last-write-wins
 * (`handlerRegistry.set`), so a later registration silently REPLACES an earlier
 * one — the exact race that killed the RunningAgentsBar. The channel owns ONE
 * real handler per method and fans out to every registered handler in order,
 * and it interposes on the wrapped messenger's `onNotification` so even a direct
 * `messenger.onNotification(...)` call (GLSP's `WebviewGlspClient` does exactly
 * this, late) COMPOSES instead of replacing.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Messenger } from 'vscode-messenger-webview';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import {
    DiagramWebviewChannel,
    installDiagramWebviewChannel,
    getDiagramWebviewChannel,
    __resetDiagramWebviewChannelForTests
} from '../src/webview-channel';

const WEBVIEW_RECEIVER = { type: 'webview', webviewId: 'w1' } as const;
const HOST_SENDER = { type: 'extension' } as const;

function notification(method: string, params: unknown): Record<string, unknown> {
    return { method, sender: HOST_SENDER, receiver: WEBVIEW_RECEIVER, params };
}

function actionMessage(action: unknown): Record<string, unknown> {
    return notification('actionMessage', { clientId: 'workflow_0', action });
}

function postToWebview(message: unknown): void {
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(
        new MessageEvent('message', { data: message })
    );
}

function fakeVscodeApi(): { postMessage(): void; getState(): void; setState(): void } {
    return { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
}

/** A started messenger over a fake api + a channel wrapping it. */
function makeChannel(): { channel: DiagramWebviewChannel; messenger: Messenger } {
    const messenger = new Messenger(fakeVscodeApi() as never);
    messenger.start();
    const channel = new DiagramWebviewChannel(messenger as never);
    return { channel, messenger };
}

describe('DiagramWebviewChannel — first-class handler composition', () => {
    beforeEach(() => {
        (globalThis as { window?: EventTarget }).window = new EventTarget();
        __resetDiagramWebviewChannelForTests();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        delete (globalThis as { window?: EventTarget }).window;
        __resetDiagramWebviewChannelForTests();
        vi.restoreAllMocks();
    });

    it('(a) two actionMessage handlers both fire, in registration order', () => {
        const { channel } = makeChannel();
        const order: string[] = [];
        channel.onNotification('actionMessage', () => order.push('first'));
        channel.onNotification('actionMessage', () => order.push('second'));

        postToWebview(actionMessage({ kind: 'setModel' }));

        expect(order).toEqual(['first', 'second']);
    });

    it('(b) round-6 race: a LATE direct messenger.onNotification composes, never replaces', () => {
        const { channel, messenger } = makeChannel();
        const seen: string[] = [];

        // Overlay-style handler registered FIRST, through the channel API.
        channel.onNotification('actionMessage', () => seen.push('overlay'));
        // GLSP's WebviewGlspClient registers its stock handler LATER, directly on
        // the messenger (bypassing the channel API). Under naive last-write-wins
        // this replaces the overlay route and it goes dark.
        messenger.onNotification({ method: 'actionMessage' }, () => seen.push('stock'));
        // The round-5 killer: a SECOND late re-registration.
        messenger.onNotification({ method: 'actionMessage' }, () => seen.push('stock2'));

        postToWebview(actionMessage({ kind: 'anything' }));

        // ALL three fire, in order; nothing was replaced.
        expect(seen).toEqual(['overlay', 'stock', 'stock2']);
    });

    it('(c) chat toClient + overlay action kinds coexist on the one channel', () => {
        const { channel } = makeChannel();
        const got: string[] = [];
        channel.onActionKind(EXECUTION_OVERLAY_ACTION_KIND, () => got.push('overlay'));
        channel.onNotification('dialogram/chat/toClient', (p) => got.push(`chat:${(p as { type?: string }).type}`));

        postToWebview(actionMessage({ kind: EXECUTION_OVERLAY_ACTION_KIND, events: [] }));
        postToWebview(notification('dialogram/chat/toClient', { type: 'chat.connectionStatus', data: {} }));
        // An overlay kind must NOT leak into a foreign-kind action handler.
        postToWebview(actionMessage({ kind: 'setModel' }));

        expect(got).toEqual(['overlay', 'chat:chat.connectionStatus']);
    });

    it('(d) unsubscribe stops a handler without disturbing its siblings', () => {
        const { channel } = makeChannel();
        const hits: string[] = [];
        const keep = channel.onNotification('actionMessage', () => hits.push('keep'));
        const sub = channel.onNotification('actionMessage', () => hits.push('drop'));

        postToWebview(actionMessage({ kind: 'k' }));
        sub.dispose();
        postToWebview(actionMessage({ kind: 'k' }));

        expect(hits).toEqual(['keep', 'drop', 'keep']);
        expect(keep).toBeTruthy();
    });

    it('(f) disposing one of two identical handler functions removes only its registration', () => {
        const { channel } = makeChannel();
        const hits: string[] = [];
        // Register the SAME function reference twice — dispose must remove the
        // specific registration instance, not the first-by-value.
        const shared = () => hits.push('shared');
        const subA = channel.onNotification('actionMessage', shared);
        channel.onNotification('actionMessage', shared);

        postToWebview(actionMessage({ kind: 'k' }));
        subA.dispose();
        postToWebview(actionMessage({ kind: 'k' }));

        // First delivery: both fire (2). After disposing one: one remains (1).
        expect(hits).toEqual(['shared', 'shared', 'shared']);
    });

    it('(g) installDiagramWebviewChannel is idempotent — a second install reuses the channel', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();

        const first = installDiagramWebviewChannel(messenger as never);
        const second = installDiagramWebviewChannel(messenger as never);

        expect(second).toBe(first);
        expect(warn).toHaveBeenCalled();

        // Composition still fires exactly once (no double-wrapped dispatch).
        const hits: string[] = [];
        first.onNotification('actionMessage', () => hits.push('x'));
        postToWebview(actionMessage({ kind: 'k' }));
        expect(hits).toEqual(['x']);
    });

    it('(e) exactly one messenger/acquire across repeated channel access; start is idempotent', () => {
        let acquireCount = 0;
        const acquire = () => {
            acquireCount++;
            return fakeVscodeApi();
        };

        // Production wiring: acquireVsCodeApi() runs ONCE to build the one messenger.
        const messenger = new Messenger(acquire() as never);
        messenger.start();
        const installed = installDiagramWebviewChannel(messenger as never);

        // Repeated channel access spawns no new messenger and no new acquisition.
        expect(getDiagramWebviewChannel()).toBe(installed);
        expect(getDiagramWebviewChannel()).toBe(installed);
        expect(installed.rawMessenger).toBe(messenger);
        expect(acquireCount).toBe(1);

        // Fan-out fires once per delivery even after repeated start() calls
        // (Messenger.start is internally guarded → one window listener).
        const hits: string[] = [];
        installed.onNotification('actionMessage', () => hits.push('x'));
        installed.start();
        getDiagramWebviewChannel()!.start();
        getDiagramWebviewChannel()!.start();

        postToWebview(actionMessage({ kind: 'k' }));
        expect(hits).toEqual(['x']);
    });
});
