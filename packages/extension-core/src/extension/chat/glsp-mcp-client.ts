/**
 * A small client of the diagram's own GLSP-MCP server, for the chat's slash commands.
 *
 * The agent edits a diagram through the GLSP-MCP tools (create-edges, modify-nodes, …): each
 * dispatches the GLSP operation a gesture in the diagram would, so the edit goes through the
 * same handler, lands on the editor's undo stack, and the tool answers what it did. The slash
 * commands are the person's shorthand for the same edits, and call the same tools: they used to
 * send their own producer requests, whose arguments had drifted from what the producer takes, past
 * undo.
 *
 * Streamable HTTP, as far as a tool call needs it: `initialize` opens a session (its id comes
 * back in the `mcp-session-id` header), each request carries it, and an answer is JSON or one
 * server-sent event. A session the server forgot (404) is opened again once: nothing ran on it.
 * A call that was sent is never sent again, whatever happened to its answer -- an edit may have
 * been made, and made twice is worse than reported lost.
 */

const PROTOCOL_VERSION = '2025-06-18';

export interface GlspMcpToolAnswer {
    ok: boolean;
    /** The tool's text, or why the call failed. */
    text: string;
    /** The tool's structured content, when it has one. */
    structured?: Record<string, unknown>;
}

/** The part of `fetch` this client uses; the tests stand one in. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}>;

export class GlspMcpClient {
    private session: string | undefined;
    private nextId = 1;

    constructor(
        private readonly url: string,
        private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
    ) {}

    async callTool(name: string, args: Record<string, unknown>): Promise<GlspMcpToolAnswer> {
        const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this.session) {
                try {
                    await this.initialize();
                } catch (err) {
                    // Opening a session changes nothing: it may be tried again.
                    this.session = undefined;
                    if (attempt === 1) {
                        return { ok: false, text: `The diagram's tools did not answer: ${reason(err)}` };
                    }
                    continue;
                }
            }
            let message: any;
            try {
                const response = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
                if (response.status === 404) {
                    // The server forgot the session (it restarted) and ran nothing: open another, once.
                    this.session = undefined;
                    continue;
                }
                message = await readMessage(response);
            } catch (err) {
                this.session = undefined;
                return {
                    ok: false,
                    text: `The diagram's tools did not answer (${reason(err)}). The edit may have been made: look at the diagram before trying again.`
                };
            }
            if (message.error) {
                return { ok: false, text: String(message.error.message ?? 'The diagram tool failed.') };
            }
            const result = message.result ?? {};
            const text = (Array.isArray(result.content) ? result.content : [])
                .map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
                .join('\n')
                .trim();
            return {
                ok: result.isError !== true,
                text,
                ...(result.structuredContent && typeof result.structuredContent === 'object' ? { structured: result.structuredContent } : {})
            };
        }
        return { ok: false, text: "The diagram's tools did not answer." };
    }

    private async initialize(): Promise<void> {
        const response = await this.post({
            jsonrpc: '2.0',
            id: this.nextId++,
            method: 'initialize',
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dialogram-chat-commands', version: '1' } }
        });
        const session = response.headers.get('mcp-session-id');
        const message = await readMessage(response);
        if (message.error || !session) {
            throw new Error(String(message.error?.message ?? `no session (HTTP ${response.status})`));
        }
        this.session = session;
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }

    private post(body: Record<string, unknown>) {
        return this.fetchImpl(this.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(this.session ? { 'mcp-session-id': this.session, 'mcp-protocol-version': PROTOCOL_VERSION } : {})
            },
            body: JSON.stringify(body)
        });
    }
}

/** The JSON-RPC answer in a response: the body, or the event that carries it. */
async function readMessage(response: { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }): Promise<any> {
    const body = await response.text();
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        for (const line of body.split(/\r?\n/).reverse()) {
            if (!line.startsWith('data:')) {
                continue;
            }
            try {
                const message = JSON.parse(line.slice(5).trim());
                if (message && ('result' in message || 'error' in message)) {
                    return message;
                }
            } catch {
                // Not this event.
            }
        }
        return { error: { message: `no answer in the event stream (HTTP ${response.status})` } };
    }
    try {
        return body.trim() === '' ? {} : JSON.parse(body);
    } catch {
        return { error: { message: body || `HTTP ${response.status}` } };
    }
}
