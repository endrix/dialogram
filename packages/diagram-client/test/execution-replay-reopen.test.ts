/**
 * Task 4 — bounded execution-event replay for reopened webviews.
 *
 * Production topology: the REAL host-side {@link ExecutionOverlayRegistry} ring
 * buffer + the REAL {@link forwardExecutionOverlayEvents} bridge envelope + the
 * REAL client folding chain (canonical {@link DiagramWebviewChannel}, the
 * execution-overlay routing, and {@link RunAgentStreamActionHandler}). No
 * idealized stubs: a batch emitted on the registry is forwarded through the
 * bridge, wrapped as an `actionMessage` notification, dispatched on the webview
 * `window`, routed by the channel and folded by the real handler — exactly the
 * live wire.
 *
 * The "close + reopen mid-run" gap: the host bridge is zero-copy pass-through and
 * the bar's folded state is a client-only static Map lost with the webview, so a
 * webview reopened mid-run came back EMPTY. The ring buffer replays the current
 * run's window through the same bridge on (re)registration; because the client's
 * folding is deterministic and re-playable from `run.started` (the SSE run stream
 * already replays full history on every reconnect), re-folding the replayed
 * window reproduces the never-closed bar state byte for byte.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Messenger } from 'vscode-messenger-webview';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';
import { DiagramWebviewChannel } from '../src/webview-channel';
import {
    installExecutionOverlayRouting,
    __resetOverlayRoutingForTests
} from '../src/execution-overlay-message-bridge';
import { ExecutionOverlayRegistry } from '../../extension-core/src/extension/diagram/execution-overlay';
import {
    forwardExecutionOverlayEvents,
    type ExecutionOverlayWebviewSink
} from '../../extension-core/src/extension/diagram/execution-overlay-bridge';

const SOURCE_URI = 'file:///w/smoke_workflow.py';
const CLIENT_ID = 'workflow_0';
const HOST_SENDER = { type: 'extension' } as const;
const WEBVIEW_RECEIVER = { type: 'webview', webviewId: 'w1' } as const;

/** The 13-event fake-run script shape (mirrors the smoke run-server). */
function runScript(): Array<Record<string, unknown>> {
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

function actionMessageNotification(action: unknown): Record<string, unknown> {
    return {
        method: 'actionMessage',
        sender: HOST_SENDER,
        receiver: WEBVIEW_RECEIVER,
        params: { clientId: CLIENT_ID, action }
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

/**
 * The host bridge sink: every forwarded batch is delivered onto the CURRENT
 * webview `window` as a live `actionMessage` notification — the same envelope
 * live emission uses. Reading the global at call time means a reopened webview
 * (a fresh `window`) receives batches sent after it registers.
 */
const sink: ExecutionOverlayWebviewSink = {
    sendMessageToClient: (_clientId, message) => {
        postToWebview(actionMessageNotification(message.action));
    }
};

/** Mount a fresh webview: new `window`, real Messenger + channel + overlay routing. */
function openWebview(): void {
    __resetOverlayRoutingForTests();
    RunAgentStreamActionHandler.reset();
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const messenger = new Messenger(fakeVscodeApi() as never);
    messenger.start();
    const channel = new DiagramWebviewChannel(messenger as never);
    installExecutionOverlayRouting(channel);
}

interface AgentSnapshot {
    instance: string;
    text: string;
    reasoning: string;
    status: string;
    toolCalls: string[];
}

interface BarSnapshot {
    runActive: boolean;
    agents: AgentSnapshot[];
}

/** Deterministic snapshot of the folded bar state (sorted; order-independent). */
function barSnapshot(): BarSnapshot {
    return {
        runActive: RunAgentStreamActionHandler.isRunActive(),
        agents: RunAgentStreamActionHandler.getAgents()
            .slice()
            .sort((a, b) => a.instance.localeCompare(b.instance))
            .map(a => ({
                instance: a.instance,
                text: a.text,
                reasoning: a.reasoning,
                status: a.status,
                toolCalls: [...a.toolCalls]
            }))
    };
}

describe('bounded execution-event replay on webview reopen (production topology)', () => {
    let registry: ExecutionOverlayRegistry;
    let liveSub: { dispose(): void };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registry = new ExecutionOverlayRegistry();
        // Host bridge: live emission → same envelope → webview.
        liveSub = registry.onDidEmitEvents((uri, events) =>
            forwardExecutionOverlayEvents(sink, CLIENT_ID, uri, events)
        );
    });

    afterEach(() => {
        liveSub.dispose();
        RunAgentStreamActionHandler.reset();
        __resetOverlayRoutingForTests();
        delete (globalThis as { window?: EventTarget }).window;
        vi.restoreAllMocks();
    });

    it('(a) reopened webview mid-run folds to the SAME bar state as the never-closed webview', () => {
        const script = runScript();
        const midRun = script.slice(0, 10); // through writer's first tool_call; run still active

        // Never-closed webview: receives the mid-run events live (two batches, as the driver flushes).
        openWebview();
        registry.emitEvents(SOURCE_URI, midRun.slice(0, 7));
        registry.emitEvents(SOURCE_URI, midRun.slice(7));
        const neverClosed = barSnapshot();

        // Sanity: the never-closed bar is actually mid-run and populated.
        expect(neverClosed.runActive).toBe(true);
        expect(neverClosed.agents.map(a => a.instance)).toEqual(['reader', 'writer']);
        expect(neverClosed.agents.find(a => a.instance === 'reader')!.text).toBe('hello world');
        expect(neverClosed.agents.find(a => a.instance === 'writer')!.toolCalls).toEqual(['write_file']);

        // Close + reopen: fresh webview module (static Map + routing gone), then the
        // host drains the ring buffer through the SAME bridge on (re)registration.
        openWebview();
        const replay = registry.replayEvents(SOURCE_URI);
        forwardExecutionOverlayEvents(sink, CLIENT_ID, SOURCE_URI, replay);
        const reopened = barSnapshot();

        expect(reopened).toEqual(neverClosed);
    });

    it('(b) overflow keeps the run.started-anchored oldest window bounded by the replay limit', () => {
        openWebview();
        const big: Array<Record<string, unknown>> = [{ seq: 0, type: 'run.started' }];
        for (let i = 1; i <= 400; i += 1) {
            big.push({ seq: i, type: 'agent.message.delta', instance: 'x', delta: 'z' });
        }
        registry.emitEvents(SOURCE_URI, big);

        const replay = registry.replayEvents(SOURCE_URI);
        // Bounded, and the run.started anchor is retained as the first entry.
        expect(replay.length).toBeLessThanOrEqual(256);
        expect(replay.length).toBe(256);
        expect((replay[0] as { type?: string }).type).toBe('run.started');

        // Client folding stays correct: the anchor sets runActive and the agent
        // accumulates the retained deltas — no crash, runActive true.
        openWebview();
        forwardExecutionOverlayEvents(sink, CLIENT_ID, SOURCE_URI, replay);
        const snap = barSnapshot();
        expect(snap.runActive).toBe(true);
        expect(snap.agents).toHaveLength(1);
        expect(snap.agents[0].instance).toBe('x');
        // 255 retained deltas of 'z' after the run.started anchor.
        expect(snap.agents[0].text).toBe('z'.repeat(255));
    });

    it('(b-evidence) a window WITHOUT run.started leaves runActive false — why the anchor must be kept', () => {
        // This is the exact failure the newest-256 (ring, anchor-dropping) policy
        // would cause: no run.started in the window → runActive never set true →
        // the reopened bar diverges from the never-closed (mid-run) case.
        openWebview();
        forwardExecutionOverlayEvents(sink, CLIENT_ID, SOURCE_URI, [
            { seq: 5, type: 'agent.message.delta', instance: 'x', delta: 'tail' }
        ]);
        expect(RunAgentStreamActionHandler.isRunActive()).toBe(false);
    });

    it('(c) a fresh run.started resets the buffer — replay carries only the current run', () => {
        openWebview();
        // First run, fully played out.
        registry.emitEvents(SOURCE_URI, runScript());
        // A brand-new run starts; its run.started must reset the window.
        registry.emitEvents(SOURCE_URI, [
            { seq: 1, type: 'run.started' },
            { seq: 2, type: 'agent.message.start', instance: 'solo' },
            { seq: 3, type: 'agent.message.delta', instance: 'solo', delta: 'again' }
        ]);

        const replay = registry.replayEvents(SOURCE_URI);
        expect((replay[0] as { type?: string }).type).toBe('run.started');
        expect(replay).toHaveLength(3);
        expect(replay.some(e => (e as { instance?: string }).instance === 'reader')).toBe(false);

        openWebview();
        forwardExecutionOverlayEvents(sink, CLIENT_ID, SOURCE_URI, replay);
        const snap = barSnapshot();
        expect(snap.runActive).toBe(true);
        expect(snap.agents.map(a => a.instance)).toEqual(['solo']);
        expect(snap.agents[0].text).toBe('again');
    });

    it('(d) a fresh source URI has an empty buffer — nothing is replayed, no send', () => {
        openWebview();
        const replay = registry.replayEvents('file:///never/seen.py');
        expect(replay).toEqual([]);

        // The host drain must short-circuit on an empty window (no bridge send).
        let sends = 0;
        const countingSink: ExecutionOverlayWebviewSink = {
            sendMessageToClient: () => { sends += 1; }
        };
        if (replay.length > 0) {
            forwardExecutionOverlayEvents(countingSink, CLIENT_ID, 'file:///never/seen.py', replay);
        }
        expect(sends).toBe(0);
    });

    it('replayEvents returns a copy — mutating the window does not corrupt the buffer', () => {
        openWebview();
        registry.emitEvents(SOURCE_URI, [{ seq: 1, type: 'run.started' }]);
        const first = registry.replayEvents(SOURCE_URI);
        first.push({ seq: 99, type: 'agent.message.delta', instance: 'x', delta: 'leak' });
        expect(registry.replayEvents(SOURCE_URI)).toHaveLength(1);
    });

    it('the replayed batch carries the canonical overlay envelope (kind + sourceUri)', () => {
        openWebview();
        registry.emitEvents(SOURCE_URI, runScript().slice(0, 3));

        const captured: Array<Record<string, unknown>> = [];
        const capturingSink: ExecutionOverlayWebviewSink = {
            sendMessageToClient: (_id, message) => captured.push(message.action as Record<string, unknown>)
        };
        forwardExecutionOverlayEvents(capturingSink, CLIENT_ID, SOURCE_URI, registry.replayEvents(SOURCE_URI));

        expect(captured).toHaveLength(1);
        expect(captured[0].kind).toBe(EXECUTION_OVERLAY_ACTION_KIND);
        expect(captured[0].sourceUri).toBe(SOURCE_URI);
        expect((captured[0].events as unknown[]).length).toBe(3);
    });
});
