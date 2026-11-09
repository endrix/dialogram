/**
 * Opening a bus grows its node; the nodes under it make room, and closing it,
 * undoing or redoing, moves exactly those back, when nothing has moved since.
 *
 * The rebuild here is the storage's: positions carried over absolute, by
 * layout key, then the groups sized around their members.
 */
import { describe, expect, it } from 'vitest';
import { GModelIndex } from '@eclipse-glsp/server';
import { GraphGModelSource } from '../src/model/graph-gmodel-source';
import { portBusStateOf } from '../src/model/port-bundles';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { relativeToParent, restoreGroupGeometry } from '../src/server/group-geometry';
import { collectNodePositions, nodeLayoutKeyOf } from '../src/server/layout-snapshot';
import { TogglePortBusCommand, WorkflowTogglePortBusOperationHandler } from '../src/operations/toggle-port-bus-handler';

type Point = { x: number; y: number };

const P = 'node:scope:root:u_prod';
const port = (node: string, name: string, direction: 'in' | 'out', group?: string, side?: string) =>
    ({ id: `port:${node}:${name}`, name, direction, ...(group ? { group } : {}), ...(side ? { side } : {}) });
// An AXI write channel: eight members, so opening it grows the node by far more than a column's gap.
const AXI = ['m_axi_awaddr', 'm_axi_awvalid', 'm_axi_awready', 'm_axi_wdata', 'm_axi_wvalid', 'm_axi_wready', 'm_axi_bresp', 'm_axi_bvalid'];
const simple = (label: string) => {
    const id = `node:scope:root:${label}`;
    return { id, kind: 'instance', label, scope: 'root', ports: [port(id, 'i', 'in'), port(id, 'o', 'out')] };
};

function makeDoc(inGroup: boolean): any {
    const producer = {
        id: P, kind: 'instance', label: 'u_prod', scope: 'root',
        ports: [port(P, 'clk', 'in'), ...AXI.map(name => port(P, name, name.endsWith('ready') ? 'in' : 'out', 'm_axi', 'east'))]
    };
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [producer, simple('u_cons'), simple('u_x'), simple('u_z')],
            edges: [],
            subgraphs: inGroup ? [{ id: 'scope:g', kind: 'group', label: 'g', nodes: [P, 'node:scope:root:u_cons'] }] : []
        }
    };
}

let session = 0;

function diagram(inGroup: boolean, positions: Record<string, Point>) {
    const doc = makeDoc(inGroup);
    let open = new Map<string, Set<string>>();
    let shownNetwork = 'live';
    const state: { root?: any; index?: GModelIndex } = {};
    const build = (at: Map<string, Point>): void => {
        const model: any = new GraphGModelSource().transform(doc, { portBuses: portBusStateOf(open) });
        const place = (element: any, origin: Point): void => {
            let next = { x: origin.x + (element.position?.x ?? 0), y: origin.y + (element.position?.y ?? 0) };
            if (typeof element.type === 'string' && element.type.startsWith('node:')) {
                const key = nodeLayoutKeyOf(element);
                const saved = key ? at.get(key) : undefined;
                if (saved) {
                    element.position = relativeToParent(saved, origin);
                    next = { ...saved };
                }
            }
            for (const child of element.children ?? []) {
                place(child, next);
            }
        };
        place(model.graph, { x: 0, y: 0 });
        const root: any = convertToGModelRoot(model);
        restoreGroupGeometry(root, undefined);
        const index = new GModelIndex();
        index.indexRoot(root);
        state.root = root;
        state.index = index;
    };
    build(new Map(Object.entries(positions)));
    const uri = `file:///w/room${++session}.sv`;
    const handler = new WorkflowTogglePortBusOperationHandler();
    (handler as any).modelState = {
        get root() { return state.root; },
        get index() { return state.index; },
        get: () => ({ documentUri: uri, workflowName: shownNetwork })
    };
    (handler as any).layoutPersistence = {
        savePortBuses: async (_file: string, _id: string, byNode: Map<string, Set<string>>) => {
            open = new Map([...byNode].map(([key, groups]) => [key, new Set(groups)]));
        }
    };
    (handler as any).sourceModelStorage = { rebuildFromLastDocument: async (current: any) => { build(current.positions); return true; } };
    const rerouted: string[][] = [];
    (handler as any).rerouteHandler = { runReroute: async (op: any) => { rerouted.push(op.elementIds); } };
    (handler as any).commandStack = { commands: [], flush() {} };

    const element = (id: string): any => state.index!.find(id);
    const at = (id: string): Point => collectNodePositions(state.root).get(id)!;
    const y = (id: string): number => at(id).y;
    const command = (): TogglePortBusCommand =>
        handler.createCommand({ kind: 'dialogram.togglePortBus', portId: 'u_prod_bus_m_axi' } as any) as TogglePortBusCommand;
    /** A drag: the node to an absolute position. */
    const drag = (id: string, to: Point): void => {
        const parent = element(id).parent;
        const origin = parent && parent.type !== 'graph' ? at(String(parent.id)) : { x: 0, y: 0 };
        element(id).position = { x: to.x - origin.x, y: to.y - origin.y };
    };
    const showOther = (other: boolean): void => {
        shownNetwork = other ? 'live/u_sub' : 'live';
    };
    return { handler, element, at, y, command, drag, showOther, rerouted };
}

const grown = (): number => {
    const closed = diagram(false, {}).element('u_prod').size.height;
    return closed;
};

describe('a toggle and its undo', () => {
    it.each([
        ['stacked 50 px under it', 50],
        ['100 px under it, past a column but in the growth’s reach', 100],
        ['10 px under it, placed by hand', 10]
    ])('put a node %s back where it was', async (_case, gap) => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + gap } });
        const toggle = d.command();
        await toggle.execute();
        const pushed = d.y('u_cons');
        expect(pushed).toBeGreaterThan(height + gap);
        await toggle.undo();
        expect(d.y('u_cons')).toBe(height + gap);
        await toggle.redo();
        expect(d.y('u_cons')).toBe(pushed);
    });

    it('move the whole column, and back', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 }, u_x: { x: 0, y: height + 50 + 60 + 120 } });
        const toggle = d.command();
        await toggle.execute();
        await toggle.undo();
        expect([d.y('u_cons'), d.y('u_x')]).toEqual([height + 50, height + 230]);
    });

    it('leave a node out of reach where it is', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 400 } });
        const toggle = d.command();
        await toggle.execute();
        expect(d.y('u_cons')).toBe(height + 400);
        await toggle.undo();
        expect(d.y('u_cons')).toBe(height + 400);
    });
});

describe('closing a bundle opened in the same session', () => {
    it('moves back what the opening pushed', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 } });
        await d.command().execute();
        await d.command().execute();
        expect(d.y('u_cons')).toBe(height + 50);
    });

    it('moves nothing once a pushed node was dragged since', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 }, u_x: { x: 300, y: 100 } });
        await d.command().execute();
        d.drag('u_cons', { x: 300, y: 210 });
        await d.command().execute();
        expect(d.at('u_cons')).toEqual({ x: 300, y: 210 });
    });

    it('moves nothing that would land on a node put in the room it left', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 }, u_x: { x: 600, y: 0 } });
        await d.command().execute();
        const pushed = d.y('u_cons');
        d.drag('u_x', { x: 0, y: height + 40 });
        await d.command().execute();
        expect(d.y('u_cons')).toBe(pushed);
    });
});

describe('an undo or redo skipped while another view was shown', () => {
    it('is not made up for by moving twice on the next one', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 } });
        const toggle = d.command();
        await toggle.execute();
        const pushed = d.y('u_cons');
        d.showOther(true);
        await toggle.undo();          // skipped: another view is shown
        d.showOther(false);
        await toggle.redo();          // the bundle is already open: nothing to do
        expect(d.y('u_cons')).toBe(pushed);
    });

    it('nor by pulling a node up onto the one above it', async () => {
        const height = grown();
        const d = diagram(false, { u_prod: { x: 0, y: 0 }, u_cons: { x: 0, y: height + 50 } });
        const toggle = d.command();
        await toggle.execute();
        await toggle.undo();
        d.showOther(true);
        await toggle.redo();          // skipped
        d.showOther(false);
        await toggle.undo();          // the bundle is already closed: nothing to do
        expect(d.y('u_cons')).toBe(height + 50);
    });
});

describe('a bundle inside a group', () => {
    it('grows the group and makes room under it, and closing gives both back', async () => {
        const height = grown();
        // u_prod and u_cons in g, 50 apart; u_z 50 under the group.
        const d = diagram(true, {
            'scope:scope:g': { x: 0, y: 0 },
            u_prod: { x: 40, y: 50 },
            u_cons: { x: 40, y: 50 + height + 50 },
            u_z: { x: 600, y: 0 }
        });
        const frame = (): { y: number; height: number } => ({ y: d.y('scope:scope:g'), height: d.element('scope:scope:g').size.height });
        const before = frame();
        d.drag('u_z', { x: 20, y: before.y + before.height + 50 });
        const zBefore = d.y('u_z');

        const toggle = d.command();
        await toggle.execute();
        const opened = frame();
        expect(opened.height).toBeGreaterThan(before.height);
        expect(d.y('u_z')).toBeGreaterThanOrEqual(opened.y + opened.height + 20);
        expect(d.rerouted.at(-1)).toContain('scope:scope:g');

        await toggle.undo();
        expect(frame()).toEqual(before);
        expect(d.y('u_z')).toBe(zBefore);
    });
});
