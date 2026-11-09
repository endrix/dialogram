/**
 * Node sections: the property panel's contribution point for what a product
 * shows about a node beside the panel's own sections.
 *
 * The panel draws a node as Basic Info, the producer's fields and facts,
 * Annotations, parameters and ports. A contribution adds rows to Basic Info and
 * sections after Annotations or after the ports, keeps a section of its own up
 * to date while the model changes, and can prepare what it reads before a node
 * is drawn. A product binds its contributions in a feature module:
 *
 *     bind(NodeSectionContribution).toConstantValue(mySections);
 *
 * and passes the module to `startStockDiagram({ features })`. There is one
 * contribution per `id`: a later binding for an id replaces the earlier one, so
 * a product's module, which loads after the stock one, can replace a stock
 * contribution. Contributions are asked in the order their ids were first
 * bound, so their rows and sections come in that order.
 */
import type { PropertyElement } from './property-model';

export const NodeSectionContribution = Symbol.for('dialogram.NodeSectionContribution');

/** The diagram's model root as the panel's contributions read it. */
export interface PanelModelRoot {
    readonly args?: Readonly<Record<string, unknown>>;
    readonly index?: { getById(id: string): PropertyElement | undefined };
}

/** A row of Basic Info: a label and its value, as text. */
export interface NodeInfoRow {
    readonly label: string;
    readonly value: string;
}

export interface NodeSectionContext {
    /** The name the panel shows for the node. */
    readonly entityName: string;
}

/** What the panel offers a contribution once, when it starts. */
export interface NodeSectionHost {
    /**
     * Draw the node again if the panel is open on it, without the editors
     * asking for discovery again: for a contribution whose answer arrived.
     */
    redrawIfShowing(elementId: string): void;
}

export interface NodeSectionContribution {
    /** What the contribution is, for a later binding to replace it (the agent sections are `'agent'`). */
    readonly id: string;

    /** Once, when the panel starts. */
    install?(host: NodeSectionHost): void;

    /** Before a selected node is drawn (not the node of a selected port). */
    prepare?(node: PropertyElement, root: PanelModelRoot | undefined): void;

    /** Rows of Basic Info, after the node's type. */
    infoRows?(node: PropertyElement): readonly NodeInfoRow[];

    /** A section right after Annotations, or nothing. */
    afterAnnotations?(node: PropertyElement, context: NodeSectionContext): HTMLElement | undefined;

    /** A section after the ports, the panel's last, or nothing. */
    last?(node: PropertyElement, context: NodeSectionContext): HTMLElement | undefined;

    /**
     * The model changed while the panel shows `node`. A contribution updates
     * its own section in place, in `content`, the element holding the node's
     * sections; the panel does not redraw.
     */
    modelChanged?(node: PropertyElement, content: HTMLElement): void;
}
