/**
 * In-process HTTP MCP server exposing consumer-supplied tools.
 *
 * Runs inside the extension host (already a Node process) and is attached to a
 * chat session as an ACP `McpServer` of type "http" (opencode connects to it by
 * URL). This avoids spawning a Node subprocess and lets tools read LIVE
 * host-side state (e.g. an in-memory graph store) instead of a snapshot.
 *
 * One server serves every session; the target file is carried in the URL
 * (`?f=<base64url(path)>`) that mcpServersProvider hands to each session.
 * Minimal Streamable-HTTP transport: POST JSON-RPC in, JSON-RPC out.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InProcessChatTool } from '../../api';

const PROTOCOL_VERSION = '2025-06-18';

export class McpHttpServer {
    private server: http.Server | undefined;
    private port = 0;

    constructor(
        private readonly serverName: string,
        private readonly tools: InProcessChatTool[]
    ) {}

    /** Start listening on a random loopback port. Idempotent. */
    async start(): Promise<number> {
        if (this.server) return this.port;
        const server = http.createServer((req, res) => this.handle(req, res));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        return this.port;
    }

    /** The MCP URL for a session scoped to a specific file. */
    urlFor(file: string): string {
        return `http://127.0.0.1:${this.port}/mcp?f=${Buffer.from(file).toString('base64url')}`;
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        const f = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('f');
        const file = f ? Buffer.from(f, 'base64url').toString('utf8') : '';
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            let msg: any;
            try {
                msg = JSON.parse(body);
            } catch {
                res.writeHead(400).end();
                return;
            }
            const json = (obj: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            switch (msg.method) {
                case 'initialize':
                    return json({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            protocolVersion: PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: { name: this.serverName, version: '0.1.0' }
                        }
                    });
                case 'tools/list':
                    return json({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                            tools: this.tools.map(t => ({
                                name: t.name,
                                description: t.description,
                                inputSchema: t.inputSchema
                            }))
                        }
                    });
                case 'tools/call':
                    void this.callTool(file, msg.params?.name, msg.params?.arguments ?? {}).then(
                        text =>
                            json({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: { content: [{ type: 'text', text }] }
                            })
                    );
                    return;
                default:
                    if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) {
                        res.writeHead(202).end();
                        return;
                    }
                    return json({
                        jsonrpc: '2.0',
                        id: msg.id ?? null,
                        error: { code: -32601, message: `Method not found: ${msg.method}` }
                    });
            }
        });
    }

    private async callTool(file: string, name: string, args: unknown): Promise<string> {
        const tool = this.tools.find(t => t.name === name);
        if (!tool) return `Unknown tool: ${name}`;
        try {
            return await tool.handler(file, args as Record<string, unknown>);
        } catch (err) {
            return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
