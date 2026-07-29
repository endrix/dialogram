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
 * The Python sidecar signature is `create_task_type(*, kind, name)` — it accepts only
 * `kind` and `name` — so the operation carries just the type name; the reversible
 * handler pins the neutral task `kind` when it invokes the sidecar.
 */
export namespace CreateTaskTypeOperation {
    export const KIND = 'dialogram.createTaskType';

    export interface Operation extends Action {
        kind: typeof KIND;
        name: string;
    }

    export function create(args: { name: string }): Operation {
        return { kind: KIND, name: args.name };
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as { kind?: unknown }).kind === KIND;
    }
}
