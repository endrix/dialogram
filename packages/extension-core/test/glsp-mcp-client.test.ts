import { describe, expect, it } from 'vitest';
import { GlspMcpClient, type FetchLike } from '../src/extension/chat/glsp-mcp-client';

type Reply = { status?: number; headers?: Record<string, string>; body: string };

/** A server that answers each request with the next reply, and records what it was sent. */
function server(replies: Reply[]) {
    const sent: Array<{ headers: Record<string, string>; body: any }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
        sent.push({ headers: init.headers, body: JSON.parse(init.body) });
        const reply = replies.shift() ?? { body: '' };
        const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        return { status: reply.status ?? 200, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => reply.body };
    };
    return { sent, fetchImpl };
}

const opened = (session: string): Reply[] => [
    { headers: { 'mcp-session-id': session, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) },
    { status: 202, body: '' }
];

describe('GlspMcpClient', () => {
    it('opens a session, then calls the tool with its id and reads an event-stream answer', async () => {
        const { sent, fetchImpl } = server([
            ...opened('s-1'),
            {
                headers: { 'content-type': 'text/event-stream' },
                body: 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Connected 1 edge(s)' }] } }) + '\n\n'
            }
        ]);
        const client = new GlspMcpClient('http://x/mcp', fetchImpl);
        const answer = await client.callTool('create-edges', { sessionId: 'glsp_1' });
        expect(answer).toEqual({ ok: true, text: 'Connected 1 edge(s)' });
        expect(sent.map(each => each.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
        expect(sent[2].headers['mcp-session-id']).toBe('s-1');
        expect(sent[2].body.params).toEqual({ name: 'create-edges', arguments: { sessionId: 'glsp_1' } });
    });

    it("a tool's error result is not ok, in the tool's words; structured content comes along", async () => {
        const { fetchImpl } = server([
            ...opened('s-1'),
            { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'Not renamed' }], structuredContent: { n: 1 } } }) }
        ]);
        const answer = await new GlspMcpClient('http://x/mcp', fetchImpl).callTool('modify-nodes', {});
        expect(answer).toEqual({ ok: false, text: 'Not renamed', structured: { n: 1 } });
    });

    it('keeps its session across calls, and opens another once when the server forgot it', async () => {
        const answer = (text: string): Reply => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text }] } }) });
        const { sent, fetchImpl } = server([...opened('s-1'), answer('one'), { status: 404, body: 'Session not found' }, ...opened('s-2'), answer('two')]);
        const client = new GlspMcpClient('http://x/mcp', fetchImpl);
        expect((await client.callTool('a', {})).text).toBe('one');
        expect((await client.callTool('b', {})).text).toBe('two');
        expect(sent.map(each => each.body.method)).toEqual([
            'initialize', 'notifications/initialized', 'tools/call', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call'
        ]);
        expect(sent.at(-1)!.headers['mcp-session-id']).toBe('s-2');
    });

    it('never sends a tool call twice: one that may have been made is reported, not repeated', async () => {
        // An edit sent, then its answer lost (a reset socket), may have been made; sending it
        // again made a second node with a second undo entry.
        let calls = 0;
        const { sent, fetchImpl } = server(opened('s-1'));
        const client = new GlspMcpClient('http://x/mcp', async (url, init) => {
            if (JSON.parse(init.body).method === 'tools/call') {
                calls += 1;
                throw new Error('socket hang up');
            }
            return fetchImpl(url, init);
        });
        const answer = await client.callTool('create-nodes', {});
        expect(calls).toBe(1);
        expect(answer).toEqual({ ok: false, text: expect.stringContaining('The edit may have been made') });
        expect(sent.map(each => each.body.method)).toEqual(['initialize', 'notifications/initialized']);
    });

    it('says the tools did not answer when the server is down', async () => {
        const client = new GlspMcpClient('http://x/mcp', async () => { throw new Error('ECONNREFUSED'); });
        const answer = await client.callTool('a', {});
        expect(answer.ok).toBe(false);
        expect(answer.text).toContain('ECONNREFUSED');
    });
});
