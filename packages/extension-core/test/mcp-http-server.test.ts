import { afterEach, describe, expect, it } from 'vitest';
import { McpHttpServer } from '../src/extension/chat/mcp-http-server';
import type { InProcessChatTool } from '../src/api';

const TOOLS: InProcessChatTool[] = [
    {
        name: 'echo',
        description: 'Echo the input back with the target file.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: (file, args) => `${file}:${String(args.text)}`
    },
    {
        name: 'boom',
        description: 'Always throws.',
        inputSchema: { type: 'object', properties: {} },
        handler: () => {
            throw new Error('kaput');
        }
    }
];

async function rpc(server: McpHttpServer, file: string, body: unknown): Promise<any> {
    const res = await fetch(server.urlFor(file), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

describe('McpHttpServer', () => {
    let server: McpHttpServer | undefined;

    afterEach(() => {
        server?.stop();
        server = undefined;
    });

    it('answers initialize with the server name', async () => {
        server = new McpHttpServer('testsrv', TOOLS);
        await server.start();
        const reply = await rpc(server, '/tmp/a.mlir', { jsonrpc: '2.0', id: 1, method: 'initialize' });
        expect(reply.result.serverInfo.name).toBe('testsrv');
        expect(reply.result.capabilities.tools).toEqual({});
    });

    it('lists tools without their handlers', async () => {
        server = new McpHttpServer('testsrv', TOOLS);
        await server.start();
        const reply = await rpc(server, '/tmp/a.mlir', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect(reply.result.tools.map((t: any) => t.name)).toEqual(['echo', 'boom']);
        expect(reply.result.tools[0]).not.toHaveProperty('handler');
    });

    it('calls a tool with the file decoded from the URL', async () => {
        server = new McpHttpServer('testsrv', TOOLS);
        await server.start();
        const reply = await rpc(server, '/tmp/target file.mlir', {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'hi' } }
        });
        expect(reply.result.content[0].text).toBe('/tmp/target file.mlir:hi');
    });

    it('surfaces tool failures as text instead of crashing', async () => {
        server = new McpHttpServer('testsrv', TOOLS);
        await server.start();
        const reply = await rpc(server, '/tmp/a.mlir', {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'boom', arguments: {} }
        });
        expect(reply.result.content[0].text).toContain('kaput');
    });

    it('rejects unknown methods with -32601 and accepts notifications', async () => {
        server = new McpHttpServer('testsrv', TOOLS);
        await server.start();
        const reply = await rpc(server, '/tmp/a.mlir', { jsonrpc: '2.0', id: 5, method: 'nope' });
        expect(reply.error.code).toBe(-32601);
        const res = await fetch(server.urlFor('/tmp/a.mlir'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        });
        expect(res.status).toBe(202);
    });
});
