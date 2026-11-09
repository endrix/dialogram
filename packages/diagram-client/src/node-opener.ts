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
 */
import type { Action, GModelElement } from '@eclipse-glsp/sprotty';

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
}
