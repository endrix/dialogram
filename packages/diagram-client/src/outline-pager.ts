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
 * DOM-free: what reaches the host is the transport the panel gives it.
 */
import { OUTLINE_PAGE_SIZE, type OutlinePage, type OutlinePageRow } from '@dialogram/shared';

export interface OutlinePagerTransport {
    page(group: string, offset: number, limit: number, query: string): Promise<{ page?: OutlinePage; error?: string; ms?: number }>;
    locate(group: string, id: string, query: string): Promise<{ index?: number; error?: string }>;
}

/** What is known of a group under a filter. */
interface Listing {
    total?: number;
    pages: Map<number, OutlinePageRow[]>;
    /** Pages that could not be had, and why. */
    failed: Map<number, string>;
    /** Pages by when they were last shown, the oldest first, for forgetting. */
    used: number[];
}

/** Pages kept of one listing; the ones shown longest ago go first. */
const KEPT_PAGES = 400;
/** Listings kept (a group under a filter); the oldest go first. */
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
    /** Pages asked for by name (a count, a row to reveal): asked first, and never forgotten. */
    private asked: Array<{ group: string; query: string; page: number }> = [];
    /** Pages the scroll shows: replaced by each scroll. */
    private wanted: Array<{ group: string; query: string; page: number }> = [];
    private readonly waiters = new Map<string, Array<() => void>>();
    private generation = 0;
    /** How long the host took for each page, ms, the latest last; for a measure of scrolling. */
    readonly timings: number[] = [];

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
        this.wanted = [];
        for (const waiting of this.waiters.values()) {
            for (const wake of waiting) {
                wake();
            }
        }
        this.waiters.clear();
    }

    /** How many rows the group has under the filter, or `undefined` before the host has said; asks it then. */
    total(group: string, query: string): number | undefined {
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
     * What was wanted before and not yet asked is forgotten.
     */
    want(ranges: Array<{ group: string; query: string; from: number; to: number }>): void {
        const wanted: Array<{ group: string; query: string; page: number }> = [];
        for (const range of ranges) {
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
        const listing = this.listing(group, query);
        if (!listing.pages.has(page) && !listing.failed.has(page)) {
            await new Promise<void>(resolve => {
                const id = `${key(group, query)}\u0000${page}`;
                this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
                this.ask(group, query, [page]);
            });
        }
        return this.row(group, query, position);
    }

    /** Where a row is in the group under the filter, as far as the host or the pages already here say. */
    async locate(group: string, id: string, query: string): Promise<number | undefined> {
        const listing = this.listings.get(key(group, query));
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
            listing = { pages: new Map(), failed: new Map(), used: [] };
            this.listings.set(id, listing);
            while (this.listings.size > KEPT_LISTINGS) {
                this.listings.delete(this.listings.keys().next().value as string);
            }
        } else {
            // Most recently used last.
            this.listings.delete(id);
            this.listings.set(id, listing);
        }
        return listing;
    }

    private ask(group: string, query: string, pages: number[]): void {
        this.asked.push(...pages.map(page => ({ group, query, page })));
        this.pump();
    }

    private pump(): void {
        while ((this.asked.length > 0 && this.inFlight.size < ASKED_IN_FLIGHT)
            || (this.wanted.length > 0 && this.inFlight.size < IN_FLIGHT)) {
            const next = (this.asked.length > 0 && this.inFlight.size < ASKED_IN_FLIGHT ? this.asked : this.wanted).shift()!;
            const listing = this.listing(next.group, next.query);
            const id = `${key(next.group, next.query)}\u0000${next.page}`;
            if (this.inFlight.has(id)) {
                continue;
            }
            if (listing.pages.has(next.page) || listing.failed.has(next.page)
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
        let answer: { page?: OutlinePage; error?: string; ms?: number };
        try {
            answer = await this.transport.page(group, page * this.pageSize, this.pageSize, query);
        } catch (error) {
            answer = { error: error instanceof Error ? error.message : String(error) };
        }
        if (generation !== this.generation) {
            return;
        }
        this.inFlight.delete(id);
        const listing = this.listing(group, query);
        if (answer.page) {
            listing.total = answer.page.total;
            listing.pages.set(page, answer.page.rows);
            listing.failed.delete(page);
            touch(listing.used, page);
            while (listing.used.length > KEPT_PAGES) {
                listing.pages.delete(listing.used.shift()!);
            }
            if (typeof answer.ms === 'number') {
                this.timings.push(answer.ms);
                if (this.timings.length > 200) {
                    this.timings.shift();
                }
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

function touch(used: number[], page: number): void {
    const at = used.indexOf(page);
    if (at >= 0) {
        used.splice(at, 1);
    }
    used.push(page);
}
