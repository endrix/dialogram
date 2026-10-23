/**
 * Large graphs on the Java ELK server.
 *
 * The client speaks the server's framed mode only, over one connection per
 * layout, so an id with a brace in it (a label can have one) goes through.
 * The process starts when a layout first needs it and is started again after
 * it dies. The switch sends a graph to the server by size, and falls back to
 * elkjs for anything the server cannot do. The last block runs the platform's
 * own layout engine against the shipped jar, when Java is installed.
 */
import 'reflect-metadata';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type { ELK, ElkNode } from 'elkjs';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { FRAME_HEADER_BYTES, FRAME_MAGIC, encodeFrame, layoutOnServer } from '../src/server/elk-server/elk-server-client';
import { ElkServerProcess, type SpawnFunction } from '../src/server/elk-server/elk-server-process';
import { SwitchingElk, elkGraphSize, goesToServer } from '../src/server/elk-server/switching-elk';
import { GraphGModelSource } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';

const frame = (json: unknown): Buffer => {
    const body = gzipSync(Buffer.from(JSON.stringify(json)));
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    FRAME_MAGIC.copy(header);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
};

/** A stand-in server: reads one framed request, answers with `answer(request)`, framed. */
async function fakeServer(answer: (request: any) => unknown | undefined): Promise<{ port: number; server: Server; requests: any[] }> {
    const requests: any[] = [];
    const server = createServer(socket => {
        const chunks: Buffer[] = [];
        socket.on('data', chunk => {
            chunks.push(chunk);
            const message = Buffer.concat(chunks);
            if (message.length < FRAME_HEADER_BYTES || message.length < FRAME_HEADER_BYTES + message.readUInt32BE(4)) {
                return;
            }
            const request = JSON.parse(gunzipSync(message.subarray(FRAME_HEADER_BYTES)).toString('utf8'));
            requests.push(request);
            const reply = answer(request);
            if (reply !== undefined) {
                socket.write(frame(reply));
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    return { port: typeof address === 'object' && address ? address.port : 0, server, requests };
}

const servers: Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

const twoNodes = (): ElkNode => ({
    id: 'root',
    children: [{ id: 'a{1}', width: 30, height: 20 }, { id: 'b"}', width: 30, height: 20 }],
    edges: [{ id: 'e', sources: ['a{1}'], targets: ['b"}'] }]
});

describe('a layout on the ELK server', () => {
    it('is sent framed and compressed, and its answer written into the graph, braces in ids and all', async () => {
        const { port, server, requests } = await fakeServer(() => ({
            root: { position: { x: 0, y: 0 }, size: { width: 104, height: 44 } },
            'a{1}': { position: { x: 12, y: 12 } },
            'b"}': { position: { x: 62, y: 12 } },
            e: { route: [{ x: 42, y: 22 }, { x: 62, y: 22 }] }
        }));
        servers.push(server);

        const graph = await layoutOnServer(port, twoNodes(), 5000);

        expect(requests[0].children.map((c: any) => c.id)).toEqual(['a{1}', 'b"}']);
        expect(graph.width).toBe(104);
        expect(graph.children?.[1]).toMatchObject({ x: 62, y: 12 });
        expect(graph.edges?.[0].sections?.[0]).toMatchObject({ startPoint: { x: 42, y: 22 }, endPoint: { x: 62, y: 22 } });
    });

    it('compresses even a tiny request, which the server would not answer otherwise', async () => {
        const encoded = await encodeFrame('{}');

        expect(encoded.subarray(0, 4).equals(FRAME_MAGIC)).toBe(true);
        expect(gunzipSync(encoded.subarray(FRAME_HEADER_BYTES)).toString()).toBe('{}');
    });

    it('fails on the server’s error answer, and on silence past the timeout', async () => {
        const failing = await fakeServer(() => ({ message: 'boom', stack: [] }));
        const silent = await fakeServer(() => undefined);
        servers.push(failing.server, silent.server);

        await expect(layoutOnServer(failing.port, twoNodes(), 5000)).rejects.toThrow(/boom/);
        await expect(layoutOnServer(silent.port, twoNodes(), 200)).rejects.toThrow(/longer than 200 ms/);
    });
});

/** A child process that prints the server's ready line, or nothing. */
function fakeChild(ready: string | undefined): ChildProcess {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.pid = 4242;
    child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        child.emit('exit', 0, null);
        return true;
    };
    if (ready) {
        setTimeout(() => child.stderr.write(`INFO: ${ready}\n`), 5);
    }
    return child;
}

describe('the ELK server process', () => {
    const jar = __filename; // any file that exists stands in for the jar

    it('starts once, on demand, and answers with the port it says it listens on', async () => {
        const spawned: string[][] = [];
        const spawn: SpawnFunction = (_command, args) => {
            spawned.push(args);
            return fakeChild('ELK Gzip-Framed Server listening on /127.0.0.1:5123');
        };
        const process = new ElkServerProcess({ jar, javaOpts: '-Xmx1g' }, spawn);

        const [first, second] = await Promise.all([process.ensureStarted(), process.ensureStarted()]);

        expect(first).toBe(5123);
        expect(second).toBe(5123);
        expect(spawned).toEqual([['-Xmx1g', '-jar', jar, '--socket']]);
        process.dispose();
    });

    it('starts again after the process died', async () => {
        const children: ChildProcess[] = [];
        const spawn: SpawnFunction = () => {
            const child = fakeChild(`ELK Server listening on /127.0.0.1:${5200 + children.length}`);
            children.push(child);
            return child;
        };
        const process = new ElkServerProcess({ jar }, spawn);

        expect(await process.ensureStarted()).toBe(5200);
        children[0].kill();
        expect(await process.ensureStarted()).toBe(5201);
        process.dispose();
    });

    it('gives up, without throwing, when there is no jar or the server never says it listens', async () => {
        const never = new ElkServerProcess({ jar }, () => fakeChild(undefined), 50);
        const nojar = new ElkServerProcess({ jar: path.join(__dirname, 'no-such.jar') }, () => fakeChild('listening on /127.0.0.1:1'));

        expect(await never.ensureStarted()).toBeUndefined();
        expect(await nojar.ensureStarted()).toBeUndefined();
    });

    it('stays stopped once disposed', async () => {
        const process = new ElkServerProcess({ jar }, () => fakeChild('listening on /127.0.0.1:5300'));
        process.dispose();

        expect(await process.ensureStarted()).toBeUndefined();
    });
});

/** `count` nodes at the root, chained by edges. */
function chain(count: number): ElkNode {
    const children = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, width: 20, height: 10 }));
    const edges = children.slice(1).map((c, i) => ({ id: `e${i}`, sources: [`n${i}`], targets: [c.id] }));
    return { id: 'root', children, edges };
}

describe('the engine a graph goes to', () => {
    const elkjs = (): ELK & { calls: number } => {
        const elk: any = { calls: 0, layout: async (g: ElkNode) => { elk.calls++; return g; } };
        return elk;
    };
    const server = (port: number | undefined) => ({ starts: 0, ensureStarted: async function () { this.starts++; return port; } });

    it('counts nodes and edges at every depth', () => {
        expect(elkGraphSize({ id: 'r', children: [{ id: 'g', children: [{ id: 'x' }, { id: 'y' }], edges: [{ id: 'e', sources: ['x'], targets: ['y'] }] }] }))
            .toEqual({ nodes: 3, edges: 1 });
    });

    it('is the server past the size where the cheaper presets start, under auto', () => {
        expect(goesToServer('auto', { nodes: 150, edges: 400 })).toBe(false);
        expect(goesToServer('auto', { nodes: 151, edges: 0 })).toBe(true);
        expect(goesToServer('auto', { nodes: 10, edges: 401 })).toBe(true);
        expect(goesToServer('elk-server', { nodes: 1, edges: 0 })).toBe(true);
        expect(goesToServer('elkjs', { nodes: 5000, edges: 9000 })).toBe(false);
    });

    it('keeps a small graph on elkjs and never starts the server for it', async () => {
        const js = elkjs();
        const java = server(5000);
        await new SwitchingElk(js, java, { engine: 'auto' }, async g => g).layout(chain(20));

        expect(js.calls).toBe(1);
        expect(java.starts).toBe(0);
    });

    it('sends a large graph to the server', async () => {
        const js = elkjs();
        const sent: number[] = [];
        await new SwitchingElk(js, server(5000), { engine: 'auto' }, async (port, g) => { sent.push(port); return g; }).layout(chain(200));

        expect(sent).toEqual([5000]);
        expect(js.calls).toBe(0);
    });

    it('falls back to elkjs when the server cannot start or fails', async () => {
        const noServer = elkjs();
        await new SwitchingElk(noServer, server(undefined), { engine: 'elk-server' }).layout(chain(3));
        const failing = elkjs();
        await new SwitchingElk(failing, server(5000), { engine: 'elk-server' }, async () => { throw new Error('down'); }).layout(chain(3));

        expect(noServer.calls).toBe(1);
        expect(failing.calls).toBe(1);
    });
});

const JAR = path.resolve(__dirname, '../resources/elk-server/elk-server-0.2.0-all.jar');
const hasJava = spawnSync('java', ['-version']).status === 0;

describe.skipIf(!hasJava || !existsSync(JAR))('the shipped ELK server', () => {
    it('lays out a diagram through the platform’s layout engine', async () => {
        // Braces in every id, which the server's plain mode would hang on.
        const nodes = Array.from({ length: 12 }, (_, i) => ({
            id: `node:n{${i}}`, kind: 'task', label: `n{${i}}`, scope: 'root',
            ports: [{ id: `p:n{${i}}:in`, name: 'in', direction: 'in' }, { id: `p:n{${i}}:out`, name: 'out', direction: 'out' }]
        }));
        const edges = nodes.slice(1).map((n, i) => ({ id: `e{${i}}`, from: `p:n{${i}}:out`, to: `p:n{${i + 1}}:in`, scope: 'root' }));
        const root: any = convertToGModelRoot(new GraphGModelSource().transform({ version: '1', graph: { id: 'wf:chain', nodes, edges } } as any) as any);
        const byId = new Map<string, any>();
        const index = (e: any): void => { byId.set(e.id, e); (e.children ?? []).forEach(index); };
        index(root);
        const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
        const process = new ElkServerProcess({ jar: JAR, javaOpts: '-Xmx512m' });
        const elkjs = new (ElkConstructor as any)({ algorithms: ['layered'] });
        let elkjsCalls = 0;
        const counted = { ...elkjs, layout: (g: ElkNode, a?: any) => { elkjsCalls++; return elkjs.layout(g, a); }, terminateWorker: () => elkjs.terminateWorker() };
        const engine = new WorkflowElkLayoutEngine(
            () => new SwitchingElk(counted, process, { engine: 'elk-server' }),
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            modelState
        );
        try {
            await engine.layout();
        } finally {
            process.dispose();
        }

        const xs = [...byId.values()].filter(e => e.type?.startsWith?.('node')).map(e => e.position?.x ?? 0);
        // Laid out left to right along the chain, by the server alone.
        expect(elkjsCalls).toBe(0);
        expect(new Set(xs).size).toBe(12);
        expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
    }, 60_000);
});
