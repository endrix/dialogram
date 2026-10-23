/**
 * The node states channel of the execution overlay, host side.
 *
 * The registry held published states and the shared payload had room for
 * them, but nothing sent them anywhere, so a published state never reached a
 * diagram. Pinned here: the registry keys states through the same
 * canonicalization as the replay window (the publisher and the editor provider
 * name a diagram with different URI forms), an empty set takes them off and is
 * still a change, and the bridge sends the whole set over the ungated path, as
 * it sends events, because the kind is client-only and `dispatchAction` would
 * drop it.
 */
import { describe, expect, it } from 'vitest';
import { EXECUTION_OVERLAY_ACTION_KIND, type ExecutionNodeState } from '@dialogram/shared';
import { ExecutionOverlayRegistry } from '../src/extension/diagram/execution-overlay';
import { forwardExecutionOverlayStates } from '../src/extension/diagram/execution-overlay-bridge';
import { normalizeSourceUriKey } from '../src/extension/diagram/uri-keys';

const STATES: ExecutionNodeState[] = [
    { nodeId: 'n1', status: 'failed' },
    { nodeId: 'n2', status: 'succeeded' }
];

describe('node states in the registry', () => {
    it('are found under any form of the same URI', () => {
        const registry = new ExecutionOverlayRegistry(normalizeSourceUriKey);
        registry.publish('file:///w/My%20Spec/doc.md', STATES);

        expect(registry.get('file:///w/My Spec/doc.md')).toEqual(STATES);
    });

    it('are taken off by an empty set, which listeners still hear about', () => {
        const registry = new ExecutionOverlayRegistry();
        const heard: string[] = [];
        registry.onDidChange(uri => heard.push(uri));

        registry.publish('file:///doc.md', STATES);
        registry.publish('file:///doc.md', []);

        expect(registry.get('file:///doc.md')).toEqual([]);
        expect(heard).toEqual(['file:///doc.md', 'file:///doc.md']);
    });
});

describe('node states over the bridge', () => {
    /** The connector's two send paths: `dispatchAction` gated by the advertised kinds, the direct one not. */
    function connector() {
        const delivered: any[] = [];
        return {
            delivered,
            dispatchAction: (action: any) => (action.kind === 'advertised' ? delivered.push(action) : undefined),
            sendMessageToClient: (_clientId: string, message: any) => delivered.push(message.action)
        };
    }

    it('go to the webview as the whole set, on the ungated path', () => {
        const sink = connector();

        expect(forwardExecutionOverlayStates(sink, 'client-1', 'file:///doc.md', STATES)).toBe(true);

        expect(sink.delivered).toEqual([{ kind: EXECUTION_OVERLAY_ACTION_KIND, sourceUri: 'file:///doc.md', states: STATES }]);
        expect(sink.delivered[0]).not.toHaveProperty('events');
    });

    it('send an empty set as such, which takes the states off', () => {
        const sink = connector();
        forwardExecutionOverlayStates(sink, 'client-1', 'file:///doc.md', []);

        expect(sink.delivered[0].states).toEqual([]);
    });

    it('are not sent when no diagram is open, and the registry keeps them for when one is', () => {
        const sink = connector();

        expect(forwardExecutionOverlayStates(sink, undefined, 'file:///doc.md', STATES)).toBe(false);
        expect(sink.delivered).toEqual([]);
    });
});
