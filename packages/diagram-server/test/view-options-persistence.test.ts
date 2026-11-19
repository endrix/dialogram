/**
 * The reader's view options reach the client on the root model, and are kept
 * beside the file's layout.
 *
 * The record is one per file, not per view: what a reader hid is hidden in
 * every view of the file. It shares the layout file with the positions, so
 * every write of either keeps the other.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEW_OPTIONS_ARG } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';

const groups = [
    { id: 'kinds', label: 'Kinds', items: [{ id: 'a', label: 'A', color: '#ff0000' }, { id: 'b', label: 'B', checked: false }] }
];

const doc = (viewOptions?: unknown): PyGraphDocument => ({
    version: '1',
    graph: { id: 'root', nodes: [], edges: [] },
    ...(viewOptions ? { viewOptions } : {})
});

describe('the view options on the root model', () => {
    it('are published as JSON when the graph declares some, made safe', () => {
        const root: any = new GraphGModelSource({} as any).transform(doc(groups)).graph;

        expect(JSON.parse(root.args[VIEW_OPTIONS_ARG])).toEqual([
            {
                id: 'kinds',
                label: 'Kinds',
                items: [
                    { id: 'a', label: 'A', checked: true, color: '#ff0000' },
                    { id: 'b', label: 'B', checked: false }
                ]
            }
        ]);
    });

    it('are absent when it declares none, as before', () => {
        const root: any = new GraphGModelSource({} as any).transform(doc()).graph;
        expect(root.args?.[VIEW_OPTIONS_ARG]).toBeUndefined();
        const empty: any = new GraphGModelSource({} as any).transform(doc([])).graph;
        expect(empty.args?.[VIEW_OPTIONS_ARG]).toBeUndefined();
    });
});

describe('the view options in the layout file', () => {
    async function withService(run: (service: LayoutPersistenceService, file: string, dir: string) => Promise<void>): Promise<void> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-options-'));
        try {
            await run(new LayoutPersistenceService(0), path.join(dir, 'top.sv'), dir);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
    const read = async (service: LayoutPersistenceService, file: string): Promise<any> =>
        JSON.parse(await fs.readFile(service.getLayoutFilePath(file), 'utf-8'));

    it('are read back as they were kept, by a service of another session', async () => {
        await withService(async (service, file) => {
            await service.saveViewOptions(file, { kinds: { b: true } });

            expect(await new LayoutPersistenceService(0).loadViewOptions(file)).toEqual({ kinds: { b: true } });
            expect((await read(service, file)).viewOptions).toEqual({ kinds: { b: true } });
        });
    });

    it('survive a write of the positions, and the positions survive a write of them', async () => {
        await withService(async (service, file) => {
            await service.saveLayoutImmediate(file, 'top', new Map([['u1', { x: 1, y: 2 }]]));
            await service.saveViewOptions(file, { kinds: { a: false } });
            await service.saveLayoutImmediate(file, 'top', new Map([['u1', { x: 5, y: 6 }]]));
            await service.savePortBuses(file, 'top', new Map([['u1', new Set(['bus'])]]));

            const written = await read(service, file);
            expect(written.viewOptions).toEqual({ kinds: { a: false } });
            expect(written.layouts.top.nodes.u1).toEqual({ x: 5, y: 6 });
            expect(await service.loadLayout(file, 'top')).toEqual(new Map([['u1', { x: 5, y: 6 }]]));
        });
    });

    it('are taken away by an empty choice, and make no file of their own when there is nothing to keep', async () => {
        await withService(async (service, file) => {
            await service.saveViewOptions(file, {});
            await expect(fs.stat(service.getLayoutFilePath(file))).rejects.toThrow();

            await service.saveViewOptions(file, { kinds: { a: false } });
            await service.saveViewOptions(file, {});
            expect(await service.loadViewOptions(file)).toBeUndefined();
            expect((await read(service, file)).viewOptions).toBeUndefined();
        });
    });

    it('are written one at a time with the positions, from two services at once', async () => {
        await withService(async (service, file) => {
            const other = new LayoutPersistenceService(0);
            await Promise.all([
                service.saveLayoutImmediate(file, 'top', new Map([['u1', { x: 1, y: 2 }]])),
                other.saveViewOptions(file, { kinds: { a: false } }),
                service.savePortBuses(file, 'top', new Map([['u1', new Set(['bus'])]]))
            ]);

            const written = await read(service, file);
            expect(written.viewOptions).toEqual({ kinds: { a: false } });
            expect(written.layouts.top.nodes.u1).toEqual({ x: 1, y: 2 });
            expect(written.layouts.top.portBuses).toEqual({ u1: ['bus'] });
        });
    });
});
