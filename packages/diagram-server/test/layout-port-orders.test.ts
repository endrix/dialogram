import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';

const tempDirs: string[] = [];

async function workflowFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-port-orders-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'flow.py');
    await fs.writeFile(file, '# flow\n', 'utf-8');
    return file;
}

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

const STAGE = '["Stage","",["WEST:A","WEST:B"]]';
const MERGE = '["Merge","",["WEST:P","WEST:Q"]]';
const at = (x: number, y: number) => new Map([['n1', { x, y }]]);

describe('the port orders a layout file keeps', () => {
    it('are set and let go by a save of the layout, and read back', async () => {
        const file = await workflowFile();
        const svc = new LayoutPersistenceService(0);
        await svc.saveLayoutImmediate(file, 'main', at(1, 2), undefined, { set: { [STAGE]: { west: ['B', 'A'] }, [MERGE]: { west: ['Q', 'P'] } }, remove: [] });
        expect(await svc.loadPortOrders(file)).toEqual({ [STAGE]: { west: ['B', 'A'] }, [MERGE]: { west: ['Q', 'P'] } });

        // Another view of the file draws Merge in the source's order again.
        await svc.saveLayoutImmediate(file, 'other', at(3, 4), undefined, { set: {}, remove: [MERGE] });
        expect(await svc.loadPortOrders(file)).toEqual({ [STAGE]: { west: ['B', 'A'] } });

        await svc.saveLayoutImmediate(file, 'main', at(1, 2), undefined, { set: {}, remove: [STAGE] });
        expect(await svc.loadPortOrders(file)).toBeUndefined();
        const written = JSON.parse(await fs.readFile(svc.getLayoutFilePath(file), 'utf-8'));
        expect(written.portOrders).toBeUndefined();
    });

    it('survive every other write of the file', async () => {
        const file = await workflowFile();
        const svc = new LayoutPersistenceService(0);
        const kept = { [STAGE]: { west: ['B', 'A'] } };
        await svc.saveLayoutImmediate(file, 'main', at(1, 2), undefined, { set: kept, remove: [] });

        // A save of positions alone (a move), immediate and debounced.
        await svc.saveLayoutImmediate(file, 'main', at(5, 6));
        expect(await svc.loadPortOrders(file)).toEqual(kept);
        svc.saveLayout(file, 'main', at(7, 8));
        await svc.saveViewOptions(file, { edges: { labels: true } });
        expect(await svc.loadPortOrders(file)).toEqual(kept);
        expect(await svc.loadViewOptions(file)).toEqual({ edges: { labels: true } });

        await svc.savePortBuses(file, 'main', new Map([['n1', new Set(['req'])]]));
        expect(await svc.loadPortOrders(file)).toEqual(kept);
        await svc.saveUnwrittenStates(file, 'main', new Map([['s1', { x: 1, y: 1 }]]));
        expect(await svc.loadPortOrders(file)).toEqual(kept);
        await svc.saveViewOptions(file, {});
        expect(await svc.loadPortOrders(file)).toEqual(kept);
        expect(await svc.loadLayout(file, 'main')).toEqual(at(7, 8));
    });

    it('are none when persistence is off', async () => {
        const file = await workflowFile();
        const svc = new LayoutPersistenceService(0);
        await svc.saveLayoutImmediate(file, 'main', at(1, 2), undefined, { set: { [STAGE]: { west: ['B', 'A'] } }, remove: [] });
        process.env.WORKFLOW_DIAGRAM_DISABLE_PERSISTENCE = '1';
        try {
            expect(await new LayoutPersistenceService(0).loadPortOrders(file)).toBeUndefined();
        } finally {
            delete process.env.WORKFLOW_DIAGRAM_DISABLE_PERSISTENCE;
        }
    });
});
