/**
 * What the producer answered to each edit made during one agent tool call.
 *
 * A diagram tool (create-edges, delete-elements, modify-nodes) dispatches a GLSP operation whose
 * handler asks the producer to rewrite the source. The model is re-read from that source only on
 * a later reload, so the stock tools' before/after diff of the model index never sees the edit:
 * `create-edges` said "Edge creation likely failed" for an edge it made, and `delete-elements`
 * said "deleted 0" for a node it deleted. The producer's invoker records each edit's answer here
 * instead, while the operation runs (it runs inside `dispatch`), and the tool reads them back
 * after it: what landed, and for what was refused, the producer's own reason.
 *
 * Session-singleton beside {@link AgentCreateNodeOutcomeSink}, so outcomes never cross diagrams.
 */
import { injectable } from 'inversify';

export interface AgentEditOutcome {
    /** The op as sent, with its runtime prefix (`<prefix>.connect`). */
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
    /** The answers of the collection running now; none: nobody is asking, and nothing is kept. */
    private open: AgentEditOutcome[] | undefined;
    private queue: Promise<unknown> = Promise.resolve();

    /**
     * An edit's answer, kept for the collection running now. Outside one (a person's own gesture,
     * which says what went wrong in its own way) it is dropped.
     */
    record(outcome: AgentEditOutcome): void {
        this.open?.push(outcome);
    }

    /**
     * Run `edit` and say what the producer answered while it ran. One collection at a time: a
     * tool call waits for the one before it, so two running at once never read, or wipe, each
     * other's answers. A gesture handled while one runs would still count for it; the action
     * dispatcher runs one action at a time, so that takes a gesture queued in that window.
     */
    collect<T>(edit: () => Promise<T>): Promise<{ value: T; outcomes: readonly AgentEditOutcome[] }> {
        const run = async (): Promise<{ value: T; outcomes: readonly AgentEditOutcome[] }> => {
            const outcomes: AgentEditOutcome[] = [];
            this.open = outcomes;
            try {
                return { value: await edit(), outcomes };
            } finally {
                // Only its own: a call that outlived its turn must not close the next one's.
                if (this.open === outcomes) {
                    this.open = undefined;
                }
            }
        };
        // A call that never ends (a producer that hangs) holds the next one back only so long:
        // after that the next runs, and the stuck call's late answers count for it.
        const previous = this.queue;
        const turn = Promise.race([previous, new Promise<void>(resolve => setTimeout(resolve, this.turnLimitMs).unref?.())]);
        const result = turn.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /** How long a call waits for the one before it. */
    turnLimitMs = 120_000;
}
