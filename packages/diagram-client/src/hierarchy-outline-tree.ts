/**
 * Pure helpers for the hierarchy outline, kept GLSP-free so they are unit
 * testable headlessly (the panel imports GLSP values and cannot load without a
 * DOM) -- the split mlir-viewer's outline uses, for the same reason.
 */
import { countInWords, hierarchyEntryAt, hierarchyRowsTo, hierarchyTrailTo, type HierarchyOutlineEntry } from '@dialogram/shared';

export interface OutlineCrumb {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
}

/** A row's stable id: its path of instance names (`''` for the root). */
export function rowId(entry: { path: string[] }): string {
    return entry.path.join('/');
}

/** What a row is called: the producer's label, else its instance name, or the workflow for the root. */
export function rowLabel(entry: HierarchyOutlineEntry): string {
    if (entry.label) {
        return entry.label;
    }
    return entry.path.length > 0 ? entry.path[entry.path.length - 1] : entry.workflowName;
}

/**
 * What follows the label, dimmed: the producer's detail, else, for an
 * instance it says nothing more about, the workflow it instantiates.
 */
export function rowDetail(entry: HierarchyOutlineEntry): string | undefined {
    if (entry.detail) {
        return entry.detail;
    }
    return entry.path.length > 0 && !entry.label && entry.role !== 'group' ? entry.workflowName : undefined;
}

/**
 * A row survives a filter when it matches, or when something beneath it does:
 * a filter that hid the ancestors would leave the matches unreachable, since
 * the tree is the way to them. `query` is lower-cased and trimmed already.
 *
 * What is beneath a lazy group is the host's to say: `lazyTotal` is how many
 * of its rows the host found for the query, `undefined` while it has not
 * said, in which case the group stays (it may yet have some).
 */
export function outlineMatches(
    entry: HierarchyOutlineEntry,
    query: string,
    lazyTotal?: (group: HierarchyOutlineEntry) => number | undefined
): boolean {
    if (!query) {
        return true;
    }
    const words = [rowLabel(entry), entry.workflowName, entry.detail ?? ''];
    if (words.some(word => word.toLowerCase().includes(query))) {
        return true;
    }
    if (entry.lazy) {
        const found = lazyTotal?.(entry);
        return found === undefined || found > 0;
    }
    return entry.children.some(child => outlineMatches(child, query, lazyTotal));
}

/** What the right of a row says, and its tooltip when that needs one. */
export interface RowMeta {
    text: string;
    title?: string;
    error?: boolean;
}

const NODES = { one: 'node', other: 'nodes' };

/**
 * A group's detail that only repeats how many rows it lists ("182" on a
 * group of 182, "113,750"): a producer with no other place for a group's
 * count put it there. It is said once, on the right. Any other number (a
 * width, a layer) is the producer's detail, and is shown as one. A lazy
 * group lists none of its rows here: its detail is the count when it
 * repeats the group's `count`.
 */
export function numericDetail(entry: HierarchyOutlineEntry): number | undefined {
    if (entry.role !== 'group' || !entry.detail) {
        return undefined;
    }
    const said = entry.detail.trim();
    // Digits, in threes after the first when grouped ("113,750", "113 750").
    if (!/^\d{1,15}$/.test(said) && !/^\d{1,3}([,.\s\u202f\u00a0']\d{3}){1,4}$/.test(said)) {
        return undefined;
    }
    const count = Number(said.replace(/\D/g, ''));
    return count === (entry.lazy ? entry.count : entry.children.length) ? count : undefined;
}

/**
 * What a group holds: a lazy group's rows (under the filter, once the host
 * has said), else its `count`, else what it lists; never fewer than it
 * lists.
 */
export function groupCount(entry: HierarchyOutlineEntry, lazyTotal?: number): number {
    if (entry.lazy) {
        return lazyTotal ?? entry.count ?? 0;
    }
    return Math.max(entry.children.length, typeof entry.count === 'number' ? entry.count : 0);
}

/**
 * What the right of a row says. A view: its nodes and the views nested in
 * it ("1 node", "12 nodes · 3 nested"), in the producer's words when it has
 * some (`countNoun`). A group: how many rows it holds, once; a list cut short
 * says how much of it is listed ("200 of 268", with a tooltip that says so).
 * A view cut short (`truncated`, which for a view is a hierarchy that nests
 * itself or goes too deep) says so in its tooltip, as before.
 */
export function rowMeta(entry: HierarchyOutlineEntry, lazyTotal?: number): RowMeta {
    if (entry.error) {
        return { text: 'error', title: entry.error, error: true };
    }
    if (entry.role === 'group') {
        const words = (n: number): string => countInWords(n, entry.countNoun);
        if (entry.lazy && lazyTotal === undefined && typeof entry.count !== 'number') {
            return { text: '…', title: 'Not counted yet' };
        }
        const count = groupCount(entry, lazyTotal);
        const listed = entry.children.length;
        if (!entry.lazy && count > listed) {
            const first = listed.toLocaleString('en-US');
            return { text: `${first} of ${words(count)}`, title: `The first ${first} of ${words(count)} are listed` };
        }
        if (!entry.lazy && entry.truncated) {
            return { text: `${words(listed)}+`, title: `${words(listed)} are listed; there are more` };
        }
        return { text: words(count) };
    }
    if (entry.truncated) {
        return { text: '…', title: 'Not expanded: it nests itself, or is too deep' };
    }
    if (entry.role === 'node' || entry.role === 'item') {
        return { text: '' };
    }
    const nested = entry.children.filter(child => child.role !== 'node' && child.role !== 'group' && child.role !== 'item').length;
    const parts = [
        typeof entry.nodeCount === 'number' ? countInWords(entry.nodeCount, entry.countNoun ?? NODES) : undefined,
        nested > 0 ? `${nested.toLocaleString('en-US')} nested` : undefined
    ].filter(Boolean);
    return { text: parts.join(' · ') };
}

/**
 * The detail a row shows: a group's detail that is only its count is not
 * shown, since the count is said on the right ({@link numericDetail}).
 */
export function shownDetail(entry: HierarchyOutlineEntry): string | undefined {
    return numericDetail(entry) === undefined ? rowDetail(entry) : undefined;
}

/** The id the product knows an `item` row by: its own, else its path. */
export function itemId(entry: HierarchyOutlineEntry): string {
    return entry.id ?? entry.path.join('/');
}

/** The entry at `path`, if the outline has it. */
export const entryAt = hierarchyEntryAt;

/**
 * The navigation trail to the instance at `path` -- see `hierarchyTrailTo`,
 * shared with the server's "Go to Error".
 */
export const trailTo: (root: HierarchyOutlineEntry, rootSourceUri: string, path: string[]) => OutlineCrumb[] | undefined =
    hierarchyTrailTo;

/** The path the shown view is at, from its trail. */
export function pathOfTrail(trail: Array<{ workflowName: string; workflowInstanceName?: string }>): string[] {
    return trail.slice(1).map(crumb => crumb.workflowInstanceName ?? crumb.workflowName);
}

/**
 * The ids of the rows to open so the current view's row shows with what is in
 * it: the rows down to the entry at `path` (group rows and its own included),
 * and the group rows beneath it, which only arrange what the view holds. A
 * view the outline does not list (below a row it cut short) opens the rows
 * down to the deepest one on its way that it does. A lazy group stays closed
 * until the reader opens it: opened, its rows would be asked of the host
 * with every view, and would push the groups after it a list away.
 */
export function rowIdsTo(root: HierarchyOutlineEntry, path: string[]): string[] {
    const rows = hierarchyRowsTo(root, path);
    if (rows.length === 0) {
        for (let depth = path.length - 1; depth >= 0; depth--) {
            const known = hierarchyRowsTo(root, path.slice(0, depth));
            if (known.length > 0) {
                return known.map(rowId);
            }
        }
        return [];
    }
    const groupsBelow = (entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] =>
        entry.children.filter(child => child.role === 'group' && !child.lazy).flatMap(group => [group, ...groupsBelow(group)]);
    const target = rows[rows.length - 1];
    return [...rows, ...(target ? groupsBelow(target) : [])].map(rowId);
}

/** The ids of every ancestor of `path`, so the current row can be revealed. */
export function ancestorIds(path: string[]): string[] {
    return path.map((_, i) => path.slice(0, i).join('/'));
}

/** The file name of an instance defined elsewhere than the root, or nothing. */
export function foreignFileName(entry: HierarchyOutlineEntry, rootSourceUri: string | undefined): string | undefined {
    if (!entry.sourceUri || !rootSourceUri || entry.sourceUri === rootSourceUri) {
        return undefined;
    }
    const name = entry.sourceUri.split('/').pop();
    return name ? decodeURIComponent(name) : undefined;
}
