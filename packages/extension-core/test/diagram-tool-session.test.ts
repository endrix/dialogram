import { describe, expect, it, vi } from 'vitest';
import { diagramToolSession } from '../src/extension/chat/diagram-tool-session';

/** `session-info` listing `sessions`. */
const toolsListing = (sessions: Array<{ sessionId: string; sourceUri: string; readOnly: boolean }>) => ({
    callTool: vi.fn(async () => ({ ok: true, text: '', structured: { sessions } }))
});

describe('the diagram session a chat command acts on', () => {
    // The editor of wf.py (client glsp_7) is navigated into place.py's workflow; another diagram of wf.py is open.
    const sessions = [
        { sessionId: 'glsp_2', sourceUri: 'file:///ws/wf.py', readOnly: false },
        { sessionId: 'glsp_7', sourceUri: 'file:///ws/workflows/place.py', readOnly: false }
    ];

    it('is a diagram of the chat\'s file for the edit commands, whatever the editor shows', async () => {
        expect(await diagramToolSession(toolsListing(sessions), '/ws/wf.py', 'glsp_7')).toEqual({ sessionId: 'glsp_2' });
    });

    it('is what the editor shows, another file\'s workflow included, with anyView', async () => {
        expect(await diagramToolSession(toolsListing(sessions), '/ws/wf.py', 'glsp_7', { anyView: true })).toEqual({ sessionId: 'glsp_7' });
    });

    it('prefers the editor\'s own diagram of the chat\'s file over another', async () => {
        const two = [
            { sessionId: 'glsp_2', sourceUri: 'file:///ws/wf.py', readOnly: false },
            { sessionId: 'glsp_3', sourceUri: 'file:///ws/wf.py', readOnly: false }
        ];
        expect(await diagramToolSession(toolsListing(two), '/ws/wf.py', 'glsp_3')).toEqual({ sessionId: 'glsp_3' });
    });
});
