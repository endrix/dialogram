/**
 * Node states published on the host, drawn on the diagram.
 *
 * Nothing drew a published state before: the client folded the overlay's
 * events into the running-agents bar and ignored its `states`. Pinned here:
 *
 *  - the live wire, end to end (the real registry, bridge envelope, webview
 *    channel and stream handler): a published set is the set shown, an empty
 *    one shows none, and a batch of events alone leaves the states alone;
 *  - the drawing is the run overlay's own classes, so a state looks like a
 *    run and the node views need nothing new, and the views do read those
 *    classes;
 *  - a state finds its node by the producer's id (`wf:graphNodeId`) as well
 *    as by the diagram's, since the diagram names a node after its label:
 *    matching on the diagram's id alone painted nothing a producer named;
 *  - the classes go on as GLSP feedback, matched against each model it is
 *    applied to, which the dispatcher does for every model the server sends;
 *    a new set withdraws the old one's first, and a set that arrived before
 *    the diagram had a model is drawn once it has one.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Messenger } from 'vscode-messenger-webview';
import type { ExecutionNodeState } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';
import { DiagramWebviewChannel } from '../src/webview-channel';
import {
    ExecutionOverlayMessageBridge,
    installExecutionOverlayRouting,
    __resetOverlayRoutingForTests
} from '../src/execution-overlay-message-bridge';
import {
    EXECUTION_STATUS_CLASS,
    ExecutionStatesFeedbackAction,
    ExecutionStatesFeedbackCommand,
    applyExecutionStates,
    showExecutionStates,
    shownExecutionStates,
    __resetExecutionStatesForTests
} from '../src/execution-states';
import { ExecutionOverlayRegistry } from '../../extension-core/src/extension/diagram/execution-overlay';
import {
    forwardExecutionOverlayEvents,
    forwardExecutionOverlayStates,
    type ExecutionOverlayWebviewSink
} from '../../extension-core/src/extension/diagram/execution-overlay-bridge';

const SOURCE_URI = 'file:///spec/docs/pipeline.md';
const CLIENT_ID = 'workflow_0';

const STATES: ExecutionNodeState[] = [
    { nodeId: 'node:scope:root:A-001', status: 'failed', detail: 'unverified' },
    { nodeId: 'node:scope:root:A-002', status: 'succeeded' },
    { nodeId: 'node:scope:root:Q-001', status: 'running' },
    { nodeId: 'node:scope:root:I-001', status: 'idle' }
];

/** Each forwarded action arrives on the webview `window` as an `actionMessage` notification. */
const sink: ExecutionOverlayWebviewSink = {
    sendMessageToClient: (_clientId, message) => {
        (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new MessageEvent('message', {
            data: {
                method: 'actionMessage',
                sender: { type: 'extension' },
                receiver: { type: 'webview', webviewId: 'w1' },
                params: { clientId: CLIENT_ID, action: message.action }
            }
        }));
    }
};

function openWebview(): void {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const messenger = new Messenger({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined } as never);
    messenger.start();
    installExecutionOverlayRouting(new DiagramWebviewChannel(messenger as never));
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    __resetExecutionStatesForTests();
    __resetOverlayRoutingForTests();
    RunAgentStreamActionHandler.reset();
});

afterEach(() => {
    __resetExecutionStatesForTests();
    __resetOverlayRoutingForTests();
    RunAgentStreamActionHandler.reset();
    delete (globalThis as { window?: EventTarget }).window;
    vi.restoreAllMocks();
});

describe('published states on the live wire', () => {
    it('are the states the diagram shows, and an empty set shows none', () => {
        openWebview();
        const registry = new ExecutionOverlayRegistry();
        registry.onDidChange(uri => forwardExecutionOverlayStates(sink, CLIENT_ID, uri, registry.get(uri)));

        registry.publish(SOURCE_URI, STATES);
        expect(shownExecutionStates()).toEqual(STATES);

        registry.publish(SOURCE_URI, []);
        expect(shownExecutionStates()).toEqual([]);
    });

    it('are left alone by a batch of run events, which still reaches the bar', () => {
        openWebview();
        showExecutionStates(STATES);

        forwardExecutionOverlayEvents(sink, CLIENT_ID, SOURCE_URI, [{ seq: 1, type: 'run.started' }]);

        expect(shownExecutionStates()).toEqual(STATES);
        expect(RunAgentStreamActionHandler.isRunActive()).toBe(true);
    });
});

/** A model as the client holds it: nodes named after their labels, keeping the producer's id. */
function model() {
    const node = (id: string, producerId?: string, cssClasses: string[] = ['workflow-node']) => ({
        id,
        cssClasses: [...cssClasses],
        ...(producerId ? { args: { 'wf:graphNodeId': producerId } } : {}),
        children: [] as any[]
    });
    const contract = node('Three conditions, each with two outcomes', 'node:scope:root:A-001');
    const verified = node('A trap is a halt', 'node:scope:root:A-002');
    const question = node('Q-001: what does it do', 'node:scope:root:Q-001');
    const plain = node('Informative prose', 'node:scope:root:I-001');
    const byLabel = node('legacy-instance');
    const group = { id: 'scope:group:L1', cssClasses: ['group'], children: [contract, verified] };
    const root = { id: 'graph', children: [group, question, plain, byLabel] };
    return { root, contract, verified, question, plain, byLabel };
}

describe('how a state is drawn', () => {
    it('with the class a run draws the same state with, and nothing for idle', () => {
        expect(EXECUTION_STATUS_CLASS).toEqual({
            idle: undefined,
            running: 'cal-node-active',
            succeeded: 'cal-node-finished',
            failed: 'cal-node-error'
        });
    });

    it('on the node the producer named, wherever it sits, the node’s own classes kept', () => {
        const { root, contract, verified, question, plain } = model();

        const changed = applyExecutionStates(root, STATES);

        expect(changed).toEqual([contract.id, verified.id, question.id]);
        expect(contract.cssClasses).toEqual(['workflow-node', 'cal-node-error']);
        expect(verified.cssClasses).toEqual(['workflow-node', 'cal-node-finished']);
        expect(question.cssClasses).toEqual(['workflow-node', 'cal-node-active']);
        expect(plain.cssClasses).toEqual(['workflow-node']);
    });

    it('on a node named by the diagram’s own id too', () => {
        const { root, byLabel } = model();

        applyExecutionStates(root, [{ nodeId: 'legacy-instance', status: 'running' }]);

        expect(byLabel.cssClasses).toEqual(['workflow-node', 'cal-node-active']);
    });

    it('once, however often it is applied, and taken off by the same states', () => {
        const { root, contract } = model();

        applyExecutionStates(root, STATES);
        applyExecutionStates(root, STATES);
        expect(contract.cssClasses).toEqual(['workflow-node', 'cal-node-error']);

        applyExecutionStates(root, STATES, true);
        expect(contract.cssClasses).toEqual(['workflow-node']);
    });

    it('takes off only what the states put on: a class a live run gave the node stays', () => {
        const { root, contract } = model();
        contract.cssClasses = ['workflow-node', 'cal-node-error'];

        applyExecutionStates(root, STATES);
        applyExecutionStates(root, STATES, true);
        expect(contract.cssClasses).toEqual(['workflow-node', 'cal-node-error']);
    });

    /** What the feedback dispatcher does with it after each model the server sends. */
    it('by a feedback command that paints the model it is given', () => {
        const { root, verified } = model();
        const command = new ExecutionStatesFeedbackCommand(ExecutionStatesFeedbackAction.create(STATES));

        expect(command.execute({ root } as any)).toBe(root);
        expect(verified.cssClasses).toContain('cal-node-finished');
    });

    it('through classes the node views turn into the ring, the green and the red', () => {
        const views = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/views.ts'), 'utf8');
        for (const cssClass of Object.values(EXECUTION_STATUS_CLASS).filter(Boolean)) {
            expect(views).toContain(`cssClasses.includes('${cssClass}')`);
        }
    });
});

describe('the feedback that draws them', () => {
    /** A feedback dispatcher that records what is registered and what each withdrawal dispatches. */
    function fakeFeedback() {
        const log: Array<{ op: 'register' | 'cleanup'; actions: unknown[] }> = [];
        return {
            log,
            registerFeedback: (_emitter: unknown, actions: unknown[], cleanup: unknown[]) => {
                log.push({ op: 'register', actions });
                return { dispose: () => log.push({ op: 'cleanup', actions: cleanup }) };
            }
        };
    }

    function startBridge(feedback: ReturnType<typeof fakeFeedback>): void {
        const bridge = new ExecutionOverlayMessageBridge();
        Object.assign(bridge, { actionDispatcher: { dispatch: () => undefined }, feedbackDispatcher: feedback });
        bridge.postModelInitialization();
    }

    it('withdraws the old set before registering the new one, and registers nothing for none', () => {
        const feedback = fakeFeedback();
        startBridge(feedback);

        showExecutionStates([{ nodeId: 'a', status: 'failed' }]);
        showExecutionStates([{ nodeId: 'b', status: 'succeeded' }]);
        showExecutionStates([]);

        const a = [{ nodeId: 'a', status: 'failed' as const }];
        const b = [{ nodeId: 'b', status: 'succeeded' as const }];
        expect(feedback.log).toEqual([
            { op: 'register', actions: [{ kind: ExecutionStatesFeedbackAction.KIND, states: a }] },
            { op: 'cleanup', actions: [{ kind: ExecutionStatesFeedbackAction.KIND, states: a, remove: true }] },
            { op: 'register', actions: [{ kind: ExecutionStatesFeedbackAction.KIND, states: b }] },
            { op: 'cleanup', actions: [{ kind: ExecutionStatesFeedbackAction.KIND, states: b, remove: true }] }
        ]);
    });

    /** A reopened editor gets its states replayed on registration, before its first model. */
    it('draws a set that arrived before the diagram had a model, once it has one', () => {
        showExecutionStates([{ nodeId: 'a', status: 'running' }]);
        const feedback = fakeFeedback();

        startBridge(feedback);

        expect(feedback.log).toEqual([
            { op: 'register', actions: [{ kind: ExecutionStatesFeedbackAction.KIND, states: [{ nodeId: 'a', status: 'running' }] }] }
        ]);
    });
});
