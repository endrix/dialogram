/**
 * Navigating a workflow hierarchy by instance path -- shared by the client
 * (the outline, "Go to Error") and the server (the menu that offers it).
 */
import type { HierarchyOutlineEntry } from './diagram-seams';

export interface HierarchyCrumb {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
}

/** An entry's children as paths see them: a group row's children in its place. */
export function hierarchyPathChildren(entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] {
    return entry.children.flatMap(child => (child.role === 'group' ? hierarchyPathChildren(child) : [child]));
}

/** The entry at `path` (instance names from the root), if the outline has it. */
export function hierarchyEntryAt(root: HierarchyOutlineEntry, path: string[]): HierarchyOutlineEntry | undefined {
    let current: HierarchyOutlineEntry | undefined = root;
    for (const name of path) {
        current = current ? hierarchyPathChildren(current).find(child => child.path[child.path.length - 1] === name) : undefined;
    }
    return current;
}

/**
 * The rows from the root down to the entry at `path`, group rows included:
 * what has to be open for that entry's row to show. Empty when the outline
 * has no such entry.
 */
export function hierarchyRowsTo(root: HierarchyOutlineEntry, path: string[]): HierarchyOutlineEntry[] {
    const target = hierarchyEntryAt(root, path);
    if (!target) {
        return [];
    }
    const walk = (entry: HierarchyOutlineEntry): HierarchyOutlineEntry[] | undefined => {
        if (entry === target) {
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

/**
 * The navigation trail to the instance at `path`: the root, then one crumb per
 * instance on the way -- what a drill-down and the breadcrumb produce, so a view
 * opened this way is the view either would open.
 */
export function hierarchyTrailTo(
    root: HierarchyOutlineEntry,
    rootSourceUri: string,
    path: string[]
): HierarchyCrumb[] | undefined {
    const trail: HierarchyCrumb[] = [{ sourceUri: root.sourceUri ?? rootSourceUri, workflowName: root.workflowName }];
    for (let i = 1; i <= path.length; i++) {
        const entry = hierarchyEntryAt(root, path.slice(0, i));
        if (!entry?.sourceUri) {
            return undefined;
        }
        trail.push({ sourceUri: entry.sourceUri, workflowName: entry.workflowName, workflowInstanceName: path[i - 1] });
    }
    return trail;
}

/**
 * Where a failure at `errorPath` shows in a view at `viewPath` (both instance
 * paths from the root): the node of this view it is in, and what lies inside
 * that node on the way to it (empty when that node is the one that failed).
 * Nothing when the failure is not under this view.
 */
export function errorInView(
    errorPath: string[],
    viewPath: string[]
): { nodeName: string; within: string[] } | undefined {
    if (errorPath.length <= viewPath.length || !viewPath.every((part, i) => part === errorPath[i])) {
        return undefined;
    }
    return { nodeName: errorPath[viewPath.length], within: errorPath.slice(viewPath.length + 1) };
}
