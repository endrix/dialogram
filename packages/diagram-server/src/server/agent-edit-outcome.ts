/**
 * What the producer answered to each edit made during one agent tool call.
 *
 * A diagram tool (create-edges, delete-elements, modify-nodes) dispatches a GLSP operation whose
 * handler asks the producer to rewrite the source. The model is re-read from that source only on
 * a later reload, so the stock tools' before/after diff of the model index never sees the edit:
 * `create-edges` said "Edge creation likely failed" for an edge it made, and `delete-elements`
 * said "deleted 0" for a node it deleted. The sidecar invoker records each edit's answer here
 * instead, while the operation runs (it runs inside `dispatch`), and the tool reads them back
 * after it: what landed, and for what was refused, the producer's own reason.
 *
 * Session-singleton beside {@link AgentCreateNodeOutcomeSink}, so outcomes never cross diagrams.
 */
import { injectable } from 'inversify';

export interface AgentEditOutcome {
    /** The op as sent, with its runtime prefix (`wfpy.connect`). */
    readonly op: string;
    readonly ok: boolean;
    /** The producer's reason for a refusal. */
    readonly message?: string;
}

/** Whether `op` (prefixed or bare) is the bare op `name`. */
export function isEditOp(op: string, ...names: string[]): boolean {
    return names.some(name => op === name || op.endsWith(`.${name}`));
}

@injectable()
export class AgentEditOutcomeSink {
    private outcomes: AgentEditOutcome[] = [];

    record(outcome: AgentEditOutcome): void {
        this.outcomes = [...this.outcomes, outcome];
    }

    /** Clear before a tool's dispatch, so only its own edits are read back. */
    reset(): void {
        this.outcomes = [];
    }

    /** Read-and-clear the outcomes recorded since the last reset. */
    take(): readonly AgentEditOutcome[] {
        const drained = this.outcomes;
        this.outcomes = [];
        return drained;
    }
}
