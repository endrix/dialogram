import { injectable } from 'inversify';

/**
 * Per-session flag: an agent-dispatched (headless) structural edit — a create-node or a
 * create-edge issued through the MCP tool surface — is awaiting an automatic layout.
 *
 * The MCP tool handlers raise the flag the moment they dispatch the mutating operation. The
 * source rewrite lands, the file watcher reloads the model, and the model-submission handler
 * consumes the flag on the first bounds-ready submit to run a full boundary-flow layout — so
 * agent-added nodes never sit at their parked default positions and agent-added edges relayout
 * the graph. Palette / webview edits never raise the flag, so their placement path is untouched.
 *
 * Bound `toSelf().inSingletonScope()` in the per-session container, so one open diagram's agent
 * edit never triggers another open diagram's relayout.
 */
@injectable()
export class AgentStructuralEditSignal {
    private pending = false;

    /** Raise the flag: an agent structural edit now awaits auto-layout. */
    markPending(): void {
        this.pending = true;
    }

    /** True while an agent structural edit still awaits auto-layout. */
    isPending(): boolean {
        return this.pending;
    }

    /** Read-and-clear: returns whether a relayout was owed, then lowers the flag. */
    consumePending(): boolean {
        const wasPending = this.pending;
        this.pending = false;
        return wasPending;
    }
}
