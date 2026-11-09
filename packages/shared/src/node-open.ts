import type { Action } from '@eclipse-glsp/server';

/**
 * Open or close a node that holds a graph of its own (a producer's
 * `meta.inner`: a process and the cells it is made of).
 *
 * Opened, the node is drawn as a group frame, titled with its name, holding
 * its inner nodes; its edges run to the inner pins they reach. Closed, it is
 * the node again. Whether a node is open is how the reader has arranged the
 * diagram, so the server keeps it in the layout file with the open bundles
 * (`portBuses`), under the node's key and the reserved name `OPEN`.
 */
export namespace ToggleNodeOpenOperation {
    export const KIND = 'dialogram.toggleNodeOpen';

    /** The name an open node is listed under among its node's open bundles. */
    export const OPEN = '*';

    export interface Operation extends Action {
        kind: typeof KIND;
        /** The node's id, closed, or the frame's, open. */
        nodeId: string;
    }

    export function create(args: { nodeId: string }): Operation {
        return { kind: KIND, nodeId: args.nodeId };
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object'
            && (action as { kind?: unknown }).kind === KIND
            && typeof (action as { nodeId?: unknown }).nodeId === 'string';
    }
}
