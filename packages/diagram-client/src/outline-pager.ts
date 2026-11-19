/**
 * The rows of the outline's lazy groups that the panel has from the host,
 * and the asking for more (shared `outline-pages.ts`).
 *
 * Rows come a page at a time, kept by group and filter. The panel says
 * which rows it shows ({@link OutlinePager.want}); the pager asks for the
 * pages they are on that it does not have, a couple at a time, newest wish
 * first, and forgets a wish the reader has scrolled past before it was
 * asked. So a fling through a hundred thousand rows asks for the pages it
 * stops on, not every page on the way.
 *
 * A page the host answers with fewer rows than were asked, short of the
 * group's total, is asked again for the rest from where it stopped; an
 * answer with no rows there shows the rest of the page as not loaded.
 *
 * A page is queued once, however often it is asked for while it is queued
 * or on its way: the panel asks every lazy group it has no count for at
 * each layout. One queued under a filter the reader has typed past is not
 * asked when its turn comes, unless a caller of `rowAt` waits for it; it
 * is asked afresh if the reader comes back to that filter.
 *
 * DOM-free: what reaches the host is the transport the panel gives it.
 */
import { OUTLINE_PAGE_SIZE, type OutlinePage, type OutlinePageRow } from '@dialogram/shared';

export interface OutlinePagerTransport {
    page(group: string, offset: number, limit: number, query: string): Promise<{ page?: OutlinePage; error?: string; ms?: number }>;
    locate(group: string, id: string, query: string): Promise<{ index?: number; error?: string }>;
}

/** What is known of a group under a filter. */
interface Listing {
    /** The filter it is under. */
    query: string;
    total?: number;
    pages: Map<number, OutlinePageRow[]>;
    /** Pages that have fewer rows than they should: the rest is still to be asked. */
    short: Set<number>;
    /** Pages that could not be had, and why. */
    failed: Map<number, string>;
    /** Pages by when they were last shown, the oldest first, for forgetting. */
    used: number[];
}

/** Pages kept of one listing; the ones shown longest ago go first. */
const KEPT_PAGES = 400;
/**
 * Listings kept (a group under a filter), those of the filter in use
 * counted: past it, the oldest of other filters go. Every group's listing
 * under the filter in use is kept, however many: the panel asks every lazy
 * group for its count at each layout, and a listing forgotten there is
 * asked again at the next.
 */
const KEPT_LISTINGS = 12;
/** Requests to the host at once for what the scroll shows. */
const IN_FLIGHT = 2;
/**
 * And for what is asked by name: a filter asks every lazy group how many
 * rows match at once, so that the counts come together, not two by two.
 */
const ASKED_IN_FLIGHT = 8;

export class OutlinePager {
    private readonly listings = new Map<string, Listing>();
    private readonly inFlight = new Set<string>();
    /**
     * Pages asked for by name (a count, a row to reveal): asked first, and
     * forgotten only when the filter they are under is no longer in use and
     * nothing waits for them.
     */
    private asked: Array<{ group: string; query: string; page: number }> = [];
    /** The pages in {@link asked}, each once: one queued or in flight is not queued again. */
    private readonly queued = new Set<string>();
    /** Pages the scroll shows: replaced by each scroll. */
    private wanted: Array<{ group: string; query: string; page: number }> = [];
    private readonly waiters = new Map<string, Array<() => void>>();
    /**
     * The filter in use: the one the panel last asked under, for a count
     * ({@link total}) or for the rows it shows ({@link want}).
     */
    private inUse = '';
    private generation = 0;

    constructor(
        private readonly transport: OutlinePagerTransport,
        private readonly onChange: () => void,
        readonly pageSize = OUTLINE_PAGE_SIZE
    ) {}

    /** Forget every row: the outline changed. */
    reset(): void {
        this.generation++;
        this.listings.clear();
        this.inFlight.clear();
        this.asked = [];
        this.queued.clear();
        this.wanted = [];
        for (const waiting of this.waiters.values()) {
            for (const wake of waiting) {
                wake();
            }
        }
        this.waiters.clear();
    }

    /**
     * How many rows the group has under the filter, or `undefined` before
     * the host has said; asks it then. The filter is the one in use from now.
     */
    total(group: string, query: string): number | undefined {
        this.inUse = query;
        const listing = this.listing(group, query);
        if (listing.total === undefined && !listing.failed.has(0)) {
            this.ask(group, query, [0]);
        }
        return listing.total;
    }

    /** How many rows the group has under the filter, if the host has said; without asking. */
    known(group: string, query: string): number | undefined {
        return this.listings.get(key(group, query))?.total;
    }

    /** Why the group's rows could not be had, if they could not. */
    failure(group: string, query: string, position?: number): string | undefined {
        const listing = this.listings.get(key(group, query));
        return listing?.failed.get(position === undefined ? 0 : Math.floor(position / this.pageSize));
    }

    /** The row at `position` of the group under the filter, when its page has come. */
    row(group: string, query: string, position: number): OutlinePageRow | undefined {
        const listing = this.listings.get(key(group, query));
        const page = Math.floor(position / this.pageSize);
        const rows = listing?.pages.get(page);
        if (rows) {
            touch(listing!.used, page);
        }
        return rows?.[position - page * this.pageSize];
    }

    /**
     * The rows the panel shows now, by group: ask for the pages they are on.
     * What was wanted before and not yet asked is forgotten. Their filter is
     * the one in use from now.
     */
    want(ranges: Array<{ group: string; query: string; from: number; to: number }>): void {
        const wanted: Array<{ group: string; query: string; page: number }> = [];
        for (const range of ranges) {
            this.inUse = range.query;
            for (let page = Math.floor(Math.max(0, range.from) / this.pageSize); page <= Math.floor(range.to / this.pageSize); page++) {
                wanted.push({ group: range.group, query: range.query, page });
            }
        }
        this.wanted = wanted;
        this.pump();
    }

    /** The row at `position` of a group, fetching its page if need be; `undefined` when there is none. */
    async rowAt(group: string, query: string, position: number): Promise<OutlinePageRow | undefined> {
        const page = Math.floor(position / this.pageSize);
        const generation = this.generation;
        // A short page is asked again for the rest until it holds the row, or
        // no more comes; each answer brings a row at least, or ends it.
        for (;;) {
            const listing = this.listing(group, query);
            const rows = listing.pages.get(page);
            const settled = listing.failed.has(page)
                || (rows !== undefined && (!listing.short.has(page) || rows.length > position - page * this.pageSize))
                || (listing.total !== undefined && position >= listing.total && page > 0);
            if (settled || generation !== this.generation) {
                break;
            }
            await new Promise<void>(resolve => {
                const id = pageId(group, query, page);
                this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
                this.ask(group, query, [page]);
            });
        }
        return this.row(group, query, position);
    }

    /** Where a row is in the group under the filter, as far as the host or the pages already here say. */
    async locate(group: string, id: string, query: string): Promise<number | undefined> {
        const listing = id === '' ? undefined : this.listings.get(key(group, query));
        for (const [page, rows] of listing?.pages ?? []) {
            const at = rows.findIndex(row => row.id === id);
            if (at >= 0) {
                return page * this.pageSize + at;
            }
        }
        try {
            const answer = await this.transport.locate(group, id, query);
            return Number.isInteger(answer.index) && (answer.index as number) >= 0 ? answer.index : undefined;
        } catch {
            return undefined;
        }
    }

    private listing(group: string, query: string): Listing {
        const id = key(group, query);
        let listing = this.listings.get(id);
        if (!listing) {
            listing = { query, pages: new Map(), short: new Set(), failed: new Map(), used: [] };
            this.listings.set(id, listing);
            // The oldest of other filters than the one in use go; none of
            // that one, however many lazy groups the outline has, and not
            // this one, which is wanted now.
            for (const [other, kept] of this.listings) {
                if (this.listings.size <= KEPT_LISTINGS) {
                    break;
                }
                if (kept.query !== this.inUse && other !== id) {
                    this.listings.delete(other);
                }
            }
        } else {
            // Most recently used last.
            this.listings.delete(id);
            this.listings.set(id, listing);
        }
        return listing;
    }

    private ask(group: string, query: string, pages: number[]): void {
        for (const page of pages) {
            const id = pageId(group, query, page);
            if (!this.queued.has(id) && !this.inFlight.has(id)) {
                this.queued.add(id);
                this.asked.push({ group, query, page });
            }
        }
        this.pump();
    }

    private pump(): void {
        while ((this.asked.length > 0 && this.inFlight.size < ASKED_IN_FLIGHT)
            || (this.wanted.length > 0 && this.inFlight.size < IN_FLIGHT)) {
            const byName = this.asked.length > 0 && this.inFlight.size < ASKED_IN_FLIGHT;
            const next = (byName ? this.asked : this.wanted).shift()!;
            const id = pageId(next.group, next.query, next.page);
            if (byName) {
                this.queued.delete(id);
            }
            if (this.inFlight.has(id)) {
                continue;
            }
            if (next.query !== this.inUse && !this.waiters.has(id)) {
                // Under a filter the reader has left, and no `rowAt` waits
                // for it: not asked, nor its listing made. Whoever asks for
                // it again (the filter is back) has it queued afresh.
                continue;
            }
            const listing = this.listing(next.group, next.query);
            if ((listing.pages.has(next.page) && !listing.short.has(next.page)) || listing.failed.has(next.page)
                || (listing.total !== undefined && next.page * this.pageSize >= listing.total && next.page > 0)) {
                // Nothing to ask: whoever waits for it has what there is.
                this.wake(id);
                continue;
            }
            this.inFlight.add(id);
            void this.fetch(next.group, next.query, next.page, id);
        }
    }

    private async fetch(group: string, query: string, page: number, id: string): Promise<void> {
        const generation = this.generation;
        const start = page * this.pageSize;
        // The rows a short page has already: the rest is asked from after them.
        const before = this.listings.get(key(group, query));
        const have = before?.short.has(page) ? before.pages.get(page) ?? [] : [];
        let answer: { page?: OutlinePage; error?: string; ms?: number };
        try {
            answer = await this.transport.page(group, start + have.length, this.pageSize - have.length, query);
        } catch (error) {
            answer = { error: error instanceof Error ? error.message : String(error) };
        }
        if (generation !== this.generation) {
            return;
        }
        this.inFlight.delete(id);
        const listing = this.listing(group, query);
        if (answer.page) {
            const total = answer.page.total;
            const rows = [...have, ...answer.page.rows];
            // As many as there are from here, a page's worth at most.
            const expected = Math.max(0, Math.min(this.pageSize, total - start));
            listing.total = total;
            listing.pages.set(page, rows);
            listing.short.delete(page);
            listing.failed.delete(page);
            if (rows.length < expected) {
                if (answer.page.rows.length > 0) {
                    // The rest is wanted as long as the page is: until the next scroll says otherwise.
                    listing.short.add(page);
                    this.wanted.unshift({ group, query, page });
                } else {
                    // Nothing more where the total says there is: the rest of
                    // the page is not loaded, and not asked for again.
                    listing.failed.set(page, `No rows came from row ${(start + rows.length + 1).toLocaleString('en-US')} on, of ${total.toLocaleString('en-US')}`);
                }
            }
            touch(listing.used, page);
            while (listing.used.length > KEPT_PAGES) {
                const forgotten = listing.used.shift()!;
                listing.pages.delete(forgotten);
                listing.short.delete(forgotten);
            }
        } else {
            listing.failed.set(page, answer.error ?? 'No answer');
            if (page === 0 && listing.total === undefined) {
                listing.total = 0;
            }
        }
        this.wake(id);
        this.onChange();
        this.pump();
    }

    private wake(id: string): void {
        const waiting = this.waiters.get(id);
        this.waiters.delete(id);
        for (const wake of waiting ?? []) {
            wake();
        }
    }
}

function key(group: string, query: string): string {
    return `${group}\u0000${query}`;
}

function pageId(group: string, query: string, page: number): string {
    return `${key(group, query)}\u0000${page}`;
}

function touch(used: number[], page: number): void {
    const at = used.indexOf(page);
    if (at >= 0) {
        used.splice(at, 1);
    }
    used.push(page);
}
