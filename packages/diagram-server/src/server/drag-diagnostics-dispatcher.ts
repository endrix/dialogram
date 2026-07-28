/**
 * TEMPORARY DIAGNOSTIC — remove before merge.
 *
 * Suspect 1 (drag-storm regression, GLSP 2.5 → 2.7): the rewritten server
 * `DefaultActionDispatcher` serializes every external action through ONE
 * `ActionQueue`, fully draining each item (incl. our awaited reroute + disk I/O)
 * before the next. If the user drags faster than one item drains, the queue backs
 * up without bound → progressive lag → the latest move lands late/never. A secondary
 * watch-item is a `pendingRequests` leak from any no-timeout `request()` that never
 * gets a correlated response.
 *
 * This subclass adds ZERO behavior change: it observes the two accumulators the base
 * owns (`actionQueue.size`, `pendingRequests.size`) on every `dispatch()` and emits a
 * `[drag-diag]` breadcrumb, then delegates to `super.dispatch()` unchanged. It is bound
 * over the stock `ActionDispatcher` in `server-module.ts` (also TEMPORARY).
 *
 * Reading the breadcrumbs during an F5 drag storm:
 *   - `queue=` climbing and not returning to 0  ⇒ Suspect 1a (backpressure) CONFIRMED
 *   - `pending=` climbing                        ⇒ Suspect 1b (request() leak) CONFIRMED
 *   - both hover near 0                          ⇒ Suspect 1 REFUTED
 */
import { DefaultActionDispatcher } from '@eclipse-glsp/server';
import { Action } from '@eclipse-glsp/protocol';
import { injectable } from 'inversify';

/** Emit a line whenever either accumulator exceeds this depth. */
const DRAG_DIAG_BACKLOG_THRESHOLD = 3;
/** Otherwise emit a baseline sample every Nth dispatch so the log shows the steady state too. */
const DRAG_DIAG_SAMPLE_EVERY = 20;

@injectable()
export class DragDiagnosticsActionDispatcher extends DefaultActionDispatcher {
    private dragDiagDispatchCount = 0;

    override dispatch(action: Action): Promise<void> {
        this.dragDiagDispatchCount++;
        // `actionQueue` and `pendingRequests` are `protected` on the base — sample without mutating.
        const queue = this.actionQueue.size;
        const pending = this.pendingRequests.size;
        if (
            queue > DRAG_DIAG_BACKLOG_THRESHOLD ||
            pending > DRAG_DIAG_BACKLOG_THRESHOLD ||
            this.dragDiagDispatchCount % DRAG_DIAG_SAMPLE_EVERY === 0
        ) {
            // eslint-disable-next-line no-console
            console.log(`[drag-diag] queue=${queue} pending=${pending} action=${action.kind}`);
        }
        return super.dispatch(action);
    }
}
