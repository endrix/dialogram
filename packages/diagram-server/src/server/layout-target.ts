/**
 * Where a view's layout lives, and under which key.
 *
 * A workflow shown on its own keeps its layout in its file's layout store,
 * keyed by its name. A nested workflow shown in place, as a view of an editor's
 * root, is an *instance*: its layout belongs to the root, in the root file's
 * store, keyed by the instance path from the root (`top/b2/block`). Two uses of
 * one workflow can then be arranged differently, and the root owns the layout
 * of everything it shows.
 *
 * An instance with no layout of its own yet starts from the workflow's
 * standalone layout, so every layout made before keeps applying.
 */

import { URI } from 'vscode-uri';

export interface LayoutTarget {
    /** The source file whose layout store holds it. */
    filePath: string;
    /** The key inside that store. */
    networkId: string;
}

export interface InstanceLayout {
    target: LayoutTarget;
    /** Read when the target holds nothing yet: the workflow's standalone layout. */
    fallback: LayoutTarget;
}

export interface TrailCrumb {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
}

/**
 * The instance layout for a view at `trail`, or nothing when the view is a
 * root (a trail of one, or none) or the trail does not end at it.
 */
export function instanceLayoutFor(
    trail: TrailCrumb[],
    shown: { filePath: string; workflowName: string },
    toFilePath: (sourceUri: string) => string
): InstanceLayout | undefined {
    if (trail.length < 2) {
        return undefined;
    }
    const root = trail[0];
    const last = trail[trail.length - 1];
    if (last.workflowName !== shown.workflowName || toFilePath(last.sourceUri) !== shown.filePath) {
        return undefined;
    }
    const instancePath = trail.slice(1).map(crumb => crumb.workflowInstanceName?.trim() || crumb.workflowName);
    return {
        target: {
            filePath: toFilePath(root.sourceUri),
            // The shape a hierarchical runtime's layouts already use:
            // root, instance path, then the workflow shown.
            networkId: [root.workflowName, ...instancePath, shown.workflowName].join('/')
        },
        fallback: { filePath: shown.filePath, networkId: shown.workflowName }
    };
}

/**
 * The layout target of the loaded view: where its layout is read from and
 * saved to. Recorded on the diagram model at load (`layoutTarget`) -- the
 * instance target for a nested view in place, or a hierarchical runtime's --
 * so every handler that saves a layout saves it where it was read. Without one,
 * the shown file and workflow, as handlers computed it before.
 */
export function layoutTargetOf(
    diagramModel: { documentUri: string; workflowName?: unknown; layoutTarget?: LayoutTarget }
): LayoutTarget {
    if (diagramModel.layoutTarget) {
        return diagramModel.layoutTarget;
    }
    const name = typeof diagramModel.workflowName === 'string' && diagramModel.workflowName.trim() !== ''
        ? diagramModel.workflowName.trim()
        : 'unknown';
    return { filePath: URI.parse(diagramModel.documentUri).fsPath, networkId: name };
}
