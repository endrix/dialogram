import { injectable } from 'inversify';

/**
 * Per-session channel that carries the OUTCOME of an agent-dispatched (headless) create-node from
 * the operation handler (which actually rewrites the source) back to the MCP `create-nodes` tool
 * handler (which must report an honest result to the agent).
 *
 * Why this exists: in dialogram a create rewrites the `.py` source through a reversible workspace
 * edit and the GModel is only re-sourced on a LATER reload cycle — never synchronously within the
 * operation dispatch. The stock GLSP-MCP `create-nodes` handler infers success from a
 * `modelState.index` diff taken immediately after dispatch, so in dialogram that diff is ALWAYS
 * empty: a genuinely successful create looks identical to a failure, and the tool returns a
 * success-shaped "0 node(s) created" with a misleading generic note. The agent therefore never
 * learns that a create succeeded, and never learns WHY one was rejected.
 *
 * The operation handler records the authoritative outcome here (only on the headless path — the
 * palette/webview flow never touches this); the MCP tool override drains it after dispatch and
 * turns it into a real confirmation (`isError:false` with the created id + name) or a real tool
 * error (`isError:true` with the actionable message naming exactly which `args.*` to pass).
 *
 * Bound `toSelf().inSingletonScope()` in the per-session container so both the operation handler
 * and the MCP tool handler resolve the SAME instance for one open diagram, and one diagram's
 * outcome never leaks into another's.
 */

/** One port of a created node, carried in the confirmation so the next create-edges needs no query. */
export interface CreatedNodePort {
    readonly name: string;
    /** 'in' | 'out' | 'unknown' — informational; edge validation still owns direction correctness. */
    readonly direction?: string;
}

/** A create that landed on disk. `name` is the source-level instance identity; `type` its class. */
export interface CreatedNodeOutcome {
    readonly kind: 'created';
    readonly name: string;
    readonly type: string;
    /**
     * The created node's port names (and directions where known), so an agent can connect it via
     * `create-edges` with `args.source`/`args.target` = "name.port" WITHOUT a query-elements dump.
     * Best-effort: empty when the node's type definition is not resolvable from the rewritten source
     * (e.g. an existing type declared in another module).
     */
    readonly ports?: readonly CreatedNodePort[];
}

/** A create the headless path refused, carrying an agent-actionable message. */
export interface RejectedNodeOutcome {
    readonly kind: 'rejected';
    readonly message: string;
}

export type AgentCreateNodeOutcome = CreatedNodeOutcome | RejectedNodeOutcome;

@injectable()
export class AgentCreateNodeOutcomeSink {
    private outcomes: readonly AgentCreateNodeOutcome[] = [];

    /** Record a successful create (instance name + concrete type + optional discovered ports). */
    recordCreated(name: string, type: string, ports?: readonly CreatedNodePort[]): void {
        this.outcomes = [...this.outcomes, { kind: 'created', name, type, ports: ports && ports.length > 0 ? ports : undefined }];
    }

    /** Record a rejected create with the actionable, agent-facing message. */
    recordRejected(message: string): void {
        this.outcomes = [...this.outcomes, { kind: 'rejected', message }];
    }

    /** Clear any stale outcomes before a fresh dispatch. */
    reset(): void {
        this.outcomes = [];
    }

    /** Read-and-clear: returns the outcomes recorded since the last drain, then empties the sink. */
    take(): readonly AgentCreateNodeOutcome[] {
        const drained = this.outcomes;
        this.outcomes = [];
        return drained;
    }
}
