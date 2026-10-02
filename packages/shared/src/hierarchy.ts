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

/** The entry at `path` (instance names from the root), if the outline has it. */
export function hierarchyEntryAt(root: HierarchyOutlineEntry, path: string[]): HierarchyOutlineEntry | undefined {
    let current: HierarchyOutlineEntry | undefined = root;
    for (const name of path) {
        current = current?.children.find(child => child.path[child.path.length - 1] === name);
    }
    return current;
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
