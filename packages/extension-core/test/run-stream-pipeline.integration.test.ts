/**
 * Host-side run-stream pipeline integration test (Round 7).
 *
 * Drives the REAL production stretch that the console evidence showed was dead —
 * upstream of the webview bridge — end to end:
 *
 *   inline SSE server (faithful to examples/smoke/bin/fake-run-server.cjs:
 *   discovery file + /events with history replay + 13 events)
 *     → real RunEventStreamClient (discovery-file poll → connect → parse frames)
 *     → the driver's flush wiring (onEvent → batch → 120ms flush)
 *     → real ExecutionOverlayRegistry.emitEvents
 *     → the bridge subscription exactly as glsp-activation wires it
 *       (onDidEmitEvents → forwardExecutionOverlayEvents)
 *     → a recording sendMessageToClient.
 *
 * Asserts all 13 events reach the recorder. If the live defect lives in this
 * stretch, this fails / reveals the dead hop (which round-3's bridge-only unit
 * test could not, since it called forwardExecutionOverlayEvents directly).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEventStreamClient, type RunStreamEvent } from '../../sidecar-toolkit/src/run-event-stream-client';
import { ExecutionOverlayRegistry } from '../src/extension/diagram/execution-overlay';
import { forwardExecutionOverlayEvents, type ExecutionOverlayWebviewSink } from '../src/extension/diagram/execution-overlay-bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The real smoke fake run server, if the sibling streamblocks-ide repo is present. */
const FAKE_RUN_SERVER = path.resolve(
    __dirname,
    '../../../../streamblocks-ide/examples/smoke/bin/fake-run-server.cjs'
);

const HOST = '127.0.0.1';
const SOURCE_URI = 'file:///w/smoke_workflow.py';

/** Ordered 13-event script, mirroring fake-run-server.cjs. */
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

/** Inline SSE server faithful to the fake run server's observable contract. */
function startFakeSseServer(): Promise<{ port: number; emitAll: () => void; close: () => void }> {
    const clients: http.ServerResponse[] = [];
    const history: string[] = [];
    const server = http.createServer((req, res) => {
        if (!(req.url || '').startsWith('/events')) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        for (const frame of history) {
            res.write(frame);
        }
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
                emitAll: () => {
                    let d = 0;
                    for (const ev of eventScript()) {
                        setTimeout(() => emit(ev), d);
                        d += 15;
                    }
                },
                close: () => {
                    for (const res of clients.splice(0)) { try { res.end(); } catch { /* noop */ } }
                    server.close();
                }
            });
        });
    });
}

describe('run-stream host pipeline (integration)', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        for (const c of cleanups.splice(0)) c();
    });

    it('carries all 13 SSE events from the stream client through the bridge to sendMessageToClient', async () => {
        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-runstream-'));
        const sse = await startFakeSseServer();
        cleanups.push(() => sse.close());

        // Write the discovery file exactly as the fake/real run does.
        const discoveryFilePath = path.join(outDir, 'run.wf-stream.live.json');
        await fs.writeFile(
            discoveryFilePath,
            JSON.stringify({ host: HOST, port: sse.port, eventsUrl: `http://${HOST}:${sse.port}/events` }),
            'utf-8'
        );

        // Production wiring: registry + bridge subscription (glsp-activation shape).
        const registry = new ExecutionOverlayRegistry();
        const recorded: RunStreamEvent[] = [];
        const sink: ExecutionOverlayWebviewSink = {
            sendMessageToClient: (_clientId, message) => {
                const events = (message.action as unknown as { events?: RunStreamEvent[] }).events ?? [];
                recorded.push(...events);
            }
        };
        const subscription = registry.onDidEmitEvents((uri, events) => {
            forwardExecutionOverlayEvents(sink, 'client-1', uri, events as RunStreamEvent[]);
        });
        cleanups.push(() => subscription.dispose());

        // Driver flush wiring: onEvent → batch → 120ms flush → emitEvents.
        let batch: RunStreamEvent[] = [];
        const client = new RunEventStreamClient({
            discoveryFilePath,
            onEvent: e => batch.push(e),
            discoveryPollMs: 30
        });
        const flush = setInterval(() => {
            if (batch.length === 0) return;
            const events = batch;
            batch = [];
            registry.emitEvents(SOURCE_URI, events);
        }, 60);
        cleanups.push(() => clearInterval(flush));
        cleanups.push(() => client.stop());

        client.start();
        sse.emitAll();

        // Wait until all 13 events are recorded (or time out).
        const deadline = Date.now() + 5000;
        while (recorded.length < 13 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 25));
        }

        expect(recorded.length).toBe(13);
        expect(recorded[0]).toMatchObject({ type: 'run.started' });
        expect(recorded.at(-1)).toMatchObject({ type: 'run.finished' });
        expect(recorded.filter(e => e.type === 'agent.message.start').map(e => e.instance)).toEqual(['n1', 'n2']);
    });

    // Maximally faithful: spawn the REAL fake-run-server.cjs (production order —
    // client polls first, the run process writes the discovery file + serves SSE
    // later). Skipped when the sibling streamblocks-ide repo is not checked out.
    it.skipIf(!existsSync(FAKE_RUN_SERVER))(
        'carries all 13 events from the REAL fake-run-server through the real client + bridge',
        async () => {
            const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-runstream-real-'));

            const registry = new ExecutionOverlayRegistry();
            const recorded: RunStreamEvent[] = [];
            const sink: ExecutionOverlayWebviewSink = {
                sendMessageToClient: (_clientId, message) => {
                    const events = (message.action as unknown as { events?: RunStreamEvent[] }).events ?? [];
                    recorded.push(...events);
                }
            };
            const subscription = registry.onDidEmitEvents((uri, events) => {
                forwardExecutionOverlayEvents(sink, 'client-1', uri, events as RunStreamEvent[]);
            });
            cleanups.push(() => subscription.dispose());

            let batch: RunStreamEvent[] = [];
            // Force the ext-host-proof raw-socket transport: this is the path the
            // live fix relies on (the patched http module stalls in the ext host).
            const client = new RunEventStreamClient({
                discoveryFilePath: path.join(outDir, 'run.wf-stream.live.json'),
                onEvent: e => batch.push(e),
                discoveryPollMs: 100,
                transport: 'socket'
            });
            const flush = setInterval(() => {
                if (batch.length === 0) return;
                const events = batch;
                batch = [];
                registry.emitEvents(SOURCE_URI, events);
            }, 120);
            cleanups.push(() => clearInterval(flush));
            cleanups.push(() => client.stop());

            // Client polls first (production order), then spawn the run process.
            client.start();
            const child: ChildProcess = spawn(
                process.execPath,
                [FAKE_RUN_SERVER, 'run', path.join(outDir, 'smoke_workflow.py'), '--out-dir', outDir],
                { stdio: 'ignore' }
            );
            cleanups.push(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } });

            const deadline = Date.now() + 12000;
            while (recorded.length < 13 && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 50));
            }

            expect(recorded.length).toBe(13);
            expect(recorded[0]).toMatchObject({ type: 'run.started' });
            expect(recorded.at(-1)).toMatchObject({ type: 'run.finished' });
        },
        15000
    );
});
