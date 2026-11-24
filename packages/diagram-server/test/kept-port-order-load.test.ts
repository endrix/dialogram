import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { GNode, GPort, type GModelElement } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { definitionKeyOf, regridPortRows, sidesOf, type SideOrder } from '../src/model/definition-port-order';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

const port = (name: string, direction: 'in' | 'out') => ({ id: `${name}:${direction}`, name, direction });
const stage = (id: string) => ({
    id, kind: 'task', label: id, type: 'Stage', scope: 'root',
    ports: [port('A', 'in'), port('B', 'in'), port('C', 'in'), port('Out', 'out')].map(p => ({ ...p, id: `${id}.${p.id}` }))
});
const DOC = { version: '1', graph: { id: 'wf:flow', nodes: [stage('node:s1'), stage('node:s2')], edges: [] } };

function nodesOf(root: GModelElement | undefined): GNode[] {
    const found: GNode[] = [];
    const visit = (element: GModelElement): void => {
        if (element instanceof GNode && element.children?.some(child => child instanceof GPort)) {
            found.push(element);
        }
        (element.children ?? []).forEach(visit);
    };
    if (root) {
        visit(root);
    }
    return found;
}

/**
 * Load DOC through the storage with `kept` as the file's port orders; with
 * `current`, as a rebuild does, the diagram drawn now being `drawnNow`.
 */
async function load(kept: Record<string, SideOrder> | undefined, rebuild?: { drawnNow: GModelElement }): Promise<GNode[]> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kept-order-'));
    const file = path.join(dir, 'flow.py');
    await fs.writeFile(file, '# flow\n');
    const uri = URI.file(file).toString();
    const state = new Map<string, unknown>();
    let root: GModelElement | undefined;
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wf', operationPrefix: 'wf' };
    storage.ensureModelSource = () => undefined;
    storage.modelState = {
        root: rebuild?.drawnNow,
        set: (k: string, v: unknown) => state.set(k, v),
        get: (k: string) => state.get(k),
        updateRoot: (r: GModelElement) => { root = r; }
    };
    storage.layoutPersistence = {
        loadLayout: async () => undefined,
        loadEdgeRoutes: async () => undefined,
        loadPortBuses: async () => undefined,
        loadPortOrders: async () => kept
    };
    const current = rebuild
        ? { positions: new Map([['node:s1', { x: 0, y: 0 }]]), routes: new Map() }
        : undefined;
    try {
        await storage.finishLoadFromDoc(DOC, uri, file, { sourceUri: uri, networkName: 'flow' }, undefined, current);
    } catch {
        // Past the root the load needs a live session; the root is what this tests.
    }
    await fs.rm(dir, { recursive: true, force: true });
    return nodesOf(root);
}

describe('loading a diagram whose file keeps a port order', () => {
    it('draws each instance of the definition in it', async () => {
        const plain = await load(undefined);
        expect(plain.length).toBe(2);
        expect(sidesOf(plain[0], 'drawn').west).toEqual(['A', 'B', 'C']);
        const key = definitionKeyOf(plain[0])!;

        const kept = await load({ [key]: { west: ['C', 'A', 'B'] } });
        for (const node of kept) {
            expect(sidesOf(node, 'drawn').west).toEqual(['C', 'A', 'B']);
            expect(sidesOf(node, 'source').west).toEqual(['A', 'B', 'C']);
        }
        // The same rows, in another order.
        const rows = (node: GNode) => (node.children ?? []).filter((c): c is GPort => c instanceof GPort)
            .map(p => p.position!.y).sort((a, b) => a - b);
        expect(rows(kept[0])).toEqual(rows(plain[0]));
        expect(kept[0].args?.[WorkflowDiagramMetadata.ENTITY_TYPE]).toBe('Stage');
    });

    it('keeps the order drawn now when it is built again from the same document', async () => {
        const [first] = await load(undefined);
        const key = definitionKeyOf(first)!;
        const drawnNow = await load({ [key]: { west: ['C', 'A', 'B'] } });
        // An undo drew B, A, C since, which no save has said.
        for (const node of drawnNow) {
            const id = (name: string) => (node.children ?? []).find(c => c instanceof GPort
                && c.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] === 'input'
                && c.args?.[WorkflowDiagramMetadata.PORT_NAME] === name)!.id;
            regridPortRows(node, [id('B'), id('A'), id('C')]);
        }
        const parent = { id: 'g', children: drawnNow } as unknown as GModelElement;
        const rebuilt = await load({ [key]: { west: ['C', 'A', 'B'] } }, { drawnNow: parent });
        for (const node of rebuilt) {
            expect(sidesOf(node, 'drawn').west).toEqual(['B', 'A', 'C']);
        }
    });
});
