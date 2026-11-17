import type { Action } from '@eclipse-glsp/server';

/**
 * Neutral GLSP operation that scaffolds a new task type in the underlying source
 * via the language sidecar's `createTaskType` op.
 *
 * The namespace lives in `@dialogram/shared` (rather than co-located with its
 * sidecar-toolkit `OperationHandler`) so the product-neutral diagram-server
 * GLSP-MCP tool handler can construct and dispatch the operation without importing
 * the toolkit — which would both invert the core→toolkit import direction and trip
 * neutrality Gate 1 on the `sidecar` token. Both the reversible server handler
 * (sidecar-toolkit) and the MCP operation tool (diagram-server) import the KIND and
 * factory from here, so the operation kind is defined exactly once.
 *
 * The Python sidecar signature is `create_task_type(*, kind, name)`. The operation
 * carries the type name and, optionally, its kind (`typeKind`, a word of the
 * product's: the decorator name for wfpy); without one the handler asks for the
 * neutral task kind, as it always did.
 */
export namespace CreateTaskTypeOperation {
    export const KIND = 'dialogram.createTaskType';

    export interface Operation extends Action {
        kind: typeof KIND;
        name: string;
        /** The kind of type to make (`agent`, `viewer`, `workflow`, …); the task kind when absent. */
        typeKind?: string;
    }

    export function create(args: { name: string; typeKind?: string }): Operation {
        return { kind: KIND, name: args.name, ...(args.typeKind ? { typeKind: args.typeKind } : {}) };
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as { kind?: unknown }).kind === KIND;
    }
}
