import type { Action } from '@eclipse-glsp/server';

/**
 * Open or close a bus: the ports of one bundle drawn as one row.
 *
 * Sent by the toggle in front of a bus port's name. The server keeps which
 * bundles are open in the layout file, beside the node positions, so a
 * bundle stays open across reopens: whether a bundle is open is how the
 * reader has arranged the diagram, not a fact about the source.
 *
 * The namespace lives here so the webview that sends it and the server that
 * handles it agree on the kind without importing each other.
 */
export namespace TogglePortBusOperation {
    export const KIND = 'dialogram.togglePortBus';

    export interface Operation extends Action {
        kind: typeof KIND;
        /** The bus port's id. */
        portId: string;
    }

    export function create(args: { portId: string }): Operation {
        return { kind: KIND, portId: args.portId };
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object'
            && (action as { kind?: unknown }).kind === KIND
            && typeof (action as { portId?: unknown }).portId === 'string';
    }
}
