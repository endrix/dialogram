/**
 * Node openers: the contribution point for what a double-click on a node
 * opens.
 *
 * The platform opens a node's definition (preview), unless the network
 * navigation listener already opens something for it. An opener a product
 * binds is asked first: it answers with the actions that open what the node
 * stands for in that product, or `undefined` to leave the node to the
 * platform. A product binds its openers in a feature module:
 *
 *     bind(NodeOpener).toConstantValue(myOpener);
 *
 * There is one opener per `id`: a later binding for an id replaces the
 * earlier one, and an opener without an id is dropped. Openers are asked in
 * the order their ids were first bound; the first that answers with actions
 * wins (an empty list is no answer), and one that throws is skipped.
 *
 * The network navigation listener may open something for the same
 * double-click (a node's first view); the platform's definition stands back
 * for it, but an opener's answer does not. An opener should leave such nodes
 * unless it means to open its own thing beside the view.
 *
 * A list of nodes outside the canvas (the node list, `node-list-outline.ts`)
 * asks an opener beforehand whether a node can be opened now
 * (`canOpen`), to dim the rows that cannot: a viewer before the run that
 * makes its file, say. Its double click asks `open`, as the canvas's does,
 * of a node of another view as the canvas would draw it, its root holding
 * the edges into it and the run's arguments (`detachedElement`).
 */
import type { Action, GModelElement } from '@eclipse-glsp/sprotty';
import type { DetachedNode } from '@dialogram/shared';
import { lastPerKey } from './contributions';

export const NodeOpener = Symbol.for('dialogram.NodeOpener');

export interface NodeOpenerContext {
    /** The file the diagram was opened from, if any. */
    readonly sourceUri: string | undefined;
}

export interface NodeOpener {
    /** What the opener is, for a later binding to replace it. */
    readonly id: string;
    /** The actions a double-click on `node` runs, or `undefined` (or none) to leave it to the platform. */
    open(node: GModelElement, context: NodeOpenerContext): Array<Action | Promise<Action>> | undefined;
    /**
     * Whether `open` would open what `node` stands for now: `true`, or why
     * not, in a few words the reader is shown ("Run the workflow first");
     * `undefined` for a node that is not this opener's. Asked only by lists
     * of nodes outside the canvas, to dim what cannot be opened yet; the
     * canvas's double click asks `open` whatever this says. Absent, every
     * node `open` takes is taken to open.
     */
    canOpen?(node: GModelElement, context: NodeOpenerContext): true | string | undefined;
}

/** One opener per id, in the order the ids were first bound; a later binding replaces the earlier one. */
export function openersInOrder(bound: readonly NodeOpener[] | undefined): NodeOpener[] {
    return lastPerKey(bound, opener => opener.id);
}

/**
 * What the openers open for `node`: the first answer with actions, in their
 * order. An opener that throws is skipped, so it cannot stop the node from
 * opening anything; `undefined` when none answers.
 */
export function openNode(
    openers: readonly NodeOpener[],
    node: GModelElement,
    context: NodeOpenerContext
): Array<Action | Promise<Action>> | undefined {
    for (const opener of openers) {
        let opened: Array<Action | Promise<Action>> | undefined;
        try {
            opened = opener.open(node, context);
        } catch (error) {
            console.warn(`[dialogram] the node opener '${opener.id}' failed`, error);
            continue;
        }
        if (opened && opened.length > 0) {
            return opened;
        }
    }
    return undefined;
}

/**
 * Whether `node` can be opened now: what the first opener that takes it
 * says (`NodeOpener.canOpen`), `true` when none does. An opener that throws
 * is passed over.
 */
export function nodeOpenability(
    openers: readonly NodeOpener[],
    node: GModelElement,
    context: NodeOpenerContext
): true | string {
    for (const opener of openers) {
        let said: true | string | undefined;
        try {
            said = opener.canOpen?.(node, context);
        } catch (error) {
            console.warn(`[dialogram] the node opener '${opener.id}' could not say whether it opens a node`, error);
            continue;
        }
        if (said === true || (typeof said === 'string' && said.trim() !== '')) {
            return said;
        }
    }
    return true;
}

/**
 * A node of another view as an element, as the canvas would hold it: its
 * `root` holds it and the edges into it, and carries the run's arguments
 * (`NodeListOutline.rootArgs`), or the node's own run's when it has one
 * (`DetachedNode.rootArgs`: a node in a unit answered by a past run).
 * Enough for an opener that reads a node, its root's edges and its root's
 * arguments; it is no element of the canvas's model.
 */
export function detachedElement(detached: DetachedNode, rootArgs?: Record<string, unknown>): GModelElement {
    const root: Record<string, unknown> & { children: unknown[] } = {
        id: `${detached.id}~detached-root`,
        type: 'graph',
        args: { ...(detached.rootArgs ?? rootArgs ?? {}) },
        children: []
    };
    root.root = root;
    const node = { id: detached.id, type: detached.type, args: { ...(detached.args ?? {}) }, children: [], root, parent: root };
    root.children.push(node, ...detached.edges.map(edge => ({ ...edge, args: { ...(edge.args ?? {}) }, children: [], root, parent: root })));
    return node as unknown as GModelElement;
}
