// A run the IDE did not start (a run of the CLI in a terminal) writes the same
// `run.wf-stream.live.json` in the out dir as one it did; the driver follows its
// agent stream for an open diagram of that file, through the same forwarder as
// the IDE's own run. These tests use the real stream client against a small SSE
// server standing in for the run.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CliRunDriver, type CliRunDriverConfig } from '../src/cli-run-driver';
import { RunStreamForwarder, streamListening, type RunStreamSource } from '../src/run-stream-forwarder';
import type { RunEventStreamClientOptions, RunStreamEvent } from '../src/run-event-stream-client';

// ── the forwarder ────────────────────────────────────────────────────────────

function fakeSource() {
    let options: RunEventStreamClientOptions | undefined;
    const source: RunStreamSource & { stopped: boolean } = { start: () => {}, stop: () => { source.stopped = true; }, stopped: false };
    return {
        createSource: (o: RunEventStreamClientOptions) => { options = o; return source; },
        send: (event: RunStreamEvent) => options!.onEvent(event),
        source,
    };
}

describe('RunStreamForwarder', () => {
    it('forwards each event once: a reconnect replays history', () => {
        const fake = fakeSource();
        const emitted: RunStreamEvent[] = [];
        const forwarder = new RunStreamForwarder({ discoveryFilePath: '/x', emit: (e) => emitted.push(...e), createSource: fake.createSource });
        forwarder.start();
        fake.send({ seq: 1, type: 'run.started' });
        fake.send({ seq: 2, type: 'agent.message.delta', instance: 'a', delta: 'he' });
        // the connection dropped and came back: the run replays 1..2, then goes on
        fake.send({ seq: 1, type: 'run.started' });
        fake.send({ seq: 2, type: 'agent.message.delta', instance: 'a', delta: 'he' });
        fake.send({ seq: 3, type: 'agent.message.delta', instance: 'a', delta: 'llo' });
        forwarder.flush();
        expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3]);
        forwarder.stop();
    });

    it('closes a run that did not say it ended, and not one that did', () => {
        for (const [last, closing] of [[{ seq: 2, type: 'agent.message.delta', instance: 'a' }, true], [{ seq: 2, type: 'run.finished' }, false]] as const) {
            const fake = fakeSource();
            const emitted: RunStreamEvent[] = [];
            const forwarder = new RunStreamForwarder({ discoveryFilePath: '/x', emit: (e) => emitted.push(...e), createSource: fake.createSource });
            forwarder.start();
            fake.send({ seq: 1, type: 'run.started' });
            fake.send(last);
            forwarder.stop('gone');
            expect(fake.source.stopped).toBe(true);
            expect(emitted.at(-1)).toEqual(closing ? { type: 'run.stream.closing', reason: 'gone' } : last);
        }
    });

    it('tells a listening port from a closed one', async () => {
        const server = net.createServer().listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const port = (server.address() as net.AddressInfo).port;
        await expect(streamListening('127.0.0.1', port)).resolves.toBe(true);
        await new Promise((r) => server.close(r));
        await expect(streamListening('127.0.0.1', port)).resolves.toBe(false);
    });
});

// ── the driver following a run started outside the IDE ───────────────────────

/** An SSE server standing in for a run's event stream: replays its history to each connection, as wfpy does. */
async function fakeRunStream(token: string) {
    const history: RunStreamEvent[] = [];
    const open = new Set<http.ServerResponse>();
    let connections = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== '/events' || url.searchParams.get('token') !== token) {
            res.writeHead(401).end();
            return;
        }
        connections++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
        open.add(res);
        res.on('close', () => open.delete(res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    return {
        port,
        get connections() { return connections; },
        publish(event: RunStreamEvent) {
            const numbered = { seq: history.length + 1, ...event };
            history.push(numbered);
            for (const res of open) res.write(`data: ${JSON.stringify(numbered)}\n\n`);
        },
        /** Drop every connection (the client comes back). */
        drop() { for (const res of open) res.destroy(); },
        close: () => new Promise<void>((r) => { for (const res of open) res.destroy(); server.close(() => r()); }),
    };
}

function config(): CliRunDriverConfig {
    return {
        settingsNamespace: 'wfLang',
        customEditorViewType: 'workflow.networkDiagram',
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: 'fake-wfpy',
        cliPythonModule: undefined,
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: 'test.run',
        stopWorkflowCommandId: 'test.stop',
        agentToolConfigCommands: { set: 'test.set', get: 'test.get' },
        overrideState: { get: () => undefined, update: () => Promise.resolve() },
    } as CliRunDriverConfig;
}

describe('CliRunDriver following a run started outside the IDE', () => {
    const cleanups: Array<() => unknown> = [];
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function setUp() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-follow-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'flow.py');
        fs.writeFileSync(file, '# fixture\n');
        const outDir = path.join(dir, 'wf-out');
        fs.mkdirSync(outDir);
        const emitted: Array<{ uri: string; events: RunStreamEvent[] }> = [];
        const host = {
            overlay: { emitEvents: (uri: string, events: RunStreamEvent[]) => emitted.push({ uri, events }) },
            requestRefresh: () => {},
            output: { show() {}, append() {}, appendLine() {} },
        };
        const driver = new CliRunDriver(config(), host as any);
        cleanups.push(() => driver.dispose());
        const uri = vscode.Uri.file(file);
        const watch = driver.watchLiveOverlay(uri);
        cleanups.push(() => watch.dispose());
        const poll = (): Promise<void> => (driver as any).pollWatchedLiveOverlays();
        const discoveryPath = path.join(outDir, 'run.wf-stream.live.json');
        const announce = (fields: Record<string, unknown>) => fs.writeFileSync(discoveryPath, JSON.stringify({ version: 1, host: '127.0.0.1', ...fields }));
        const events = () => emitted.filter((e) => e.uri === uri.toString()).flatMap((e) => e.events);
        return { dir, file, uri, driver, watch, poll, announce, discoveryPath, events };
    }

    it("shows a terminal run's agents in the diagram of its file, each event once", async () => {
        const t = await setUp();
        const run = await fakeRunStream('tok');
        cleanups.push(() => run.close());
        run.publish({ type: 'run.started', runId: 'r1' });
        run.publish({ type: 'agent.message.delta', instance: 'writer', delta: 'Hel' });
        t.announce({ runId: 'r1', sourcePath: t.file, port: run.port, token: 'tok' });

        await t.poll();
        await vi.waitFor(() => expect(t.events().filter((e) => e.type === 'agent.message.delta')).toHaveLength(1));
        // The diagram is told a run started before any replay: it drops the last run's agents.
        expect(t.events()[0]).toEqual({ type: 'run.started', runId: 'r1' });

        run.publish({ type: 'agent.message.delta', instance: 'writer', delta: 'lo' });
        await vi.waitFor(() => expect(t.events().filter((e) => e.type === 'agent.message.delta')).toHaveLength(2));

        // A dropped connection comes back and is replayed everything: nothing twice.
        run.drop();
        await vi.waitFor(() => expect(run.connections).toBeGreaterThan(1), { timeout: 5000 });
        run.publish({ type: 'agent.message.delta', instance: 'writer', delta: '!' });
        await vi.waitFor(() => expect(t.events().filter((e) => e.type === 'agent.message.delta').map((e) => e.delta)).toEqual(['Hel', 'lo', '!']));

        // The run ends: it says so, and removes its file.
        run.publish({ type: 'run.finished' });
        await vi.waitFor(() => expect(t.events().at(-1)?.type).toBe('run.finished'));
        fs.rmSync(t.discoveryPath);
        await t.poll();
        expect(t.events().filter((e) => e.type === 'run.stream.closing')).toHaveLength(0);
        expect((t.driver as any).followedRuns.size).toBe(0);
    });

    it("leaves another file's run alone", async () => {
        const t = await setUp();
        const run = await fakeRunStream('tok');
        cleanups.push(() => run.close());
        t.announce({ runId: 'r2', sourcePath: path.join(t.dir, 'other.py'), port: run.port, token: 'tok' });
        await t.poll();
        expect((t.driver as any).followedRuns.size).toBe(0);
        expect(run.connections).toBe(0);
    });

    it("leaves a run the IDE started to the IDE's own stream", async () => {
        const t = await setUp();
        const run = await fakeRunStream('tok');
        cleanups.push(() => run.close());
        (t.driver as any).activeRun = { sourceUri: t.uri, workflowName: 'flow' };
        t.announce({ runId: 'r3', sourcePath: t.file, port: run.port, token: 'tok' });
        await t.poll();
        expect((t.driver as any).followedRuns.size).toBe(0);
        (t.driver as any).activeRun = undefined;
    });

    it('does not follow the file a killed run left behind, nor try it again', async () => {
        const t = await setUp();
        const dead = await fakeRunStream('tok');
        const port = dead.port;
        await dead.close();
        t.announce({ runId: 'r4', sourcePath: t.file, port, token: 'tok' });
        await t.poll();
        await t.poll();
        expect((t.driver as any).followedRuns.size).toBe(0);
        expect((t.driver as any).goneRunIds.has('r4')).toBe(true);
        expect(t.events()).toEqual([]);
    });

    it('closes the run for the diagram when its stream goes without a word', async () => {
        const t = await setUp();
        const run = await fakeRunStream('tok');
        run.publish({ type: 'run.started', runId: 'r5' });
        t.announce({ runId: 'r5', sourcePath: t.file, port: run.port, token: 'tok' });
        await t.poll();
        await vi.waitFor(() => expect(run.connections).toBe(1));
        await run.close(); // killed: no run.finished, the file stays
        await vi.waitFor(() => expect(t.events().at(-1)?.type).toBe('run.stream.closing'), { timeout: 5000 });
        expect((t.driver as any).followedRuns.size).toBe(0);
        await t.poll(); // the file is still there: not followed again
        expect((t.driver as any).followedRuns.size).toBe(0);
    });

    it('stops following when the diagram closes, and follows a new run of the file', async () => {
        const t = await setUp();
        const first = await fakeRunStream('a');
        cleanups.push(() => first.close());
        t.announce({ runId: 'r6', sourcePath: t.file, port: first.port, token: 'a' });
        await t.poll();
        expect((t.driver as any).followedRuns.get(t.uri.toString())?.runId).toBe('r6');

        const second = await fakeRunStream('b');
        cleanups.push(() => second.close());
        t.announce({ runId: 'r7', sourcePath: t.file, port: second.port, token: 'b' });
        await t.poll();
        expect((t.driver as any).followedRuns.get(t.uri.toString())?.runId).toBe('r7');
        await vi.waitFor(() => expect(second.connections).toBe(1));

        t.watch.dispose();
        expect((t.driver as any).followedRuns.size).toBe(0);
    });
});
