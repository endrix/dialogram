/**
 * The outline as a flat list of rows of one height, and the arithmetic of
 * showing only the ones in view.
 *
 * The panel draws only the rows the scroll shows (and a few either side), so
 * a list of a hundred thousand rows costs what a list of forty does. For that
 * it needs to know, without drawing anything, how many rows there are, which
 * row is at which place, and where a given row is: the outline's rows in
 * order, each open row's children after it, and a lazy group's rows as one
 * run of `count` places whose text comes from the host a page at a time.
 *
 * Pure and DOM-free, like `hierarchy-outline-tree.ts`.
 */
import type { HierarchyOutlineEntry } from '@dialogram/shared';
import { outlineMatches, rowId } from './hierarchy-outline-tree';

/** The height of a row, px: the panel's rows are this tall, always. */
export const OUTLINE_ROW_HEIGHT = 22;

/**
 * The tallest the scrolled content is made, px. Browsers stop scrolling a
 * little beyond 30 million pixels; past this height a scroll position stands
 * for a proportionally further place in the list ({@link scrollGeometry}).
 */
export const OUTLINE_MAX_SCROLL_HEIGHT = 8_000_000;

/** A row of the outline, or a run of a lazy group's rows. */
export interface OutlineSegment {
    /** The place of its first row. */
    start: number;
    /** `1` for a row of the outline; the group's rows for a run. */
    length: number;
    kind: 'entry' | 'paged';
    /** The row itself, or the lazy group whose rows the run is. */
    entry: HierarchyOutlineEntry;
    depth: number;
    /** The path of the view the row is in: what a node row is found in. */
    viewPath: string[];
}

export interface OutlineLayout {
    segments: OutlineSegment[];
    total: number;
}

/** What is at a place: a row of the outline, or the `position`-th row of a lazy group. */
export type OutlineSlot =
    | { kind: 'entry'; entry: HierarchyOutlineEntry; depth: number; viewPath: string[] }
    | { kind: 'paged'; group: HierarchyOutlineEntry; position: number; depth: number; viewPath: string[] };

export interface OutlineShape {
    /** The ids of the open rows (`rowId`). */
    expanded: ReadonlySet<string>;
    /** The filter, lower-cased and trimmed; `''` for none. */
    query: string;
    /** How many rows a lazy group has under the query, or `undefined` before the host has said. */
    lazyTotal(group: HierarchyOutlineEntry): number | undefined;
}

/**
 * The outline's rows in order: each row the filter keeps, and below an open
 * one its children; a filter opens every row with a match beneath it. A
 * lazy group's rows are one run, as many as the host says it has (none
 * until it has said).
 */
export function layOutOutline(root: HierarchyOutlineEntry, shape: OutlineShape): OutlineLayout {
    const segments: OutlineSegment[] = [];
    let total = 0;
    const visit = (entry: HierarchyOutlineEntry, depth: number, viewPath: string[]): void => {
        if (!outlineMatches(entry, shape.query, shape.lazyTotal)) {
            return;
        }
        segments.push({ start: total, length: 1, kind: 'entry', entry, depth, viewPath });
        total += 1;
        if (shape.query === '' && !shape.expanded.has(rowId(entry))) {
            return;
        }
        // A group is transparent to paths; a node or an item row is in the view above it.
        const inside = entry.role === 'group' || entry.role === 'node' || entry.role === 'item' ? viewPath : entry.path;
        if (entry.lazy) {
            const count = shape.lazyTotal(entry) ?? 0;
            if (count > 0) {
                segments.push({ start: total, length: count, kind: 'paged', entry, depth: depth + 1, viewPath: inside });
                total += count;
            }
            return;
        }
        for (const child of entry.children) {
            visit(child, depth + 1, inside);
        }
    };
    visit(root, 0, root.path);
    return { segments, total };
}

/** The segment holding a place, by halving. */
function segmentAt(layout: OutlineLayout, index: number): OutlineSegment | undefined {
    if (index < 0 || index >= layout.total) {
        return undefined;
    }
    let low = 0;
    let high = layout.segments.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (layout.segments[middle].start <= index) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return layout.segments[low];
}

/** What is at place `index`, or nothing past the end. */
export function slotAt(layout: OutlineLayout, index: number): OutlineSlot | undefined {
    const segment = segmentAt(layout, index);
    if (!segment) {
        return undefined;
    }
    return segment.kind === 'entry'
        ? { kind: 'entry', entry: segment.entry, depth: segment.depth, viewPath: segment.viewPath }
        : { kind: 'paged', group: segment.entry, position: index - segment.start, depth: segment.depth, viewPath: segment.viewPath };
}

/** The place of a row of the outline, or -1 when it is not shown (filtered out, or under a closed row). */
export function indexOfEntry(layout: OutlineLayout, entry: HierarchyOutlineEntry): number {
    const segment = layout.segments.find(candidate => candidate.kind === 'entry' && candidate.entry === entry);
    return segment ? segment.start : -1;
}

/** The place of a lazy group's `position`-th row, or -1 when the group is closed or has no such row. */
export function indexOfPaged(layout: OutlineLayout, group: HierarchyOutlineEntry, position: number): number {
    const segment = layout.segments.find(candidate => candidate.kind === 'paged' && candidate.entry === group);
    return segment && position >= 0 && position < segment.length ? segment.start + position : -1;
}

/**
 * How tall the scrolled content is made, and how far into the list a pixel
 * of scrolling goes: one row height per row while that fits under
 * {@link OUTLINE_MAX_SCROLL_HEIGHT}, and beyond it a scroll position stands
 * for a place proportionally further, so that the last row is still reached.
 */
export function scrollGeometry(total: number, rowHeight: number, viewHeight: number): { height: number; scale: number } {
    const content = Math.max(0, total) * rowHeight;
    if (content <= OUTLINE_MAX_SCROLL_HEIGHT) {
        return { height: content, scale: 1 };
    }
    const view = Math.max(0, Math.min(viewHeight, OUTLINE_MAX_SCROLL_HEIGHT - 1));
    return { height: OUTLINE_MAX_SCROLL_HEIGHT, scale: (content - view) / (OUTLINE_MAX_SCROLL_HEIGHT - view) };
}

/**
 * The rows a scroll position shows, with `overscan` either side so a fast
 * scroll does not show a gap, and where in the content they begin: `offset`
 * is the list's pixel at the top of the view.
 */
export function visibleRows(
    scrollTop: number,
    viewHeight: number,
    rowHeight: number,
    total: number,
    overscan = 8
): { first: number; last: number; offset: number } {
    if (total <= 0) {
        return { first: 0, last: -1, offset: 0 };
    }
    const { scale } = scrollGeometry(total, rowHeight, viewHeight);
    const offset = Math.max(0, scrollTop) * scale;
    const first = Math.max(0, Math.floor(offset / rowHeight) - overscan);
    const last = Math.min(total - 1, Math.ceil((offset + Math.max(0, viewHeight)) / rowHeight) + overscan);
    return { first, last, offset };
}

/** Where row `index` is drawn in the scrolled content, px, with the view scrolled to `scrollTop`. */
export function rowTop(index: number, scrollTop: number, offset: number, rowHeight: number): number {
    return Math.max(0, scrollTop) + index * rowHeight - offset;
}

/**
 * The scroll position that shows row `index`: unchanged when it is in view
 * already, otherwise with the row in the middle of the view.
 */
export function scrollTopFor(index: number, scrollTop: number, viewHeight: number, rowHeight: number, total: number): number {
    const { height, scale } = scrollGeometry(total, rowHeight, viewHeight);
    const offset = Math.max(0, scrollTop) * scale;
    const top = index * rowHeight;
    if (top >= offset && top + rowHeight <= offset + viewHeight) {
        return scrollTop;
    }
    const wanted = (top - Math.max(0, viewHeight - rowHeight) / 2) / scale;
    return Math.max(0, Math.min(Math.max(0, height - viewHeight), wanted));
}

/** The lazy group of this id in the outline, and the rows down to it, from the root. */
export function lazyGroupPath(root: HierarchyOutlineEntry, id: string): HierarchyOutlineEntry[] {
    const walk = (entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] | undefined => {
        if (entry.lazy?.id === id) {
            return [entry];
        }
        for (const child of entry.children) {
            const below = walk(child);
            if (below) {
                return [entry, ...below];
            }
        }
        return undefined;
    };
    return walk(root) ?? [];
}

/** The row of the outline a product names (an `item` row's id, or a row's path joined by `/`), and the rows down to it. */
export function entryPath(root: HierarchyOutlineEntry, id: string): HierarchyOutlineEntry[] {
    const walk = (entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] | undefined => {
        if (entry.id === id || (entry.id === undefined && rowId(entry) === id)) {
            return [entry];
        }
        for (const child of entry.children) {
            const below = walk(child);
            if (below) {
                return [entry, ...below];
            }
        }
        return undefined;
    };
    return walk(root) ?? [];
}
