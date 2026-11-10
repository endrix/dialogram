/**
 * How much text the diagram draws at the zoom it is looked at.
 *
 * Zoomed out, a view of a few hundred nodes is a page of text too small to
 * read, and drawing it is most of what the browser does on every pan and
 * zoom step. So the text comes in by level, as in the mlir-viewer:
 *
 * - `far`, below {@link NAME_ZOOM}: no text on the nodes, only their boxes,
 *   ports and wires (a group's frame keeps its title, the structure of the
 *   view);
 * - `mid`, up to {@link DETAIL_ZOOM}: each node's name (its header, a
 *   boundary's name, a symbol's caption and operator) and the labels a run
 *   puts on the edges;
 * - `near`, from {@link DETAIL_ZOOM}: everything, the ports' names, the type
 *   under a node, its badges, the bits a wire carries.
 *
 * The root says which (`detail-far`, `detail-mid`, `detail-near` on the
 * diagram's svg, from `DetailGraphView`) and the stylesheet hides the rest
 * (`display: none`, so the browser neither lays it out nor paints it). Only
 * the diagram on screen:
 * the hidden render the client measures sizes in draws everything, and so
 * does an export (svg-export.ts lifts the class while it copies).
 */
import type { VNode } from 'snabbdom';

/** The zoom from which the nodes' names are drawn. */
export const NAME_ZOOM = 0.5;

/** The zoom from which everything is drawn: the ports' names and the rest. */
export const DETAIL_ZOOM = 0.8;

export type DetailLevel = 'far' | 'mid' | 'near';

/** The classes the diagram's svg carries, one per level. */
export const DETAIL_CLASSES: Readonly<Record<DetailLevel, string>> = {
    far: 'detail-far',
    mid: 'detail-mid',
    near: 'detail-near'
};

/** The level of detail at `zoom`; everything when the zoom is not known. */
export function detailLevel(zoom: unknown): DetailLevel {
    if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
        return 'near';
    }
    return zoom < NAME_ZOOM ? 'far' : zoom < DETAIL_ZOOM ? 'mid' : 'near';
}

/**
 * `vnode` (the diagram's svg) with the class of the level at `zoom`. Only on
 * screen: a hidden render measures what it draws, and must draw everything.
 */
export function markDetail(vnode: VNode | undefined, zoom: unknown, targetKind: string | undefined): VNode | undefined {
    if (!vnode || targetKind !== 'main') {
        return vnode;
    }
    const level = detailLevel(zoom);
    const data = (vnode.data ??= {});
    const classes = { ...(data.class ?? {}) };
    for (const [each, name] of Object.entries(DETAIL_CLASSES)) {
        classes[name] = each === level;
    }
    data.class = classes;
    return vnode;
}

/** The detail classes `element` carries, taken off while `body` runs and put back after: an export draws everything. */
export function withFullDetail<T>(element: { classList?: DOMTokenList } | null | undefined, body: () => T): T {
    const list = element?.classList;
    const lifted = list ? Object.values(DETAIL_CLASSES).filter(name => list.contains(name)) : [];
    lifted.forEach(name => list!.remove(name));
    try {
        return body();
    } finally {
        lifted.forEach(name => list!.add(name));
    }
}
