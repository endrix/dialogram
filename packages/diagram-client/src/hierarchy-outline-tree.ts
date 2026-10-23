/**
 * Pure helpers for the hierarchy outline, kept GLSP-free so they are unit
 * testable headlessly (the panel imports GLSP values and cannot load without a
 * DOM) -- the split mlir-viewer's outline uses, for the same reason.
 */
import { hierarchyEntryAt, hierarchyRowsTo, hierarchyTrailTo, type HierarchyOutlineEntry } from '@dialogram/shared';

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
 */
export function outlineMatches(entry: HierarchyOutlineEntry, query: string): boolean {
    if (!query) {
        return true;
    }
    const words = [rowLabel(entry), entry.workflowName, entry.detail ?? ''];
    if (words.some(word => word.toLowerCase().includes(query))) {
        return true;
    }
    return entry.children.some(child => outlineMatches(child, query));
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
 * and the group rows beneath it, which only arrange what the view holds.
 */
export function rowIdsTo(root: HierarchyOutlineEntry, path: string[]): string[] {
    const rows = hierarchyRowsTo(root, path);
    const groupsBelow = (entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] =>
        entry.children.filter(child => child.role === 'group').flatMap(group => [group, ...groupsBelow(group)]);
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
