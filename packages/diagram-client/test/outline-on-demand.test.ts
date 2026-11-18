/**
 * The outline on demand, without a DOM: the rows as a flat list of one
 * height, which of them a scroll position shows, a lazy group's rows asked
 * of the host a page at a time, and the words a row says.
 */
import { describe, expect, it } from 'vitest';
import {
    countInWords,
    normalizeOutlinePage,
    normalizeOutlinePageRequest,
    OUTLINE_PAGE_MAX,
    type HierarchyOutlineEntry,
    type OutlinePage
} from '@dialogram/shared';
import {
    entryPath,
    indexOfEntry,
    indexOfPaged,
    lazyGroupPath,
    layOutOutline,
    OUTLINE_MAX_SCROLL_HEIGHT,
    OUTLINE_ROW_HEIGHT,
    pagesFor,
    rowTop,
    scrollGeometry,
    scrollTopFor,
    slotAt,
    visibleRows
} from '../src/outline-rows';
import { OutlinePager, type OutlinePagerTransport } from '../src/outline-pager';
import { groupCount, numericDetail, outlineMatches, rowMeta, shownDetail } from '../src/hierarchy-outline-tree';

const ROWS = 200_000;
const lazy: HierarchyOutlineEntry = {
    path: ['#rows'], workflowName: 'top', role: 'group', label: 'Rows', count: ROWS, lazy: { id: 'rows' },
    countNoun: { one: 'row', other: 'rows' }, children: []
};
const statics: HierarchyOutlineEntry = {
    path: ['#parts'], workflowName: 'top', role: 'group', label: 'Parts', children: [
        { path: ['#parts', 'p1'], workflowName: 'top', role: 'item', id: 'part-1', label: 'Part one', children: [] },
        { path: ['p2'], workflowName: 'top', role: 'node', nodeId: 'n2', label: 'Part two', children: [] }
    ]
};
const outline: HierarchyOutlineEntry = { path: [], workflowName: 'top', sourceUri: 'file:///w/top.x', nodeCount: 1, children: [statics, lazy] };

const shape = (expanded: string[], totals: Record<string, number | undefined> = {}, query = '') => ({
    expanded: new Set(['', ...expanded]),
    query,
    lazyTotal: (group: HierarchyOutlineEntry) => totals[group.lazy!.id]
});

describe('the rows as a list', () => {
    it('lists a closed tree as its open rows only', () => {
        const layout = layOutOutline(outline, shape([]));
        expect(layout.total).toBe(3);
        expect(slotAt(layout, 1)).toMatchObject({ kind: 'entry', entry: statics, depth: 1 });
        expect(slotAt(layout, 3)).toBeUndefined();
    });

    it('lists an open lazy group as one run of as many rows as the host says it has', () => {
        const before = layOutOutline(outline, shape(['#rows']));
        expect(before.total).toBe(3);
        const layout = layOutOutline(outline, shape(['#rows'], { rows: ROWS }));
        expect(layout.total).toBe(3 + ROWS);
        expect(slotAt(layout, 3)).toMatchObject({ kind: 'paged', group: lazy, position: 0, depth: 2, viewPath: [] });
        expect(slotAt(layout, 3 + 150_000)).toMatchObject({ kind: 'paged', position: 150_000 });
        expect(indexOfPaged(layout, lazy, 150_000)).toBe(150_003);
        expect(indexOfPaged(layout, lazy, ROWS)).toBe(-1);
        expect(indexOfEntry(layout, statics)).toBe(1);
    });

    it('keeps a lazy group under a filter until the host says it found nothing there', () => {
        expect(outlineMatches(lazy, 'zzz', () => undefined)).toBe(true);
        expect(outlineMatches(lazy, 'zzz', () => 0)).toBe(false);
        expect(outlineMatches(lazy, 'zzz', () => 3)).toBe(true);
        const layout = layOutOutline(outline, shape([], { rows: 3 }, 'zzz'));
        expect(layout.segments.map(segment => segment.kind)).toEqual(['entry', 'entry', 'paged']);
        expect(layout.total).toBe(5);
    });

    it('finds the rows down to a lazy group, and to a row by its id', () => {
        expect(lazyGroupPath(outline, 'rows')).toEqual([outline, lazy]);
        expect(lazyGroupPath(outline, 'none')).toEqual([]);
        expect(entryPath(outline, 'part-1').map(entry => entry.label ?? 'root')).toEqual(['root', 'Parts', 'Part one']);
        expect(entryPath(outline, 'p2').at(-1)!.label).toBe('Part two');
    });
});

describe('the rows in view', () => {
    it('are those the scroll shows and a few either side', () => {
        const window = visibleRows(150_000 * OUTLINE_ROW_HEIGHT, 440, OUTLINE_ROW_HEIGHT, ROWS);
        expect(window.first).toBe(150_000 - 8);
        expect(window.last).toBe(150_000 + 20 + 8);
        expect(window.last - window.first + 1).toBeLessThan(40);
        expect(visibleRows(0, 440, OUTLINE_ROW_HEIGHT, 0)).toEqual({ first: 0, last: -1, offset: 0 });
        expect(visibleRows(0, 440, OUTLINE_ROW_HEIGHT, 5)).toMatchObject({ first: 0, last: 4 });
    });

    it('scale a list taller than a browser scrolls, so its last row is still reached', () => {
        const total = 2_000_000;
        const view = 440;
        const { height, scale } = scrollGeometry(total, OUTLINE_ROW_HEIGHT, view);
        expect(height).toBe(OUTLINE_MAX_SCROLL_HEIGHT);
        expect(scale).toBeGreaterThan(1);
        const bottom = visibleRows(height - view, view, OUTLINE_ROW_HEIGHT, total, 0);
        expect(bottom.last).toBe(total - 1);
        // Drawn where the view is, whatever the scale.
        const top = rowTop(bottom.first, height - view, bottom.offset, OUTLINE_ROW_HEIGHT);
        expect(top).toBeGreaterThanOrEqual(height - view - OUTLINE_ROW_HEIGHT);
        expect(top).toBeLessThanOrEqual(height);
        expect(scrollGeometry(100, OUTLINE_ROW_HEIGHT, view)).toEqual({ height: 2200, scale: 1 });
    });

    it('scroll to a row: not at all when it is in view, else to put it in the middle', () => {
        expect(scrollTopFor(5, 0, 440, OUTLINE_ROW_HEIGHT, ROWS)).toBe(0);
        const top = scrollTopFor(150_003, 0, 440, OUTLINE_ROW_HEIGHT, ROWS + 3);
        const shown = visibleRows(top, 440, OUTLINE_ROW_HEIGHT, ROWS + 3, 0);
        expect(shown.first).toBeLessThanOrEqual(150_003);
        expect(shown.last).toBeGreaterThanOrEqual(150_003);
        const far = scrollTopFor(1_999_000, 0, 440, OUTLINE_ROW_HEIGHT, 2_000_000);
        const farShown = visibleRows(far, 440, OUTLINE_ROW_HEIGHT, 2_000_000, 0);
        expect(farShown.first).toBeLessThanOrEqual(1_999_000);
        expect(farShown.last).toBeGreaterThanOrEqual(1_999_000);
    });

    it('are on the pages of their positions', () => {
        expect(pagesFor(150_000, 150_036, 100)).toEqual([1500]);
        expect(pagesFor(95, 205, 100)).toEqual([0, 1, 2]);
        expect(pagesFor(5, 4, 100)).toEqual([]);
    });
});

/** A host of `count` rows named `row <n>`, which a filter matches by name; it counts what it was asked. */
function fakeHost(count = ROWS) {
    const asked: Array<{ group: string; offset: number; limit: number; query: string }> = [];
    const pending: Array<() => void> = [];
    let hold = false;
    const name = (index: number): string => `row ${index}`;
    const matching = (query: string): number[] | undefined => {
        if (query === '') {
            return undefined;
        }
        const found: number[] = [];
        for (let index = 0; index < count; index++) {
            if (name(index).includes(query)) {
                found.push(index);
            }
        }
        return found;
    };
    const transport: OutlinePagerTransport = {
        page: (group, offset, limit, query) => {
            asked.push({ group, offset, limit, query });
            const found = matching(query);
            const total = found ? found.length : count;
            const rows = [];
            for (let at = offset; at < Math.min(total, offset + limit); at++) {
                const index = found ? found[at] : at;
                rows.push({ id: `r${index}`, label: name(index), ...(index % 2 === 0 ? { nodeId: `n${index}` } : {}) });
            }
            const answer = { page: { total, offset, rows } as OutlinePage, ms: 1 };
            if (!hold) {
                return Promise.resolve(answer);
            }
            return new Promise(resolve => pending.push(() => resolve(answer)));
        },
        locate: async (_group, id, query) => {
            const index = Number(id.slice(1));
            const found = matching(query);
            return { index: found ? (found.indexOf(index) >= 0 ? found.indexOf(index) : undefined) : index };
        }
    };
    return {
        transport,
        asked,
        holdAnswers: () => { hold = true; },
        answerAll: () => { hold = false; pending.splice(0).forEach(answer => answer()); }
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the pages of a lazy group', () => {
    it('are asked for as they come into view, once each', async () => {
        const host = fakeHost();
        let changes = 0;
        const pager = new OutlinePager(host.transport, () => changes++, 100);

        expect(pager.total('rows', '')).toBeUndefined();
        await settle();
        expect(pager.total('rows', '')).toBe(ROWS);
        pager.want([{ group: 'rows', query: '', from: 149_990, to: 150_030 }]);
        await settle();
        expect(host.asked.map(ask => ask.offset)).toEqual([0, 149_900, 150_000]);
        expect(pager.row('rows', '', 150_000)).toEqual({ id: 'r150000', label: 'row 150000', nodeId: 'n150000' });
        pager.want([{ group: 'rows', query: '', from: 149_990, to: 150_030 }]);
        await settle();
        expect(host.asked).toHaveLength(3);
        expect(changes).toBeGreaterThan(0);
        expect(pager.timings.length).toBe(3);
    });

    it('forget a page the reader scrolled past before it was asked for', async () => {
        const host = fakeHost();
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        host.holdAnswers();
        for (let from = 0; from < 50_000; from += 1_000) {
            pager.want([{ group: 'rows', query: '', from, to: from + 30 }]);
        }
        host.answerAll();
        await settle();
        host.answerAll();
        await settle();
        // The two asked at once at the start, and where the scroll stopped.
        expect(host.asked.map(ask => ask.offset)).toEqual([0, 1_000, 49_000]);
        expect(pager.row('rows', '', 49_010)).toBeDefined();
    });

    it('are asked under the filter, which the host answers', async () => {
        const host = fakeHost();
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        pager.total('rows', '199999');
        await settle();
        expect(host.asked.at(-1)).toMatchObject({ query: '199999', offset: 0 });
        expect(pager.total('rows', '199999')).toBe(1);
        expect(pager.row('rows', '199999', 0)!.label).toBe('row 199999');
        // The rows without a filter are another listing, still there.
        expect(pager.known('rows', '')).toBeUndefined();
    });

    it('fetch the page a row is on when it is asked for by place, and find a row by its id', async () => {
        const host = fakeHost();
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        const row = await pager.rowAt('rows', '', 123_456);
        expect(row!.id).toBe('r123456');
        expect(host.asked.map(ask => ask.offset)).toEqual([123_400]);
        expect(await pager.locate('rows', 'r123450', '')).toBe(123_450);
        expect(await pager.locate('rows', 'r42', '')).toBe(42);
    });

    it('say why a page could not be had, and stop waiting for it', async () => {
        const pager = new OutlinePager({
            page: async () => ({ error: 'The producer threw' }),
            locate: async () => ({})
        }, () => undefined, 100);
        expect(await pager.rowAt('rows', '', 5)).toBeUndefined();
        expect(pager.failure('rows', '', 5)).toBe('The producer threw');
        expect(pager.total('rows', '')).toBe(0);
    });

    it('are all forgotten when the outline changes', async () => {
        const host = fakeHost();
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        await pager.rowAt('rows', '', 0);
        pager.reset();
        expect(pager.row('rows', '', 0)).toBeUndefined();
        expect(pager.known('rows', '')).toBeUndefined();
    });
});

describe('a page as the host passes it on', () => {
    it('keeps the request within bounds', () => {
        expect(normalizeOutlinePageRequest({ group: 'g', offset: -5.5, limit: 1e9, query: '  x ' }))
            .toEqual({ group: 'g', offset: 0, limit: OUTLINE_PAGE_MAX, query: 'x' });
    });

    it('keeps rows with an id, at most the limit, and a total no smaller than what it sent', () => {
        const page = normalizeOutlinePage({
            total: 1,
            rows: [{ id: 'a', label: ' A\nrow ' }, { label: 'no id' }, { id: 'b', badges: [{ text: '' }, { text: 'x', tone: 'info' }] }, { id: 'c' }]
        }, { group: 'g', offset: 10, limit: 2, query: '' });
        expect(page).toEqual({ total: 11, offset: 10, rows: [{ id: 'a', label: 'A row' }] });
        const page2 = normalizeOutlinePage({ total: 50, rows: [{ id: 'b', badges: [{ text: '' }, { text: 'x', tone: 'info' }] }] }, { group: 'g', offset: 0, limit: 5, query: '' });
        expect(page2.rows[0]).toEqual({ id: 'b', label: 'b', badges: [{ text: 'x', tone: 'info' }] });
        expect(normalizeOutlinePage(undefined, { group: 'g', offset: 0, limit: 5, query: '' })).toEqual({ total: 0, offset: 0, rows: [] });
    });
});

describe('the words a row says', () => {
    const view = (nodeCount: number): HierarchyOutlineEntry => ({ path: ['v'], workflowName: 'v', nodeCount, children: [] });
    const group = (extra: Partial<HierarchyOutlineEntry>, children = 3): HierarchyOutlineEntry => ({
        path: ['#g'], workflowName: 'top', role: 'group', label: 'Things',
        children: Array.from({ length: children }, (_, i) => ({ path: [`c${i}`], workflowName: 'c', role: 'node' as const, children: [] })),
        ...extra
    });

    it('count a view’s nodes in English: one node, many nodes', () => {
        expect(rowMeta(view(1)).text).toBe('1 node');
        expect(rowMeta(view(0)).text).toBe('0 nodes');
        expect(rowMeta(view(113_750)).text).toBe('113,750 nodes');
        expect(rowMeta({ ...view(1), countNoun: { one: 'cell', other: 'cells' } }).text).toBe('1 cell');
    });

    it('say a group’s count once, and drop a detail that only repeats it', () => {
        const repeated = group({ detail: '3' });
        expect(rowMeta(repeated).text).toBe('3');
        expect(shownDetail(repeated)).toBeUndefined();
        expect(shownDetail(group({ detail: 'from the library' }))).toBe('from the library');
        expect(numericDetail(group({ detail: '113,750' }))).toBe(113_750);
        expect(numericDetail(group({ detail: '1.5' }))).toBeUndefined();
        expect(rowMeta(group({ countNoun: { one: 'thing', other: 'things' } })).text).toBe('3 things');
    });

    it('say how much of a list cut short is listed, and say it right', () => {
        const cut = group({ truncated: true, count: 268 }, 200);
        expect(rowMeta(cut)).toEqual({ text: '200 of 268', title: 'The first 200 of 268 are listed' });
        // A producer that could only put the count in the detail.
        expect(rowMeta(group({ truncated: true, detail: '268' }, 200)).text).toBe('200 of 268');
        expect(rowMeta(group({ truncated: true }, 200))).toEqual({ text: '200+', title: '200 are listed; there are more' });
        // A view cut short is still one that nests itself or goes too deep.
        expect(rowMeta({ ...view(3), truncated: true }).title).toBe('Not expanded: it nests itself, or is too deep');
    });

    it('count a lazy group by what the host found, else by what it was told', () => {
        expect(rowMeta(lazy).text).toBe('200,000 rows');
        expect(rowMeta(lazy, 12).text).toBe('12 rows');
        expect(rowMeta(lazy, 1).text).toBe('1 row');
        expect(rowMeta({ ...lazy, count: undefined }).text).toBe('…');
        expect(groupCount(lazy)).toBe(ROWS);
        expect(countInWords(2, undefined)).toBe('2');
    });

    it('say nothing on the right of an item row', () => {
        expect(rowMeta({ path: ['i'], workflowName: 'w', role: 'item', children: [] }).text).toBe('');
    });
});
