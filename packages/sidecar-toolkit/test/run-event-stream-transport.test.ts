/**
 * Transport coverage for RunEventStreamClient (Round 8).
 *
 * The extension host's @vscode/proxy-agent stalls SSE over the patched `http`
 * module (200 then zero data). The raw-socket transport bypasses it. Both
 * transports must deliver every event; the socket path must correctly de-chunk
 * an HTTP/1.1 `transfer-encoding: chunked` SSE body.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    RunEventStreamClient,
    type RunStreamEvent,
    type RunEventStreamTransport
} from '../src/run-event-stream-client';

const HOST = '127.0.0.1';

function eventScript(): RunStreamEvent[] {
    return [
        { type: 'run.started' },
        { type: 'agent.message.start', instance: 'n1' },
        { type: 'agent.message.delta', instance: 'n1', field: 'reasoning', delta: 'Deciding…' },
        { type: 'agent.message.delta', instance: 'n1', delta: 'Emitting count ' },
        { type: 'agent.tool_call', instance: 'n1', name: 'read_config' },
        { type: 'agent.message.delta', instance: 'n1', delta: '= 3.' },
        { type: 'agent.message.end', instance: 'n1' },
        { type: 'agent.message.start', instance: 'n2' },
        { type: 'agent.message.delta', instance: 'n2', delta: 'Received value 3. ' },
        { type: 'agent.tool_call', instance: 'n2', name: 'print_output' },
        { type: 'agent.message.delta', instance: 'n2', delta: 'Printing to sink.' },
        { type: 'agent.message.end', instance: 'n2' },
        { type: 'run.finished' }
    ];
}

/** Node http SSE server → chunked transfer-encoding (exercises the de-chunker). */
function startChunkedSse(): Promise<{ port: number; emitAll: () => void; close: () => void }> {
    const clients: http.ServerResponse[] = [];
    const history: string[] = [];
    const server = http.createServer((req, res) => {
        if (!(req.url || '').startsWith('/events')) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        for (const frame of history) res.write(frame);
        clients.push(res);
        req.on('close', () => {
            const i = clients.indexOf(res);
            if (i !== -1) clients.splice(i, 1);
        });
    });
    const emit = (event: RunStreamEvent): void => {
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        history.push(frame);
        for (const res of clients) res.write(frame);
    };
    return new Promise(resolve => {
        server.listen(0, HOST, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                port,
                emitAll: () => { let d = 0; for (const ev of eventScript()) { setTimeout(() => emit(ev), d); d += 10; } },
                close: () => {
                    for (const res of clients.splice(0)) { try { res.end(); } catch { /* noop */ } }
                    server.close();
                }
            });
        });
    });
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

async function collect(transport: RunEventStreamTransport): Promise<RunStreamEvent[]> {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-transport-'));
    const sse = await startChunkedSse();
    cleanups.push(() => sse.close());
    const discoveryFilePath = path.join(outDir, 'run.wf-stream.live.json');
    await fs.writeFile(
        discoveryFilePath,
        JSON.stringify({ host: HOST, port: sse.port, eventsUrl: `http://${HOST}:${sse.port}/events` }),
        'utf-8'
    );

    const events: RunStreamEvent[] = [];
    const client = new RunEventStreamClient({
        discoveryFilePath,
        onEvent: e => events.push(e),
        discoveryPollMs: 25,
        transport,
        stallFallbackMs: 300
    });
    cleanups.push(() => client.stop());
    client.start();
    sse.emitAll();

    const deadline = Date.now() + 5000;
    while (events.length < 13 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
    }
    return events;
}

describe('RunEventStreamClient transports', () => {
    it('http transport receives all 13 events', async () => {
        const events = await collect('http');
        expect(events.length).toBe(13);
        expect(events[0]).toMatchObject({ type: 'run.started' });
        expect(events.at(-1)).toMatchObject({ type: 'run.finished' });
    });

    it('raw-socket transport de-chunks and receives all 13 events', async () => {
        const events = await collect('socket');
        expect(events.length).toBe(13);
        expect(events[0]).toMatchObject({ type: 'run.started' });
        expect(events.at(-1)).toMatchObject({ type: 'run.finished' });
        expect(events.filter(e => e.type === 'agent.message.start').map(e => e.instance)).toEqual(['n1', 'n2']);
    });
});
