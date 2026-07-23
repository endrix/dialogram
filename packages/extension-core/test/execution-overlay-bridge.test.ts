import { describe, it, expect } from 'vitest';
import { forwardExecutionOverlayEvents } from '../src/extension/diagram/execution-overlay-bridge';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';

/**
 * Faithful stub of the two GlspVscodeConnector send paths, mirroring
 * @eclipse-glsp/vscode-integration glsp-vscode-connector.js:
 *  - dispatchAction:      forwards to the webview ONLY if action.kind is in the
 *    client's advertised `clientActions` list (a client-only custom kind is NOT →
 *    silently dropped);
 *  - sendMessageToClient: forwards to the webview UNCONDITIONALLY.
 */
function makeConnectorStub(clientActions: string[]) {
    const delivered: Array<Record<string, unknown>> = [];
    return {
        delivered,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dispatchAction(action: any): void {
            if (clientActions.includes(action.kind)) {
                delivered.push(action);
            }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendMessageToClient(_clientId: string, message: any): void {
            delivered.push(message.action);
        }
    };
}

describe('execution-overlay bridge → webview forwarding', () => {
    const uri = 'file:///Users/x/wf.py';
    const events = [{ type: 'run.started' }, { type: 'agent.message.start', instance: 'n1' }];

    it('delivers the batch to the webview even though the kind is NOT advertised in clientActions', () => {
        // Realistic: the client advertises no custom client-only kind (see showGrid).
        const connector = makeConnectorStub([]);
        const ok = forwardExecutionOverlayEvents(connector, 'client-1', uri, events);

        expect(ok).toBe(true);
        expect(connector.delivered).toHaveLength(1);
        expect(connector.delivered[0].kind).toBe(EXECUTION_OVERLAY_ACTION_KIND);
        expect(connector.delivered[0].events).toBe(events);
        expect(connector.delivered[0].sourceUri).toBe(uri);
    });

    it('REGRESSION: the old dispatchAction path silently drops the batch (the live-smoke symptom)', () => {
        const connector = makeConnectorStub([]); // executionOverlay kind not advertised
        // Reproduce the pre-fix bridge behaviour verbatim:
        connector.dispatchAction({ kind: EXECUTION_OVERLAY_ACTION_KIND, sourceUri: uri, events });
        expect(connector.delivered).toHaveLength(0); // dropped → RunningAgentsBar never lights up
    });

    it('drops without throwing and reports when no client id resolved (batch replays on reconnect)', () => {
        const connector = makeConnectorStub([]);
        const reasons: string[] = [];
        const ok = forwardExecutionOverlayEvents(connector, undefined, uri, events, r => reasons.push(r));

        expect(ok).toBe(false);
        expect(connector.delivered).toHaveLength(0);
        expect(reasons[0]).toContain('[wf-lang');
    });
});
