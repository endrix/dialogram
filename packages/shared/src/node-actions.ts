/**
 * What a producer says can be done to a node, besides what the platform does.
 *
 * The platform draws a producer's graph and edits it through the operations
 * it knows. A producer whose picture is a view it grows itself (a schematic
 * that starts from one cell and takes in a pin's fan-in on request) has
 * things to offer the platform has no word for. It lists them on the node
 * (`meta.actions`) or on the graph (`graph.meta.actions`, for the canvas),
 * each an id of its own and the label a menu shows; the product names the one
 * VS Code command that carries them out (`clientBehavior.nodeActionCommand`).
 *
 * The document says what is on offer and the product, not the document, says
 * what runs: a graph cannot name a command of its own choosing. The platform
 * only carries the request from the click to the command, with the node it
 * was made on (`NodeActionRequest`); the command does the work and asks for
 * the diagram again (`refreshDiagramModel`). When the work added a node the
 * reader should be looking at, the command names it (`reveal`) and the
 * diagram selects and centres it once the model that has it arrives
 * (`RevealNodeAction`): what a step adds is not always where the view is.
 */

/** One thing a producer offers on a node, or on the canvas. */
export interface NodeActionSpec {
    /** The producer's own name for it, handed back in the request. */
    id: string;
    /** What the context menu shows. */
    label: string;
    /**
     * Whether a double-click does it, and where: `'node'` anywhere on the
     * node, `'port'` on one of its ports only (the request then names the
     * port). At most one of each is taken, the first.
     */
    doubleClick?: 'node' | 'port';
    /** `false` keeps it off the context menu: a double-click's alone. */
    menu?: boolean;
}

/** What the product's command is called with. */
export interface NodeActionRequest {
    /** The action's id, as the producer listed it. */
    action: string;
    /** The file the diagram is of. */
    sourceUri: string;
    /** The unit shown. */
    workflowName?: string;
    /** The view shown, when it is not the structure. */
    view?: string;
    /** The producer's id of the node; absent for an action of the canvas. */
    nodeId?: string;
    /** The node's label. */
    label?: string;
    /** The node's meta, as the producer sent it. */
    meta?: Record<string, unknown>;
    /** The port a double-click was made on, by its name. */
    port?: string;
}

/** The client action a menu item or a double-click dispatches. */
export namespace NodeActionAction {
    export const KIND = 'dialogram.nodeAction';

    export interface Action {
        kind: typeof KIND;
        /** The action's id. */
        action: string;
        /** The model element it is made on; absent for the canvas. */
        elementId?: string;
        /** The port it was made on, by its name. */
        port?: string;
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as { kind?: unknown }).kind === KIND
            && typeof (action as { action?: unknown }).action === 'string';
    }
}

/** Host to diagram: select and centre the node of this name in the next model that has it. */
export namespace RevealNodeAction {
    export const KIND = 'dialogram.revealNode';

    export interface Action {
        kind: typeof KIND;
        /** The node's name, as its producer labelled it. */
        nodeName: string;
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as { kind?: unknown }).kind === KIND
            && typeof (action as { nodeName?: unknown }).nodeName === 'string' && (action as { nodeName: string }).nodeName !== '';
    }

    export function create(nodeName: string): Action {
        return { kind: KIND, nodeName };
    }
}

/** The actions a `meta.actions` lists: those with an id and a label, each id once. */
export function parseNodeActions(raw: unknown): NodeActionSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: NodeActionSpec[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const { id, label, doubleClick, menu } = entry as Record<string, unknown>;
        if (typeof id !== 'string' || id.trim() === '' || typeof label !== 'string' || label.trim() === '' || seen.has(id)) {
            continue;
        }
        seen.add(id);
        out.push({
            id,
            label: label.trim(),
            ...(doubleClick === 'node' || doubleClick === 'port' ? { doubleClick } : {}),
            ...(menu === false ? { menu: false } : {})
        });
    }
    return out;
}

/** The action a double-click does: on a port, the port's, else the node's. */
export function doubleClickAction(actions: readonly NodeActionSpec[], onPort: boolean): NodeActionSpec | undefined {
    return (onPort ? actions.find(a => a.doubleClick === 'port') : undefined) ?? actions.find(a => a.doubleClick === 'node');
}
