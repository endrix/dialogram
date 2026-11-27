/**
 * A profile that keeps no layout record, and a record that cannot be written.
 *
 * The platform keeps a record of each view beside the source it lays out
 * (`.layout/<file>.layout.json`). A read-only product that opens files in
 * folders it does not own (another party's files, a tool's output) says so with
 * `storageOptions.keepLayoutRecord: false`: nothing is written there and nothing
 * read, by each session's service. The open bundles, the held states and the
 * view options are held in memory; the positions, routes and port orders are
 * not, and a model asked for again is laid out afresh. With the record kept,
 * a folder that cannot be written fails every save: that is said once per
 * file, as one line, and the diagram works on, holding the same as without a
 * record.
 */
import 'reflect-metadata';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import { ClientActionKinds, ClientId, GLSPClientProxy } from '@eclipse-glsp/server';
import type { DiagramModelSource } from '@dialogram/shared';
import { createWorkflowServerModules } from '../src/server/server-module';
import { STORAGE_RUNTIME_OPTIONS } from '../src/server/storage-runtime-options';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';

const tempDirs: string[] = [];

/** A source in a folder of its own, and where its record would be. */
async function source(): Promise<{ file: string; dir: string; record: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-record-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'top.src');
    await fs.writeFile(file, 'top { }\n', 'utf-8');
    return { file, dir, record: path.join(dir, '.layout') };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const STAGE = '["Stage","",["WEST:A","WEST:B"]]';
const at = (x: number, y: number) => new Map([['n1', { x, y }]]);

afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

const SOURCE: DiagramModelSource = { getGraph: async () => undefined };

/** A diagram session's container as GLSP makes it (see server-module-load-seams.test.ts). */
function session(serverModules: unknown[], first: ContainerModule[] = []): Container {
    const server = new Container();
    const proxyModule = new ContainerModule((bind) =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as any)
    );
    initializeContainer(server, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const modules = [...serverModule.diagramModules.values()][0];
    const container = server.createChild();
    container.load(...first, ...(modules as ContainerModule[]));
    for (const [token, value] of [[ClientId, 'client-1'], [ClientActionKinds, []]] as const) {
        if (container.isBound(token)) {
            container.rebind(token).toConstantValue(value);
        } else {
            container.bind(token).toConstantValue(value);
        }
    }
    return container;
}

describe('a service that keeps no layout record', () => {
    it('writes nothing beside the source, whatever it is asked to save', async () => {
        const { file, record } = await source();
        const svc = new LayoutPersistenceService(0, { persist: false });

        await svc.saveLayoutImmediate(file, 'main', at(1, 2), new Map([['e1', [{ x: 0, y: 0 }, { x: 5, y: 0 }]]]));
        svc.saveLayout(file, 'main', at(3, 4));
        await svc.flush();
        await svc.savePortBuses(file, 'main', new Map([['n1', new Set(['bus'])]]));
        await svc.saveUnwrittenStates(file, 'main', new Map([['s1', { x: 1, y: 1 }]]));
        await svc.saveViewOptions(file, { kinds: { b: false } });

        expect(await exists(record)).toBe(false);
    });

    it('reads nothing of a record that is there, and holds what the reader did for the session', async () => {
        const { file } = await source();
        const keeping = new LayoutPersistenceService(0);
        const routes = new Map([['e1', [{ x: 0, y: 0 }, { x: 5, y: 0 }]]]);
        await keeping.saveLayoutImmediate(file, 'main', at(1, 2), routes, { set: { [STAGE]: { west: ['B', 'A'] } }, remove: [] });
        await keeping.saveViewOptions(file, { kinds: { b: false } });
        expect(await keeping.loadPortOrders(file)).toEqual({ [STAGE]: { west: ['B', 'A'] } });
        expect(await keeping.loadEdgeRoutes(file, 'main')).toEqual(routes);

        const svc = new LayoutPersistenceService(0, { persist: false });
        expect(await svc.loadLayout(file, 'main')).toBeUndefined();
        expect(await svc.loadEdgeRoutes(file, 'main')).toBeUndefined();
        expect(await svc.loadPortOrders(file)).toBeUndefined();
        expect(await svc.loadViewOptions(file)).toBeUndefined();

        await svc.saveViewOptions(file, { kinds: { c: false } });
        await svc.savePortBuses(file, 'main', new Map([['n1', new Set(['bus'])]]));
        expect(await svc.loadViewOptions(file)).toEqual({ kinds: { c: false } });
        expect(await svc.loadPortBuses(file, 'main')).toEqual(new Map([['n1', new Set(['bus'])]]));
        // The record that was there is left as it was.
        expect(await keeping.loadViewOptions(file)).toEqual({ kinds: { b: false } });
        expect(await keeping.loadLayout(file, 'main')).toEqual(at(1, 2));
    });
});

describe('what a service that keeps no layout record does not hold', () => {
    it('the positions the reader moved, the routes and the port orders: a model asked for again is laid out afresh', async () => {
        const { file } = await source();
        const svc = new LayoutPersistenceService(0, { persist: false });
        await svc.saveLayoutImmediate(file, 'main', at(10, 20), new Map([['e1', [{ x: 0, y: 0 }, { x: 5, y: 0 }]]]), { set: { [STAGE]: { west: ['B', 'A'] } }, remove: [] });
        svc.saveLayout(file, 'main', at(30, 40));
        await svc.flush();

        expect(await svc.loadLayout(file, 'main')).toBeUndefined();
        expect(await svc.loadEdgeRoutes(file, 'main')).toBeUndefined();
        expect(await svc.loadPortOrders(file)).toBeUndefined();
    });
});

describe('a session of a profile that keeps no layout record', () => {
    const options = (keepLayoutRecord?: boolean) => ({
        modelSourceFactory: () => SOURCE,
        storageOptions: { settingsNamespace: 'fixture', operationPrefix: 'fixture', ...(keepLayoutRecord === undefined ? {} : { keepLayoutRecord }) }
    });

    it('has a layout service that writes nothing', async () => {
        const { file, record } = await source();
        const svc = session(createWorkflowServerModules(options(false))).get(LayoutPersistenceService);

        await svc.saveLayoutImmediate(file, 'main', at(1, 2));
        await svc.saveViewOptions(file, { kinds: { b: false } });

        expect(await exists(record)).toBe(false);
    });

    it('reads it from the options a consumer\'s own module binds, as every storage option is read', async () => {
        const { file, record } = await source();
        const consumers = new ContainerModule(bind => {
            bind(STORAGE_RUNTIME_OPTIONS).toConstantValue({ settingsNamespace: 'fixture', operationPrefix: 'fixture', keepLayoutRecord: false });
        });
        const svc = session(createWorkflowServerModules(options()), [consumers]).get(LayoutPersistenceService);

        await svc.saveLayoutImmediate(file, 'main', at(1, 2));

        expect(await exists(record)).toBe(false);
    });

    it('keeps the record as before where the profile says nothing, or says to keep it', async () => {
        for (const keepLayoutRecord of [undefined, true]) {
            const { file } = await source();
            const svc = session(createWorkflowServerModules(options(keepLayoutRecord))).get(LayoutPersistenceService);

            await svc.saveLayoutImmediate(file, 'main', at(1, 2));

            expect(await new LayoutPersistenceService(0).loadLayout(file, 'main'), String(keepLayoutRecord)).toEqual(at(1, 2));
        }
    });
});

describe('a layout record that cannot be written', () => {
    /** A source whose `.layout` is a plain file: no record can be made under it, whoever runs the test. */
    async function blocked(): Promise<{ file: string; record: string }> {
        const made = await source();
        await fs.writeFile(made.record, 'not a folder\n', 'utf-8');
        return made;
    }

    it('is said once per file, as one line, and the diagram works on', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { file, record } = await blocked();
        const svc = new LayoutPersistenceService(0);

        await svc.saveLayoutImmediate(file, 'main', at(1, 2));
        await svc.saveLayoutImmediate(file, 'main', at(3, 4));
        await svc.savePortBuses(file, 'main', new Map([['n1', new Set(['bus'])]]));
        await svc.saveViewOptions(file, { kinds: { b: false } });
        // A second session of the same file (the editor opened again).
        await new LayoutPersistenceService(0).saveLayoutImmediate(file, 'main', at(5, 6));

        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        const said = warn.mock.calls[0];
        expect(said).toHaveLength(1);
        expect(typeof said[0]).toBe('string');
        expect(said[0]).not.toContain('\n');
        expect(said[0]).toContain(path.join(record, 'top.src.layout.json'));
        // What could not be written still holds for the session.
        expect(await svc.loadViewOptions(file)).toEqual({ kinds: { b: false } });
        expect(await svc.loadPortBuses(file, 'main')).toEqual(new Map([['n1', new Set(['bus'])]]));
    });

    /** Each save that writes the record, and how to make it write. */
    const saves: Array<[string, (svc: LayoutPersistenceService, file: string, n: number) => Promise<void>]> = [
        ['the layout', (svc, file, n) => svc.saveLayoutImmediate(file, 'main', at(n, n))],
        ['the open bundles', (svc, file, n) => svc.savePortBuses(file, 'main', new Map([['n1', new Set([`bus${n}`])]]))],
        ['the held states', (svc, file, n) => svc.saveUnwrittenStates(file, 'main', new Map([['s1', { x: n, y: n }]]))],
        ['the view options', (svc, file, n) => svc.saveViewOptions(file, { kinds: { [`b${n}`]: false } })]
    ];

    for (const [what, save] of saves) {
        it(`is said once as a warning for a save of ${what}, and again after such a save there worked`, async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const { file, record } = await blocked();
            const svc = new LayoutPersistenceService(0);

            await save(svc, file, 1);
            await save(svc, file, 2);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(error).not.toHaveBeenCalled();

            await fs.rm(record);
            await save(svc, file, 3);
            expect(await exists(path.join(record, 'top.src.layout.json'))).toBe(true);
            await fs.rm(record, { recursive: true });
            await fs.writeFile(record, 'not a folder\n', 'utf-8');
            await save(svc, file, 4);
            expect(warn).toHaveBeenCalledTimes(2);
            expect(error).not.toHaveBeenCalled();
        });
    }

    it('is said for each file that cannot be written, and again after a write there worked', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const first = await blocked();
        const second = await blocked();
        const svc = new LayoutPersistenceService(0);

        await svc.saveLayoutImmediate(first.file, 'main', at(1, 2));
        await svc.saveLayoutImmediate(second.file, 'main', at(1, 2));
        expect(warn).toHaveBeenCalledTimes(2);

        await fs.rm(first.record);
        await svc.saveLayoutImmediate(first.file, 'main', at(1, 2));
        expect(warn).toHaveBeenCalledTimes(2);

        await fs.rm(first.record, { recursive: true });
        await fs.writeFile(first.record, 'not a folder\n', 'utf-8');
        await svc.saveLayoutImmediate(first.file, 'main', at(3, 4));
        expect(warn).toHaveBeenCalledTimes(3);
    });
});
