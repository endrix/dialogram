/**
 * Pure helpers for the hierarchy outline, kept GLSP-free so they are unit
 * testable headlessly (the panel imports GLSP values and cannot load without a
 * DOM) -- the split mlir-viewer's outline uses, for the same reason.
 */
import type { HierarchyOutlineEntry } from '@dialogram/shared';

export interface OutlineCrumb {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
}

/** A row's stable id: its path of instance names (`''` for the root). */
export function rowId(entry: { path: string[] }): string {
    return entry.path.join('/');
}

/** What a row is called: its instance name, or the workflow for the root. */
export function rowLabel(entry: HierarchyOutlineEntry): string {
    return entry.path.length > 0 ? entry.path[entry.path.length - 1] : entry.workflowName;
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
    if (rowLabel(entry).toLowerCase().includes(query) || entry.workflowName.toLowerCase().includes(query)) {
        return true;
    }
    return entry.children.some(child => outlineMatches(child, query));
}

/** The entry at `path`, if the outline has it. */
export function entryAt(root: HierarchyOutlineEntry, path: string[]): HierarchyOutlineEntry | undefined {
    let current: HierarchyOutlineEntry | undefined = root;
    for (const name of path) {
        current = current?.children.find(child => child.path[child.path.length - 1] === name);
    }
    return current;
}

/**
 * The navigation trail to the instance at `path`: the root, then one crumb per
 * instance on the way. What a breadcrumb and a drill-down produce, so a view
 * opened from the outline is the same view either way would open.
 */
export function trailTo(root: HierarchyOutlineEntry, rootSourceUri: string, path: string[]): OutlineCrumb[] | undefined {
    const trail: OutlineCrumb[] = [{ sourceUri: root.sourceUri ?? rootSourceUri, workflowName: root.workflowName }];
    for (let i = 1; i <= path.length; i++) {
        const entry = entryAt(root, path.slice(0, i));
        if (!entry?.sourceUri) {
            return undefined;
        }
        trail.push({ sourceUri: entry.sourceUri, workflowName: entry.workflowName, workflowInstanceName: path[i - 1] });
    }
    return trail;
}

/** The path the shown view is at, from its trail. */
export function pathOfTrail(trail: Array<{ workflowName: string; workflowInstanceName?: string }>): string[] {
    return trail.slice(1).map(crumb => crumb.workflowInstanceName ?? crumb.workflowName);
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
