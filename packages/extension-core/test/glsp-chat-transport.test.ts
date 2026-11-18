// Where a chat reply goes when a file has two diagram editors, each with its
// chat panel. The transport kept one panel per file, the last to speak: when
// that editor closed, replies went to a webview that was gone, and the editor
// left open heard nothing until its panel spoke again.
import { describe, expect, it } from 'vitest';
import { createGlspChatTransport } from '../src/extension/chat/glsp-chat-transport';

const FILE = 'file:///w/top.dsl';

function makeTransport() {
    const live = new Set<string>();
    const sent: Array<{ to: string; type: string }> = [];
    let toHost: ((env: any, sender: any) => void) | undefined;
    const messenger = {
        onNotification: (_type: unknown, handler: (env: any, sender: any) => void) => { toHost = handler; },
        sendNotification: (_type: unknown, participant: { webviewId: string }, payload: { type: string }) => {
            sent.push({ to: participant.webviewId, type: payload.type });
        },
        diagnosticApi: () => ({ extensionInfo: () => ({ webviews: [...live].map(id => ({ id, type: 'fixture.diagram' })) }) })
    };
    const transport = createGlspChatTransport({ getConnector: () => ({ messenger }) as any, log: () => undefined });
    const handled: string[] = [];
    transport.connect({ handleMessage: async (uri: string) => { handled.push(uri); } });
    /** A panel speaks: its webview is there, and it is a participant of the file. */
    const speak = (webviewId: string): void => {
        live.add(webviewId);
        toHost!({ type: 'chat.getSessions', data: { workflowUri: FILE } }, { type: 'webview', webviewId });
    };
    const close = (webviewId: string): void => { live.delete(webviewId); };
    return { transport, sent, speak, close, handled };
}

describe('a chat reply for a file with two editors', () => {
    it('goes to the panel that spoke last', () => {
        const { transport, sent, speak } = makeTransport();
        speak('panel-a');
        speak('panel-b');

        transport.sink(FILE, { type: 'chat.sessions' });

        expect(sent).toEqual([{ to: 'panel-b', type: 'chat.sessions' }]);
    });

    it('goes to the other panel once that one\'s editor has closed', () => {
        const { transport, sent, speak, close } = makeTransport();
        speak('panel-a');
        speak('panel-b');
        close('panel-b');

        transport.sink(FILE, { type: 'chat.message' });

        expect(sent).toEqual([{ to: 'panel-a', type: 'chat.message' }]);
        expect(transport.canReach(FILE)).toBe(true);
    });

    it('goes nowhere, and says so, once both have closed', () => {
        const { transport, sent, speak, close } = makeTransport();
        speak('panel-a');
        close('panel-a');

        transport.sink(FILE, { type: 'chat.message' });

        expect(sent).toEqual([]);
        expect(transport.canReach(FILE)).toBe(false);
    });

    it('is the same panel as before for a file with one editor, however often it speaks', () => {
        const { transport, sent, speak } = makeTransport();
        speak('panel-a');
        speak('panel-a');

        transport.sink(FILE, { type: 'chat.turnEnd' });

        expect(sent).toEqual([{ to: 'panel-a', type: 'chat.turnEnd' }]);
    });
});
