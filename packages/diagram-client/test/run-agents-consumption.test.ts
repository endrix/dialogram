/**
 * Client-side consumption regression tests for the "Running agents" bar channel.
 *
 * Round 6 pins the registration-order race. `vscode-messenger`'s
 * `onNotification` is last-write-wins (`handlerRegistry.set`), so a stock
 * `actionMessage` registration landing AFTER a wrapper REPLACES it and the
 * client-only routing vanishes (overlay then dropped by GLSP's clientId-scoped
 * filter). This is now pinned by {@link DiagramWebviewChannel}'s first-class
 * composition: the channel owns ONE real `actionMessage` handler and fans out to
 * every registered handler in order, and it interposes on the wrapped
 * messenger's `onNotification` so a direct GLSP registration composes too —
 * verified here on a REAL `vscode-messenger-webview` `Messenger`, in every
 * registration order including a post-install re-registration (the exact live
 * failure).
 *
 * See .superpowers/sdd/bar-channel-debug-report.md and webview-channel.ts.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Messenger } from 'vscode-messenger-webview';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';
import { DiagramWebviewChannel } from '../src/webview-channel';
import {
    installExecutionOverlayRouting,
    routableActionFromParams,
    setOverlayActionDispatcher,
    __resetOverlayRoutingForTests
} from '../src/execution-overlay-message-bridge';

/**
 * Adopt a started messenger into the canonical channel and install the
 * client-only overlay routing on it — the production wiring (starter ctor),
 * exercised end-to-end through the channel's first-class composition.
 */
function installOverlayRouting(messenger: Messenger): DiagramWebviewChannel {
    const channel = new DiagramWebviewChannel(messenger as never);
    installExecutionOverlayRouting(channel);
    return channel;
}

const WEBVIEW_RECEIVER = { type: 'webview', webviewId: 'w1' } as const;
const HOST_SENDER = { type: 'extension' } as const;

function actionMessageNotification(action: unknown): Record<string, unknown> {
    return {
        method: 'actionMessage',
        sender: HOST_SENDER,
        receiver: WEBVIEW_RECEIVER,
        params: { clientId: 'workflow_0', action }
    };
}

function postToWebview(message: unknown): void {
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(
        new MessageEvent('message', { data: message })
    );
}

function fakeVscodeApi(): { postMessage(): void; getState(): void; setState(): void } {
    return { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
}

function realRunBatch(): Array<Record<string, unknown>> {
    return [
        { seq: 1, type: 'run.started' },
        { seq: 2, type: 'agent.message.start', instance: 'reader' },
        { seq: 3, type: 'agent.message.delta', instance: 'reader', field: 'reasoning', delta: 'think ' },
        { seq: 4, type: 'agent.message.delta', instance: 'reader', delta: 'hello ' },
        { seq: 5, type: 'agent.tool_call', instance: 'reader', name: 'read_file' },
        { seq: 6, type: 'agent.message.delta', instance: 'reader', delta: 'world' },
        { seq: 7, type: 'agent.message.end', instance: 'reader' },
        { seq: 8, type: 'agent.message.start', instance: 'writer' },
        { seq: 9, type: 'agent.message.delta', instance: 'writer', delta: 'out ' },
        { seq: 10, type: 'agent.tool_call', instance: 'writer', name: 'write_file' },
        { seq: 11, type: 'agent.tool_call', instance: 'writer', name: 'commit' },
        { seq: 12, type: 'agent.message.delta', instance: 'writer', delta: 'done' },
        { seq: 13, type: 'agent.message.end', instance: 'writer' }
    ];
}

/** A stock `actionMessage` handler stand-in (WebviewGlspClient → model source). */
function stockHandler(record: unknown[]): (params: unknown) => void {
    return (params: unknown) => record.push(params);
}

describe('RunningAgentsBar channel — order-independent actionMessage routing (Round 6)', () => {
    let updates: string[];

    beforeEach(() => {
        RunAgentStreamActionHandler.reset();
        __resetOverlayRoutingForTests();
        (globalThis as { window?: EventTarget }).window = new EventTarget();
        updates = [];
        (globalThis as unknown as { window: EventTarget }).window.addEventListener(
            'dialogram.runAgents.updated',
            (ev: Event) => updates.push(ev.type)
        );
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        RunAgentStreamActionHandler.reset();
        __resetOverlayRoutingForTests();
        delete (globalThis as { window?: EventTarget }).window;
        vi.restoreAllMocks();
    });

    it('install-then-stock (production order): stock runs AND overlay routes to the handler', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        installOverlayRouting(messenger); // constructor time — before any event
        const stockCalls: unknown[] = [];
        messenger.onNotification({ method: 'actionMessage' }, stockHandler(stockCalls)); // WebviewGlspClient later

        postToWebview(actionMessageNotification({
            kind: EXECUTION_OVERLAY_ACTION_KIND,
            sourceUri: 'file:///w/wf.py',
            events: realRunBatch()
        }));

        expect(stockCalls).toHaveLength(1); // model path preserved
        expect(updates).toContain('dialogram.runAgents.updated');
        expect(RunAgentStreamActionHandler.getAgents().map(a => a.instance).sort())
            .toEqual(['reader', 'writer']);
        expect(RunAgentStreamActionHandler.getAgents().find(a => a.instance === 'reader')!.text)
            .toBe('hello world');
    });

    it('stock-then-install order also composes (adopts the pre-existing handler)', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        const stockCalls: unknown[] = [];
        messenger.onNotification({ method: 'actionMessage' }, stockHandler(stockCalls)); // stock first
        installOverlayRouting(messenger); // install adopts it

        postToWebview(actionMessageNotification({ kind: EXECUTION_OVERLAY_ACTION_KIND, events: realRunBatch() }));

        expect(stockCalls).toHaveLength(1);
        expect(updates).toContain('dialogram.runAgents.updated');
        expect(RunAgentStreamActionHandler.getAgents()).toHaveLength(2);
    });

    it('REPRODUCES + FIXES the race: a stock re-registration AFTER install still routes the overlay', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        installOverlayRouting(messenger);
        const first: unknown[] = [];
        const second: unknown[] = [];
        messenger.onNotification({ method: 'actionMessage' }, stockHandler(first));
        // The round-5 killer: a LATER re-registration. With last-write-wins this
        // would have replaced the wrapper; composition keeps routing alive.
        messenger.onNotification({ method: 'actionMessage' }, stockHandler(second));

        postToWebview(actionMessageNotification({ kind: EXECUTION_OVERLAY_ACTION_KIND, events: realRunBatch() }));

        expect(first).toHaveLength(1); // both stock handlers still run
        expect(second).toHaveLength(1);
        expect(updates).toContain('dialogram.runAgents.updated'); // overlay STILL routed
        expect(RunAgentStreamActionHandler.getAgents()).toHaveLength(2);
    });

    it('leaves server-handled kinds to the stock handler (never routed to the overlay handler)', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        installOverlayRouting(messenger);
        const stockCalls: unknown[] = [];
        messenger.onNotification({ method: 'actionMessage' }, stockHandler(stockCalls));

        postToWebview(actionMessageNotification({ kind: 'setModel', newRoot: {} }));

        expect(stockCalls).toHaveLength(1);
        expect(RunAgentStreamActionHandler.getAgents()).toHaveLength(0);
    });

    it('is idempotent: the same overlay action object delivered twice is applied once', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        installOverlayRouting(messenger);

        const msg = actionMessageNotification({
            kind: EXECUTION_OVERLAY_ACTION_KIND,
            events: [
                { seq: 1, type: 'run.started' },
                { seq: 2, type: 'agent.message.start', instance: 'reader' },
                { seq: 3, type: 'agent.message.delta', instance: 'reader', delta: 'hello' }
            ]
        });
        postToWebview(msg);
        postToWebview(msg);

        expect(RunAgentStreamActionHandler.getAgents().find(a => a.instance === 'reader')!.text)
            .toBe('hello');
    });

    it('routes showGrid to the action dispatcher once one is registered', () => {
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        installOverlayRouting(messenger);
        const dispatched: unknown[] = [];
        setOverlayActionDispatcher({ dispatch: (a: unknown) => { dispatched.push(a); } } as never);

        const grid = { kind: 'showGrid', show: true };
        postToWebview(actionMessageNotification(grid));

        expect(dispatched).toEqual([grid]);
    });

    it('routableActionFromParams accepts client-only kinds, rejects server/foreign', () => {
        const overlay = { kind: EXECUTION_OVERLAY_ACTION_KIND, events: [] };
        expect(routableActionFromParams({ clientId: 'c', action: overlay })).toBe(overlay);
        const grid = { kind: 'showGrid', show: true };
        expect(routableActionFromParams({ clientId: 'c', action: grid })).toBe(grid);
        expect(routableActionFromParams({ clientId: 'c', action: { kind: 'setModel' } })).toBeUndefined();
        expect(routableActionFromParams({ clientId: 'c' })).toBeUndefined();
        expect(routableActionFromParams(undefined)).toBeUndefined();
    });
});
