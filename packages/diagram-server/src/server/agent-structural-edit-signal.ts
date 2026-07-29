import { injectable } from 'inversify';

/** Cheap, permanent breadcrumb gate (WORKFLOW_DIAGRAM_DEBUG=1) for the agent auto-layout chain. */
function debugEnabled(): boolean {
    return process.env.WORKFLOW_DIAGRAM_DEBUG === '1';
}

/**
 * Per-session flag: an agent-dispatched (headless) structural edit — a create-node or a
 * create-edge issued through the MCP tool surface — is awaiting an automatic layout.
 *
 * The MCP tool handlers raise the flag the moment they dispatch the mutating operation. The
 * source rewrite lands, the file watcher reloads the model, and the model-submission handler
 * consumes the flag on the first submit AFTER that reload to run a full boundary-flow layout — so
 * agent-added nodes never sit at their parked default positions and agent-added edges relayout
 * the graph. Palette / webview edits never raise the flag, so their placement path is untouched.
 *
 * Reload-generation gating (the real 0.6.0 regression fix). Dispatching the mutating operation
 * ALSO triggers an immediate post-operation model submit (GLSP `OperationActionHandler` re-submits
 * after every operation) — and, under client layout, that submit completes through a
 * ComputedBounds round-trip. That post-op submit runs on the CURRENT, not-yet-reloaded model
 * (the create rewrote the source out-of-band; the model only re-sources on the later watcher
 * reload). A naive boolean flag is therefore consumed by that premature post-op submit, against a
 * model that does not yet contain the new node/edge, and the real reload — the one that actually
 * carries the agent's edit — finds the flag already lowered and skips the layout. The node lands
 * but nothing lays out (exactly the smoke symptom).
 *
 * So the flag is armed against the load generation at raise time and only reads as pending once a
 * LATER source reload has advanced the generation. {@link noteSourceReloaded} (called from
 * {@link WorkflowSourceModelStorage.loadSourceModel}) bumps the generation; a submit with no
 * intervening reload — the post-op submit — sees `loadGeneration === markedGeneration` and cannot
 * consume it. The watcher reload that carries the edit bumps the generation, so the reload's own
 * submit consumes it and runs boundary-flow.
 *
 * Bound `toSelf().inSingletonScope()` in the per-session container, so one open diagram's agent
 * edit never triggers another open diagram's relayout.
 */
@injectable()
export class AgentStructuralEditSignal {
    /** Load generation at which a structural edit was last marked; `undefined` when none is armed. */
    private markedGeneration: number | undefined = undefined;

    /** Monotonic count of source reloads observed this session. */
    private loadGeneration = 0;

    /** Raise the flag: an agent structural edit now awaits auto-layout on the NEXT reload's submit. */
    markPending(): void {
        this.markedGeneration = this.loadGeneration;
        if (debugEnabled()) {
            // eslint-disable-next-line no-console
            console.log(`[agent-auto-layout] signal RAISED (armed at loadGen=${this.loadGeneration})`);
        }
    }

    /**
     * Record that the source model was (re)loaded. A structural edit only becomes consumable once
     * at least one reload has happened AFTER it was marked — this is what stops the premature
     * post-operation submit (which reloads nothing) from consuming the flag before the real reload.
     */
    noteSourceReloaded(): void {
        this.loadGeneration += 1;
        if (debugEnabled() && this.markedGeneration !== undefined) {
            // eslint-disable-next-line no-console
            console.log(`[agent-auto-layout] source RELOADED (loadGen=${this.loadGeneration}, armed at ${this.markedGeneration}, nowPending=${this.isPending()})`);
        }
    }

    /**
     * True while an agent structural edit awaits auto-layout AND a reload has occurred since it was
     * marked. A marked-but-not-yet-reloaded edit reads as not pending, so a post-op submit skips it.
     */
    isPending(): boolean {
        return this.markedGeneration !== undefined && this.loadGeneration > this.markedGeneration;
    }

    /** Read-and-clear: returns whether a relayout was owed (and reload-confirmed), then lowers the flag. */
    consumePending(): boolean {
        const pending = this.isPending();
        if (pending) {
            this.markedGeneration = undefined;
            if (debugEnabled()) {
                // eslint-disable-next-line no-console
                console.log(`[agent-auto-layout] signal CONSUMED at loadGen=${this.loadGeneration}`);
            }
        }
        return pending;
    }
}
