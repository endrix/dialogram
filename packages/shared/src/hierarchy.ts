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

/**
 * The crumb a view's hierarchy is rooted at: the deepest one answered by a
 * past run (`recordedRun`), else the trail's first.
 *
 * A nested unit answered by a past run runs nothing with its parent, so the
 * export of its parent's hierarchy has nothing under it. Its insides are what
 * that run elaborated: its workflow, as a root of its own. A view at or under
 * it is read from the hierarchy rooted at it, by the instance names below it
 * (`trailInstancePath` of the trail from that crumb).
 */
export function hierarchyRootAt(trail: readonly { recordedRun?: string }[]): number {
    for (let at = trail.length - 1; at >= 1; at--) {
        if (trail[at].recordedRun?.trim()) {
            return at;
        }
    }
    return 0;
}

/**
 * The instance a navigation trail leads to, by instance names from the trail's
 * root: one name per crumb after the root, its instance's, or its workflow's
 * when the crumb names no instance. The view a trail opens and the run
 * records that view reads are both looked up by this path.
 */
export function trailInstancePath(trail: readonly Pick<HierarchyCrumb, 'workflowName' | 'workflowInstanceName'>[]): string[] {
    return trail.slice(1).map(crumb => crumb.workflowInstanceName ?? crumb.workflowName);
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
    const nodeName = nodeInView(errorPath, viewPath);
    return nodeName === undefined ? undefined : { nodeName, within: errorPath.slice(viewPath.length + 1) };
}

/**
 * The node of a view at `viewPath` that the instance at `path` is in (both
 * instance paths from the root): the instance itself, or the nested workflow
 * holding it. Nothing when the instance is not under this view: a node of the
 * view named like it is another instance.
 */
export function nodeInView(path: readonly string[], viewPath: readonly string[]): string | undefined {
    if (path.length <= viewPath.length || !viewPath.every((part, i) => part === path[i])) {
        return undefined;
    }
    return path[viewPath.length];
}
