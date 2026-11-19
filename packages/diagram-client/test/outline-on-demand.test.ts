/**
 * The outline on demand, without a DOM: the rows as a flat list of one
 * height, which of them a scroll position shows, a lazy group's rows asked
 * of the host a page at a time, and the words a row says.
 */
import { describe, expect, it, vi } from 'vitest';
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
    rowTop,
    scrollGeometry,
    scrollTopFor,
    slotAt,
    visibleRows
} from '../src/outline-rows';
import { OutlinePager, type OutlinePagerTransport } from '../src/outline-pager';
import { groupCount, numericDetail, outlineMatches, rowId, rowMeta, shownDetail } from '../src/hierarchy-outline-tree';

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

    it('a page shorter than asked: the rest is asked from where it stopped, and the rows are where they belong', async () => {
        const asked: Array<{ offset: number; limit: number }> = [];
        // A producer that reads at most 30 rows at a time, of 1,000.
        const pager = new OutlinePager({
            page: async (_group, offset, limit) => {
                asked.push({ offset, limit });
                const rows = [];
                for (let at = offset; at < Math.min(1000, offset + Math.min(limit, 30)); at++) {
                    rows.push({ id: `r${at}`, label: `row ${at}` });
                }
                return { page: { total: 1000, offset, rows } };
            },
            locate: async () => ({})
        }, () => undefined, 100);
        expect((await pager.rowAt('rows', '', 50))?.id).toBe('r50');
        pager.want([{ group: 'rows', query: '', from: 60, to: 99 }]);
        for (let i = 0; i < 10; i++) {
            await settle();
        }
        expect(asked).toEqual([{ offset: 0, limit: 100 }, { offset: 30, limit: 70 }, { offset: 60, limit: 40 }, { offset: 90, limit: 10 }]);
        for (const position of [0, 29, 30, 59, 60, 99]) {
            expect(pager.row('rows', '', position)?.id).toBe(`r${position}`);
        }
        expect(pager.failure('rows', '', 99)).toBeUndefined();
        // The last page ends at the total, not at a page's worth.
        expect((await pager.rowAt('rows', '', 999))?.id).toBe('r999');
        expect(asked.filter(ask => ask.offset >= 900).map(ask => ask.offset)).toEqual([900, 930, 960, 990]);
    });

    it('a page that stops short of the total with nothing more is shown as not loaded, and not asked again', async () => {
        const asked: number[] = [];
        // Ten rows, then nothing, though it counts 1,000.
        const pager = new OutlinePager({
            page: async (_group, offset) => {
                asked.push(offset);
                const rows = offset === 0 ? Array.from({ length: 10 }, (_, at) => ({ id: `r${at}`, label: `row ${at}` })) : [];
                return { page: { total: 1000, offset, rows } };
            },
            locate: async () => ({})
        }, () => undefined, 100);
        expect(await pager.rowAt('rows', '', 50)).toBeUndefined();
        expect(asked).toEqual([0, 10]);
        expect(pager.row('rows', '', 9)?.id).toBe('r9');
        expect(pager.failure('rows', '', 50)).toBe('No rows came from row 11 on, of 1,000');
        pager.want([{ group: 'rows', query: '', from: 0, to: 60 }]);
        await settle();
        expect(await pager.rowAt('rows', '', 70)).toBeUndefined();
        expect(asked).toEqual([0, 10]);
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

/**
 * The outline of `groups` lazy groups of 500 rows each, laid out again after
 * every answer and asking for what it shows, as the panel's `render()` does:
 * every lazy group's count under a filter, every opened one's without.
 * `perFrame` lays it out at most once a frame instead, as the panel's
 * `relayout()` does; `hostMs` is how long the host takes to answer; `type`
 * changes the filter, as the panel's `setFilter` does.
 */
function outlineOfLazyGroups(groups: number, query: string, options: { hostMs?: number; perFrame?: boolean } = {}) {
    const lazies: HierarchyOutlineEntry[] = Array.from({ length: groups }, (_, at) => ({
        path: [`#g${at}`], workflowName: 'top', role: 'group', label: `Group ${at}`, count: 500, lazy: { id: `g${at}` }, children: []
    }));
    const root: HierarchyOutlineEntry = { path: [], workflowName: 'top', children: lazies };
    const asked: string[] = [];
    /** Every request, with its filter. */
    const requests: Array<{ group: string; offset: number; query: string }> = [];
    let answering = 0;
    let largestQueue = 0;
    let filter = query;
    let stopped = false;
    let frameQueued = false;
    const redraw = (): void => {
        if (!options.perFrame) {
            setTimeout(render, 0);
        } else if (!frameQueued) {
            frameQueued = true;
            setTimeout(() => {
                frameQueued = false;
                render();
            }, 16);
        }
    };
    const pager: OutlinePager = new OutlinePager({
        page: (group, offset, limit, asking) => {
            asked.push(`${group}@${offset}`);
            requests.push({ group, offset, query: asking });
            answering++;
            const rows = Array.from({ length: Math.min(limit, 500 - offset) }, (_, at) => ({ id: `r${offset + at}`, label: `row ${offset + at}` }));
            // The host answers a little later, as over the webview's messages.
            return new Promise(resolve => setTimeout(() => {
                answering--;
                resolve({ page: { total: 500, offset, rows } });
            }, options.hostMs ?? 1));
        },
        locate: async () => ({})
    }, redraw, 100);
    /** The pager's queue of pages asked for by name. */
    const queue = (): number => (pager as unknown as { asked: unknown[] }).asked.length;
    function render(): void {
        if (stopped) {
            return;
        }
        const query = filter;
        const layout = layOutOutline(root, {
            expanded: new Set(['', ...(query === '' ? lazies.map(rowId) : [])]),
            query,
            lazyTotal: group => pager.total(group.lazy!.id, query)
        });
        largestQueue = Math.max(largestQueue, queue());
        const { first, last } = visibleRows(0, 440, OUTLINE_ROW_HEIGHT, layout.total);
        const shown = new Map<string, { group: string; query: string; from: number; to: number }>();
        for (let index = first; index <= last; index++) {
            const slot = slotAt(layout, index);
            if (slot?.kind === 'paged') {
                const group = slot.group.lazy!.id;
                const range = shown.get(group);
                shown.set(group, range ? { ...range, to: slot.position } : { group, query, from: slot.position, to: slot.position });
            }
        }
        pager.want([...shown.values()]);
    }
    render();
    /** How many groups the host has counted under the filter typed last. */
    const counted = (): number => lazies.filter(group => pager.known(group.lazy!.id, filter) !== undefined).length;
    return {
        asked,
        requests,
        counted,
        largestQueue: () => largestQueue,
        /** Every count of the filter typed last is here, and nothing is asked or on its way. */
        settled: () => counted() === groups && answering === 0 && queue() === 0,
        type: (typed: string) => {
            filter = typed;
            render();
        },
        stop: () => { stopped = true; }
    };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('the pages of many lazy groups', () => {
    for (const groups of [13, 40]) {
        for (const query of ['', 'row']) {
            it(`are each asked for once, with ${groups} groups ${query === '' ? 'opened, no filter' : 'under a filter'}`, async () => {
                const outline = outlineOfLazyGroups(groups, query);
                try {
                    await pause(250);
                    const settled = outline.asked.length;
                    await pause(150);
                    // Each group's first page, which carries its count; nothing after.
                    expect(outline.asked.length).toBe(settled);
                    expect(new Set(outline.asked).size).toBe(outline.asked.length);
                    expect(outline.asked.length).toBe(groups);
                } finally {
                    outline.stop();
                }
            });
        }
    }
});

describe('the counts of many lazy groups while the reader types', () => {
    // Ten keystrokes, each reaching the host's filter (160 ms apart, past the
    // panel's 150 ms wait): eleven filters with the one before the first. The
    // counts of a filter come eight at a time: 13 groups take two answers, 40
    // take five, so at 100 ms for 13 and at 50 ms for 40 the reader types
    // before the counts before have all come.
    const word = 'abcdefghij';
    const filters = word.length + 1;
    for (const groups of [13, 40]) {
        for (const hostMs of [20, 50, 100]) {
            for (const perFrame of [true, false]) {
                it(`asks each at most once a filter: ${groups} groups, the host answering in ${hostMs} ms, laid out ${perFrame ? 'once a frame' : 'after every answer'}`, async () => {
                    vi.useFakeTimers();
                    const outline = outlineOfLazyGroups(groups, '', { hostMs, perFrame });
                    try {
                        for (let typed = 1; typed <= word.length; typed++) {
                            await vi.advanceTimersByTimeAsync(160);
                            outline.type(word.slice(0, typed));
                        }
                        let shownAfter: number | undefined;
                        for (let waited = 0; ; waited += 5) {
                            if (shownAfter === undefined && outline.counted() === groups) {
                                shownAfter = waited;
                            }
                            // Ten times what asking each filter once costs is enough to fail on.
                            if (outline.settled() || waited >= 5_000 || outline.requests.length > 10 * groups * filters) {
                                break;
                            }
                            await vi.advanceTimersByTimeAsync(5);
                        }
                        const settled = outline.requests.length;
                        await vi.advanceTimersByTimeAsync(1_000);

                        // Nothing after it settled, and no group asked twice under one filter.
                        expect(outline.requests.length).toBe(settled);
                        expect(new Set(outline.requests.map(ask => `${ask.group}\u0000${ask.query}`)).size).toBe(settled);
                        expect(settled).toBeLessThanOrEqual(groups * filters);
                        // One entry a page, and what was queued under a filter left
                        // goes at the first answer after, which comes before the
                        // next keystroke: two filters' counts at most.
                        expect(outline.largestQueue()).toBeLessThanOrEqual(2 * groups);
                        // Every count of the last filter, as soon as the host can
                        // give them: what is on its way when the reader types,
                        // then eight at a time.
                        expect(outline.counted()).toBe(groups);
                        expect(shownAfter).toBeDefined();
                        expect(shownAfter!).toBeLessThanOrEqual((Math.ceil(groups / 8) + 1) * hostMs + 5);
                    } finally {
                        outline.stop();
                        vi.useRealTimers();
                    }
                });
            }
        }
    }

    it('drops a count queued under a filter the reader has left, and asks it again when the filter is back', async () => {
        const host = fakeHost(1_000);
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        const groups = Array.from({ length: 10 }, (_, at) => `g${at}`);
        const under = (query: string) => host.asked.filter(ask => ask.query === query).map(ask => ask.group);
        host.holdAnswers();
        // Eight asked at once, two queued.
        groups.forEach(group => pager.total(group, 'row 1'));
        groups.forEach(group => pager.total(group, 'row 2'));
        for (let i = 0; i < 5; i++) {
            host.answerAll();
            await settle();
        }
        expect(under('row 1')).toEqual(groups.slice(0, 8));
        expect(groups.every(group => pager.known(group, 'row 2') === 111)).toBe(true);

        // Back to the first filter: the two dropped are asked now.
        groups.forEach(group => pager.total(group, 'row 1'));
        for (let i = 0; i < 5; i++) {
            host.answerAll();
            await settle();
        }
        expect(under('row 1').filter(group => group === 'g8' || group === 'g9')).toEqual(['g8', 'g9']);
        expect(groups.every(group => pager.known(group, 'row 1') === 111)).toBe(true);
    });

    it('still asks a page queued under a filter the reader has left when a caller waits for it', async () => {
        const host = fakeHost(1_000);
        const pager = new OutlinePager(host.transport, () => undefined, 100);
        // More than the panel keeps of other filters than the one in use.
        const groups = Array.from({ length: 16 }, (_, at) => `g${at}`);
        host.holdAnswers();
        groups.forEach(group => pager.total(group, 'row 1'));
        // A reveal under the first filter, waiting on a page that is queued, and
        // one that is not asked yet.
        const queued = pager.rowAt('g9', 'row 1', 5);
        groups.forEach(group => pager.total(group, 'row 2'));
        const after = pager.rowAt('g8', 'row 1', 105);
        let answered = 0;
        void Promise.all([queued, after]).then(() => answered++);
        for (let i = 0; i < 8; i++) {
            host.answerAll();
            await settle();
        }
        expect(answered).toBe(1);
        expect((await queued)?.label).toBe('row 14');
        expect((await after)?.label).toBe('row 194');
        expect(host.asked.filter(ask => ask.query === 'row 1' && ask.group === 'g8').map(ask => ask.offset)).toEqual([100]);
    });

    it('keeps the counts of the filter in use when an answer under a filter left comes after them', async () => {
        const pending = new Map<string, () => void>();
        const asked: string[] = [];
        const pager = new OutlinePager({
            page: (group, offset, _limit, query) => {
                asked.push(`${group}@${query}`);
                return new Promise(resolve => pending.set(`${group}@${query}`, () => resolve({ page: { total: 1, offset, rows: [{ id: 'r0', label: 'row 0' }] } })));
            },
            locate: async () => ({})
        }, () => undefined, 100);
        const groups = Array.from({ length: 16 }, (_, at) => `g${at}`);
        let filter = 'row 1';
        // Laid out again after every answer, as the panel is.
        const layOut = () => groups.forEach(group => pager.total(group, filter));
        const answer = async (id: string) => {
            pending.get(id)!();
            pending.delete(id);
            await settle();
            layOut();
        };
        layOut();
        filter = 'row 2';
        layOut();
        // A slot frees: a count of the second filter is asked, and comes.
        await answer('g0@row 1');
        await answer('g0@row 2');
        // The rest of the first filter's, late.
        for (const group of groups.slice(1, 8)) {
            await answer(`${group}@row 1`);
        }
        while (pending.size > 0) {
            await answer([...pending.keys()][0]);
        }
        expect(asked.filter(id => id.endsWith('@row 2'))).toEqual(groups.map(group => `${group}@row 2`));
        expect(groups.every(group => pager.known(group, 'row 2') === 1)).toBe(true);
    });
});

describe('a page as the host passes it on', () => {
    it('keeps the request within bounds', () => {
        expect(normalizeOutlinePageRequest({ group: 'g', offset: -5.5, limit: 1e9, query: '  x ' }))
            .toEqual({ group: 'g', offset: 0, limit: OUTLINE_PAGE_MAX, query: 'x' });
    });

    it('keeps at most the limit of rows, each in its place, and a total no smaller than what it sent', () => {
        const page = normalizeOutlinePage({
            total: 1,
            rows: [{ id: 'a', label: ' A\nrow ' }, { label: 'no id' }, { id: 'b', badges: [{ text: '' }, { text: 'x', tone: 'info' }] }, { id: 'c' }]
        }, { group: 'g', offset: 10, limit: 2, query: '' });
        // A row without an id keeps its place, so the rows after it are where the producer put them.
        expect(page).toEqual({ total: 12, offset: 10, rows: [{ id: 'a', label: 'A row' }, { id: '', label: 'no id' }] });
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
        expect(numericDetail(group({ detail: '113,750' }, 113_750))).toBe(113_750);
        expect(numericDetail(group({ detail: '1.5' }))).toBeUndefined();
        // A number that is not the group's count (a width, a layer) is the producer's detail.
        const width = group({ detail: '32' }, 2);
        expect(numericDetail(width)).toBeUndefined();
        expect(shownDetail(width)).toBe('32');
        expect(rowMeta(width)).toEqual({ text: '2' });
        expect(rowMeta(group({ countNoun: { one: 'thing', other: 'things' } })).text).toBe('3 things');
    });

    it('drop a lazy group’s detail that only repeats its count, which it does not list', () => {
        expect(numericDetail({ ...lazy, detail: '200,000' })).toBe(ROWS);
        expect(shownDetail({ ...lazy, detail: '200,000' })).toBeUndefined();
        expect(rowMeta({ ...lazy, detail: '200,000' }).text).toBe('200,000 rows');
        // Any other number is the producer's, none of its rows listed or not.
        expect(shownDetail({ ...lazy, detail: '0' })).toBe('0');
        expect(shownDetail({ ...lazy, detail: '32' })).toBe('32');
    });

    it('say how much of a list cut short is listed, and say it right', () => {
        const cut = group({ truncated: true, count: 268 }, 200);
        expect(rowMeta(cut)).toEqual({ text: '200 of 268', title: 'The first 200 of 268 are listed' });
        // A number in the detail is not taken for a count the group does not list.
        expect(rowMeta(group({ truncated: true, detail: '268' }, 200)).text).toBe('200+');
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
