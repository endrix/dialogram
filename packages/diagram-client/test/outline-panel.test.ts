// @vitest-environment happy-dom
/**
 * The outline panel with a group of two hundred thousand rows that are the
 * host's, beside a static group: it opens the lazy group and asks for the
 * page in view, keeps the DOM to the rows in view wherever it is scrolled,
 * has the host answer a filter, hands a click on a row that is no node to
 * the product, and shows a row the product names on a page it has not read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    OUTLINE_ACTIVATE_MESSAGE,
    OUTLINE_REPLY_MESSAGE,
    OUTLINE_REQUEST_MESSAGE,
    OUTLINE_REVEAL_MESSAGE,
    type HierarchyOutlineEntry,
    type OutlinePageRow
} from '@dialogram/shared';
import { HierarchyOutlinePanel } from '../src/hierarchy-outline';
import { OUTLINE_ROW_HEIGHT } from '../src/outline-rows';

const FILE = 'file:///w/top.x';
const ROWS = 200_000;
const outline: HierarchyOutlineEntry = {
    path: [], workflowName: 'top', sourceUri: FILE, nodeCount: 1,
    children: [
        {
            path: ['#parts'], workflowName: 'top', role: 'group', label: 'Parts', children: [
                { path: ['#parts', 'one'], workflowName: 'top', role: 'item', id: 'part-1', label: 'Part one', children: [] },
                { path: ['two'], workflowName: 'top', role: 'node', nodeId: 'n-two', label: 'Part two', children: [] }
            ]
        },
        {
            path: ['#rows'], workflowName: 'top', role: 'group', label: 'Rows', count: ROWS, lazy: { id: 'rows' },
            countNoun: { one: 'row', other: 'rows' }, children: []
        }
    ]
};
const root = {
    id: 'graph', type: 'graph',
    args: { sourceUri: FILE, 'wf:hierarchy': JSON.stringify(outline) },
    children: [{ id: 'gl-1', type: 'node:x', args: { 'wf:graphNodeId': 'n-two' }, children: [] }]
};

/** The host: rows named `row <n>`, a filter matching by name; it answers on the window as VS Code does. */
class Host {
    readonly requests: any[] = [];
    readonly activations: any[] = [];
    private rowsOf(query: string): number[] | undefined {
        if (query === '') {
            return undefined;
        }
        const found: number[] = [];
        for (let index = 0; index < ROWS; index++) {
            if (`row ${index}`.includes(query)) {
                found.push(index);
            }
        }
        return found;
    }
    receive(message: any): boolean {
        if (message.type === OUTLINE_ACTIVATE_MESSAGE) {
            this.activations.push(message.payload);
            return true;
        }
        if (message.type !== OUTLINE_REQUEST_MESSAGE) {
            return true;
        }
        const request = message.payload;
        this.requests.push(request);
        const found = this.rowsOf(request.query);
        let payload: any;
        if (request.op === 'locate') {
            const index = Number(String(request.id).slice(1));
            payload = { requestId: request.requestId, index: found ? found.indexOf(index) : index };
        } else {
            const total = found ? found.length : ROWS;
            const rows: OutlinePageRow[] = [];
            for (let at = request.offset; at < Math.min(total, request.offset + request.limit); at++) {
                const index = found ? found[at] : at;
                rows.push({ id: `r${index}`, label: `row ${index}`, ...(index % 2 === 0 ? { nodeId: `n${index}` } : {}) });
            }
            payload = { requestId: request.requestId, page: { total, offset: request.offset, rows }, ms: 1 };
        }
        setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: OUTLINE_REPLY_MESSAGE, payload } })), 1);
        return true;
    }
}

class TestPanel extends HierarchyOutlinePanel {
    host = new Host();
    readonly dispatched: any[] = [];
    constructor() {
        super();
        (this as any).dispatcher = { dispatch: (action: unknown) => { this.dispatched.push(action); return Promise.resolve(); } };
        (this as any).editorContext = { sourceUri: FILE, diagramType: 'x' };
    }
    protected override postToHost(message: unknown): boolean {
        return this.host.receive(message);
    }
}

const until = async (condition: () => boolean, ms = 3000): Promise<void> => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > ms) {
            throw new Error('timed out');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
const body = (): HTMLElement => document.getElementById('workflow-hierarchy-outline-body')!;
const rows = (): HTMLElement[] => Array.from(body().querySelectorAll<HTMLElement>('.workflow-hierarchy-outline-row'));
const rowSaying = (text: string): HTMLElement | undefined =>
    rows().find(row => row.querySelector('.workflow-hierarchy-outline-label')?.textContent === text);

let panel: TestPanel;

beforeAll(() => {
    (globalThis as any).diagramIdentifier = { clientBehavior: { nestedNavigation: 'in-place' } };
});

afterAll(() => {
    delete (globalThis as any).diagramIdentifier;
});

beforeEach(() => {
    document.body.replaceChildren();
    try {
        localStorage.setItem('dialogram.hierarchyOutline.open', '1');
    } catch {
        // happy-dom has it
    }
    panel = new TestPanel();
    panel.modelRootChanged(root);
    // happy-dom lays nothing out: the body scrolls as far as it is told.
    let scrollTop = 0;
    Object.defineProperty(body(), 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = value; }, configurable: true });
});

const scrollTo = async (top: number): Promise<void> => {
    body().scrollTop = top;
    body().dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 30));
};

describe('the rows in view', () => {
    it('are measured once the spacer is set: a body that grows with it shows every row of a short outline', () => {
        // As in the browser: the body is its padding until the spacer is
        // tall, and then as tall as the spacer, up to the panel's limit.
        const element = body();
        Object.defineProperty(element, 'clientHeight', {
            get: () => {
                const spacer = element.querySelector<HTMLElement>('.workflow-hierarchy-outline-spacer');
                return 4 + Math.min(Number.parseFloat(spacer?.style.height || '0') || 0, 600);
            },
            configurable: true
        });
        const many: HierarchyOutlineEntry = {
            ...outline,
            children: [{
                path: ['#parts'], workflowName: 'top', role: 'group', label: 'Parts',
                children: Array.from({ length: 20 }, (_, index) => ({
                    path: ['#parts', `p${index}`], workflowName: 'top', role: 'item' as const, id: `p${index}`, label: `Part ${index}`, children: []
                }))
            }, outline.children[1]]
        };
        panel.modelRootChanged({ ...root, args: { ...root.args, 'wf:hierarchy': JSON.stringify(many) } });
        expect(rowSaying('Part 19')).toBeDefined();
        expect(rowSaying('Rows')).toBeDefined();
    });
});

describe('a lazy group', () => {
    it('says how many rows it has, once, and asks for none until it is opened', () => {
        const group = rowSaying('Rows')!;
        expect(group.querySelector('.workflow-hierarchy-outline-meta')!.textContent).toBe('200,000 rows');
        expect(group.querySelector('.workflow-hierarchy-outline-type')).toBeNull();
        expect(panel.host.requests).toEqual([]);
    });

    it('asks for the page in view when opened, and draws its rows', async () => {
        rowSaying('Rows')!.querySelector<HTMLElement>('[data-toggle]')!.click();
        await until(() => rowSaying('row 3') !== undefined);
        expect(panel.host.requests[0]).toMatchObject({ op: 'page', sourceUri: FILE, group: 'rows', offset: 0, query: '' });
        expect(rows().length).toBeLessThan(60);
    });

    it('keeps only the rows in view in the DOM, scrolled to row 150 000', async () => {
        rowSaying('Rows')!.querySelector<HTMLElement>('[data-toggle]')!.click();
        await until(() => rowSaying('row 3') !== undefined);
        // Row 150 000 of the group is the 150 006th of the list (the root, Parts and
        // its two rows, and Rows, before it).
        await scrollTo((150_000 + 5) * OUTLINE_ROW_HEIGHT);
        await until(() => rowSaying('row 150000') !== undefined);
        expect(rows().length).toBeLessThan(60);
        expect(panel.host.requests.map(request => request.offset)).toContain(150_000);
        const drawn = rowSaying('row 150000')!;
        expect(Number.parseFloat(drawn.style.top)).toBe((150_000 + 5) * OUTLINE_ROW_HEIGHT);
        const spacer = body().querySelector<HTMLElement>('.workflow-hierarchy-outline-spacer')!;
        expect(Number.parseFloat(spacer.style.height)).toBe((ROWS + 5) * OUTLINE_ROW_HEIGHT);
    });

    it('has the host answer a filter, and filters the static rows itself', async () => {
        const search = document.getElementById('workflow-hierarchy-outline-search') as HTMLInputElement;
        search.value = '199999';
        search.dispatchEvent(new Event('input'));
        await until(() => rowSaying('row 199999') !== undefined);
        expect(panel.host.requests.at(-1)).toMatchObject({ op: 'page', query: '199999', offset: 0 });
        expect(rowSaying('Rows')!.querySelector('.workflow-hierarchy-outline-meta')!.textContent).toBe('1 row');
        expect(rowSaying('Parts')).toBeUndefined();

        search.value = 'part one';
        search.dispatchEvent(new Event('input'));
        await until(() => rowSaying('Part one') !== undefined);
        expect(rowSaying('Part two')).toBeUndefined();
    });
});

describe('a click on a row', () => {
    it('that is no node of the graph hands its id to the product, and selects it', async () => {
        rowSaying('Rows')!.querySelector<HTMLElement>('[data-toggle]')!.click();
        await until(() => rowSaying('row 3') !== undefined);
        rowSaying('row 3')!.click();
        await until(() => panel.host.activations.length === 1);
        expect(panel.host.activations[0]).toEqual({ sourceUri: FILE, id: 'r3', group: 'rows', open: false });
        expect(rowSaying('row 3')!.classList.contains('selected')).toBe(true);

        rowSaying('row 5')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel.host.activations[1]).toEqual({ sourceUri: FILE, id: 'r5', group: 'rows', open: true });
    });

    it('that names a node finds it, as a node row does', async () => {
        // The groups of the view shown open with it; a lazy one does not.
        expect(rowSaying('Rows')!.getAttribute('aria-expanded')).toBe('false');
        rowSaying('Part two')!.click();
        await until(() => panel.dispatched.length > 0);
        expect(panel.dispatched[0]).toMatchObject({ kind: 'elementSelected', selectedElementsIDs: ['gl-1'] });
        expect(panel.host.activations).toEqual([]);
    });

    it('of the outline’s own that is the product’s (an item row) hands it its id', async () => {
        rowSaying('Part one')!.click();
        await until(() => panel.host.activations.length === 1);
        expect(panel.host.activations[0]).toEqual({ sourceUri: FILE, id: 'part-1', open: false });
    });
});

describe('a row the product names', () => {
    it('on a page not read yet: the group opens, the page comes, the row is selected and scrolled to', async () => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: OUTLINE_REVEAL_MESSAGE, payload: { sourceUri: FILE, group: 'rows', id: 'r150000', index: 150_000 } }
        }));
        await until(() => rowSaying('row 150000')?.classList.contains('selected') === true);
        expect(panel.host.requests.some(request => request.offset === 150_000)).toBe(true);
        expect(body().scrollTop).toBeGreaterThan(149_000 * OUTLINE_ROW_HEIGHT);
        expect(rows().length).toBeLessThan(60);
    });

    it('with no place given: the host is asked where it is', async () => {
        await panel.reveal({ group: 'rows', id: 'r123457' });
        expect(panel.host.requests.some(request => request.op === 'locate' && request.id === 'r123457')).toBe(true);
        expect(rowSaying('row 123457')?.classList.contains('selected')).toBe(true);
    });

    it('under a filter that hides it: the filter is cleared', async () => {
        const search = document.getElementById('workflow-hierarchy-outline-search') as HTMLInputElement;
        search.value = 'row 7';
        search.dispatchEvent(new Event('input'));
        await new Promise(resolve => setTimeout(resolve, 200));
        await panel.reveal({ group: 'rows', id: 'r42' });
        expect(search.value).toBe('');
        expect(rowSaying('row 42')?.classList.contains('selected')).toBe(true);
    });

    it('of the outline’s own: the rows down to it open and it is selected', async () => {
        await panel.reveal({ id: 'part-1' });
        expect(rowSaying('Part one')?.classList.contains('selected')).toBe(true);
    });

    it('while the outline is closed: shown when it opens, or opened with show', async () => {
        document.getElementById('workflow-hierarchy-outline-toggle')!.click();
        expect(document.getElementById('workflow-hierarchy-outline')!.hidden).toBe(true);
        await panel.reveal({ id: 'part-1', show: true });
        expect(document.getElementById('workflow-hierarchy-outline')!.hidden).toBe(false);
        expect(rowSaying('Part one')?.classList.contains('selected')).toBe(true);
    });
});
