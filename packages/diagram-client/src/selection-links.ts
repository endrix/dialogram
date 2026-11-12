/**
 * Links drawn only while one of their ends is selected.
 *
 * Some relations are too many to draw all at once: every state variable an
 * action reads, every action that takes a token from a port. A producer marks
 * such an edge `meta.onSelection`, and the server hands them over as data on
 * the root (`SELECTION_LINKS`) instead of as edges: they take no part in the
 * layout and are no elements of the model. Here they are drawn, over the
 * diagram, for the selection:
 *
 * - select a node, and every link it is an end of appears, with the node at
 *   its other end outlined;
 * - the other nodes that draw the same thing (`SAME_AS`: an action that has a
 *   box in several states) are outlined too, differently.
 *
 * A link leaves a node by the side that faces the other end: its top or
 * bottom when the two are more above each other than beside, a side
 * otherwise. Where a neighbour in the node's own frame is in the way on that
 * side (the row above, in a frame of rows), it takes the side across instead,
 * so it runs beside the neighbours and not over them. The links that share a
 * side are spread along it, in the order of what they lead to, so they fan
 * out and do not cross each other at the node.
 *
 * The drawing goes into the root's svg, inside the group the viewport
 * transforms, after everything else: on top, in the diagram's coordinates.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata, type SelectionLink } from '@dialogram/shared';
import { ZOOM_TEXT_CLASSES } from './zoom-detail';

export interface Box { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
type Side = 'top' | 'bottom' | 'left' | 'right';

/** What of the model the links need: ids, selection, place, size, arguments. */
export interface LinkElement {
    id: string;
    type?: string;
    selected?: boolean;
    position?: Point;
    size?: { width: number; height: number };
    bounds?: Box;
    args?: Record<string, unknown>;
    parent?: LinkElement;
    children?: readonly LinkElement[];
}

/** The links a root carries; nothing for a root with none, or with something else under the key. */
export function selectionLinksOf(root: LinkElement | undefined): SelectionLink[] {
    const raw = root?.args?.[WorkflowDiagramMetadata.SELECTION_LINKS];
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((link): link is SelectionLink =>
        !!link && typeof link.id === 'string' && typeof link.from === 'string' && typeof link.to === 'string');
}

/** Where an element is in the diagram: its place, taken through the elements that hold it. */
export function absoluteBox(element: LinkElement): Box {
    let x = 0;
    let y = 0;
    for (let current: LinkElement | undefined = element; current; current = current.parent) {
        // The root's own place is the viewport's, which the svg applies.
        if (current.parent) {
            x += current.position?.x ?? current.bounds?.x ?? 0;
            y += current.position?.y ?? current.bounds?.y ?? 0;
        }
    }
    return {
        x,
        y,
        width: element.size?.width ?? element.bounds?.width ?? 0,
        height: element.size?.height ?? element.bounds?.height ?? 0
    };
}

/** Whether `other` stands in the way of leaving `box` by `side`: beside it on that side, across its width or height. */
function inTheWay(box: Box, side: Side, other: Box): boolean {
    const overlapsAcross = other.x < box.x + box.width && box.x < other.x + other.width;
    const overlapsDown = other.y < box.y + box.height && box.y < other.y + other.height;
    switch (side) {
        case 'top': return overlapsAcross && other.y + other.height <= box.y;
        case 'bottom': return overlapsAcross && other.y >= box.y + box.height;
        case 'left': return overlapsDown && other.x + other.width <= box.x;
        default: return overlapsDown && other.x >= box.x + box.width;
    }
}

/**
 * The side of `box` a link to `toward` leaves by: the one that faces it, or,
 * when one of `neighbours` (the other nodes of the box's own frame) is in the
 * way there and not on the side across, that one.
 */
export function linkSide(box: Box, toward: Box, neighbours: readonly Box[] = []): Side {
    const dx = (toward.x + toward.width / 2) - (box.x + box.width / 2);
    const dy = (toward.y + toward.height / 2) - (box.y + box.height / 2);
    const upDown: Side = dy >= 0 ? 'bottom' : 'top';
    const sideways: Side = dx >= 0 ? 'right' : 'left';
    // Boxes are wider than tall, so "above each other" starts well before the diagonal.
    const [first, second] = Math.abs(dy) * 1.5 >= Math.abs(dx) ? [upDown, sideways] : [sideways, upDown];
    const blocked = (side: Side): boolean => neighbours.some(other => inTheWay(box, side, other));
    return blocked(first) && !blocked(second) ? second : first;
}

/** The point at `share` (0 to 1) along `side` of `box`. */
function onSide(box: Box, side: Side, share: number): Point {
    switch (side) {
        case 'top': return { x: box.x + box.width * share, y: box.y };
        case 'bottom': return { x: box.x + box.width * share, y: box.y + box.height };
        case 'left': return { x: box.x, y: box.y + box.height * share };
        default: return { x: box.x + box.width, y: box.y + box.height * share };
    }
}

const vertical = (side: Side): boolean => side === 'top' || side === 'bottom';

export interface DrawnLink {
    link: SelectionLink;
    from: Point;
    to: Point;
    fromSide: Side;
    toSide: Side;
}

/**
 * Where each link starts and ends. The links that share a side of a node are
 * spread along it in the order of where they lead across that side, so that
 * neighbours leave side by side and none crosses another at the node.
 */
export function placeLinks(
    links: readonly SelectionLink[],
    boxOf: (id: string) => Box | undefined,
    neighboursOf: (id: string) => readonly Box[] = () => []
): DrawnLink[] {
    const sided: Array<{ link: SelectionLink; fromBox: Box; toBox: Box; fromSide: Side; toSide: Side }> = [];
    for (const link of links) {
        const fromBox = boxOf(link.from);
        const toBox = boxOf(link.to);
        if (!fromBox || !toBox) {
            continue;
        }
        sided.push({
            link, fromBox, toBox,
            fromSide: linkSide(fromBox, toBox, neighboursOf(link.from)),
            toSide: linkSide(toBox, fromBox, neighboursOf(link.to))
        });
    }
    // node id + side -> the links at it, with where each leads across the side.
    const atSide = new Map<string, Array<{ id: string; across: number }>>();
    const note = (node: string, side: Side, id: string, other: Box): void => {
        const across = vertical(side) ? other.x + other.width / 2 : other.y + other.height / 2;
        const key = `${node}\u0000${side}`;
        atSide.set(key, [...(atSide.get(key) ?? []), { id, across }]);
    };
    for (const each of sided) {
        note(each.link.from, each.fromSide, each.link.id, each.toBox);
        note(each.link.to, each.toSide, each.link.id, each.fromBox);
    }
    const share = (node: string, side: Side, id: string): number => {
        const all = [...(atSide.get(`${node}\u0000${side}`) ?? [])].sort((a, b) => a.across - b.across || a.id.localeCompare(b.id));
        const index = all.findIndex(entry => entry.id === id);
        return (index + 1) / (all.length + 1);
    };
    return sided.map(each => ({
        link: each.link,
        from: onSide(each.fromBox, each.fromSide, share(each.link.from, each.fromSide, each.link.id)),
        to: onSide(each.toBox, each.toSide, share(each.link.to, each.toSide, each.link.id)),
        fromSide: each.fromSide,
        toSide: each.toSide
    }));
}

/** The pull of a curve away from a side: straight out of it. */
function outOf(point: Point, side: Side, by: number): Point {
    switch (side) {
        case 'top': return { x: point.x, y: point.y - by };
        case 'bottom': return { x: point.x, y: point.y + by };
        case 'left': return { x: point.x - by, y: point.y };
        default: return { x: point.x + by, y: point.y };
    }
}

/** The curve of a link: out of its first side, into its second, straight at both. */
export function linkPath(drawn: DrawnLink): string {
    const reach = Math.max(24, (Math.abs(drawn.to.x - drawn.from.x) + Math.abs(drawn.to.y - drawn.from.y)) / 3);
    const c1 = outOf(drawn.from, drawn.fromSide, reach);
    const c2 = outOf(drawn.to, drawn.toSide, reach);
    return `M${drawn.from.x},${drawn.from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${drawn.to.x},${drawn.to.y}`;
}

/** An arrowhead at `at`, pointing into the node through `side`. */
function arrowPath({ x, y }: Point, side: Side): string {
    const [length, half] = [9, 4.5];
    switch (side) {
        case 'top': return `M${x},${y} L${x - half},${y - length} L${x + half},${y - length} Z`;
        case 'bottom': return `M${x},${y} L${x - half},${y + length} L${x + half},${y + length} Z`;
        case 'left': return `M${x},${y} L${x - length},${y - half} L${x - length},${y + half} Z`;
        default: return `M${x},${y} L${x + length},${y - half} L${x + length},${y + half} Z`;
    }
}

/** Every element of the model, by id. */
function indexOf(root: LinkElement): Map<string, LinkElement> {
    const byId = new Map<string, LinkElement>();
    const visit = (element: LinkElement): void => {
        byId.set(element.id, element);
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return byId;
}

export interface LinksOfSelection {
    /** The links to draw. */
    links: SelectionLink[];
    /** The nodes at the other ends: what the selection uses, or is used by. */
    ends: Set<string>;
    /** The other nodes that draw what a selected node draws. */
    same: Set<string>;
}

/** What the selection brings up: its links, their other ends, and the other drawings of the same thing. */
export function linksOfSelection(root: LinkElement, byId: Map<string, LinkElement> = indexOf(root)): LinksOfSelection {
    const selected = new Set<string>();
    const things = new Set<string>();
    for (const element of byId.values()) {
        if (element.selected === true) {
            selected.add(element.id);
            const thing = element.args?.[WorkflowDiagramMetadata.SAME_AS];
            if (typeof thing === 'string') {
                things.add(thing);
            }
        }
    }
    const out: LinksOfSelection = { links: [], ends: new Set(), same: new Set() };
    if (selected.size === 0) {
        return out;
    }
    for (const link of selectionLinksOf(root)) {
        if (selected.has(link.from) || selected.has(link.to)) {
            out.links.push(link);
            for (const end of [link.from, link.to]) {
                if (!selected.has(end)) {
                    out.ends.add(end);
                }
            }
        }
    }
    if (things.size > 0) {
        for (const element of byId.values()) {
            const thing = element.args?.[WorkflowDiagramMetadata.SAME_AS];
            if (typeof thing === 'string' && things.has(thing) && !selected.has(element.id)) {
                out.same.add(element.id);
            }
        }
    }
    return out;
}

/** The drawing for the selection: the links, and the outlines of what they lead to; nothing when there is none. */
export function renderSelectionLinks(root: LinkElement): VNode | undefined {
    if (selectionLinksOf(root).length === 0 && !hasSameAs(root)) {
        return undefined;
    }
    const byId = indexOf(root);
    const { links, ends, same } = linksOfSelection(root, byId);
    if (links.length === 0 && same.size === 0) {
        return undefined;
    }
    const boxOf = (id: string): Box | undefined => {
        const element = byId.get(id);
        return element ? absoluteBox(element) : undefined;
    };
    const outline = (id: string, cssClass: string): VNode | undefined => {
        const box = boxOf(id);
        return box && svg('rect', {
            class: { 'selection-link-outline': true, [cssClass]: true },
            attrs: { x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6, rx: 5, ry: 5 }
        });
    };
    // The other nodes of a node's own frame: what a link should not run over on its way out.
    const neighboursOf = (id: string): Box[] => {
        const element = byId.get(id);
        const frame = element?.parent;
        if (!element || !frame?.parent) {
            return [];
        }
        return (frame.children ?? [])
            .filter(child => child !== element && typeof child.type === 'string' && child.type.startsWith('node'))
            .map(absoluteBox);
    };
    const drawn = placeLinks(links, boxOf, neighboursOf);
    return svg('g', { class: { 'selection-links': true } },
        ...[...same].map(id => outline(id, 'selection-link-same')).filter((node): node is VNode => !!node),
        ...[...ends].map(id => outline(id, 'selection-link-end')).filter((node): node is VNode => !!node),
        ...drawn.map(each => svg('g', {
            class: { 'selection-link': true, ...(each.link.role ? { [`selection-link-${each.link.role}`]: true } : {}) }
        },
            svg('path', { class: { 'selection-link-line': true }, attrs: { d: linkPath(each) } }),
            svg('path', { class: { 'selection-link-arrow': true }, attrs: { d: arrowPath(each.to, each.toSide) } }),
            ...(each.link.bidirectional
                ? [svg('path', { class: { 'selection-link-arrow': true }, attrs: { d: arrowPath(each.from, each.fromSide) } })]
                : []),
            ...(each.link.label
                ? [svg('text', {
                    class: { 'selection-link-label': true, [ZOOM_TEXT_CLASSES.detail]: true },
                    attrs: { x: (each.from.x + each.to.x) / 2, y: (each.from.y + each.to.y) / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }
                }, each.link.label)]
                : [])
        ))
    );
}

function hasSameAs(root: LinkElement): boolean {
    const visit = (element: LinkElement): boolean =>
        typeof element.args?.[WorkflowDiagramMetadata.SAME_AS] === 'string' || (element.children ?? []).some(visit);
    return visit(root);
}

/**
 * `vnode` (the diagram's svg) with the selection's links drawn over the
 * diagram: appended to the group the viewport transforms, so they are in the
 * diagram's coordinates and above everything in it. Only on screen: the
 * hidden render measures the model's own elements.
 */
export function withSelectionLinks(vnode: VNode | undefined, root: LinkElement | undefined, targetKind: string | undefined): VNode | undefined {
    if (!vnode || !root || targetKind !== 'main') {
        return vnode;
    }
    const overlay = renderSelectionLinks(root);
    if (!overlay) {
        return vnode;
    }
    const viewport = (vnode.children ?? []).find((child): child is VNode => typeof child === 'object' && child.sel === 'g');
    if (viewport) {
        viewport.children = [...(viewport.children ?? []), overlay];
        // The diagram's own edges step back while the links are read.
        const data = (vnode.data ??= {});
        data.class = { ...(data.class ?? {}), 'selection-links-shown': true };
    }
    return vnode;
}
