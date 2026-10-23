/**
 * A profile's status source, wired: its two commands, the `collect` call the
 * first makes, and the publish of the answer into the execution overlay.
 *
 * The overlay already knew how to hold node states and the diagram how to draw
 * a running, finished or failed node; what was missing was anything that put
 * states there outside a run. A report (a coverage table, a list of checks)
 * has none of a run's machinery to offer and needs none of it: the person asks,
 * the product's tool answers once, the answer is shown until asked again or
 * cleared. This is that, and nothing of the run driver.
 *
 * Kept free of `vscode`: the host is passed in, so the tests drive it with a
 * fake and `glsp-activation.ts` with the real window and commands.
 */
import type { ExecutionNodeState, ExecutionNodeStatus } from '@dialogram/shared';
import type { DiagramStatusContext, DiagramStatusSource } from '../../api';

/** The diagram a status command acts on. */
export interface StatusSourceTarget {
    /** The source URI the diagram is registered under, as the overlay keys it. */
    sourceUri: string;
    /** Its absolute path, what `collect` is given. */
    file: string;
}

/** What a status source needs from the host. */
export interface StatusSourceHost {
    /** The diagram a command invoked with `arg` is about: the URI given, else
     *  the active diagram; `undefined` when there is none. */
    targetOf(arg: unknown): StatusSourceTarget | undefined;
    overlay: { publish(sourceUri: string, states: ExecutionNodeState[]): void };
    output: DiagramStatusContext['output'];
    registerCommand(id: string, handler: (arg?: unknown) => unknown): { dispose(): void };
    /** Runs `task` with a progress indication titled `title`. */
    withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
    showError(message: string): void;
    showWarning(message: string): void;
    /** A transient line in the status bar. */
    setStatusMessage(message: string): void;
}

const STATUSES: ReadonlySet<ExecutionNodeStatus> = new Set<ExecutionNodeStatus>(['idle', 'running', 'succeeded', 'failed']);

/**
 * The states in what `collect` returned. The function crosses the extension
 * API, so its answer is checked rather than trusted: anything but a list is an
 * error worth reporting, and an entry without a node id or with a status the
 * diagram cannot draw is dropped rather than sent.
 */
export function statesFromCollect(value: unknown): ExecutionNodeState[] {
    if (!Array.isArray(value)) {
        throw new Error('the status source returned no list of node states');
    }
    const states: ExecutionNodeState[] = [];
    for (const entry of value) {
        const nodeId = (entry as { nodeId?: unknown } | null)?.nodeId;
        const status = (entry as { status?: unknown } | null)?.status;
        const detail = (entry as { detail?: unknown } | null)?.detail;
        if (typeof nodeId !== 'string' || nodeId === '' || !STATUSES.has(status as ExecutionNodeStatus)) {
            continue;
        }
        states.push({
            nodeId,
            status: status as ExecutionNodeStatus,
            ...(typeof detail === 'string' && detail !== '' ? { detail } : {})
        });
    }
    return states;
}

/** `Coverage: 3 succeeded, 22 failed, 7 running`: what was shown, in a line. */
export function summarizeStates(label: string, states: readonly ExecutionNodeState[]): string {
    const counts = new Map<ExecutionNodeStatus, number>();
    for (const state of states) {
        if (state.status !== 'idle') {
            counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
        }
    }
    const order: ExecutionNodeStatus[] = ['succeeded', 'failed', 'running'];
    const parts = order.filter(status => counts.has(status)).map(status => `${counts.get(status)} ${status}`);
    return `${label}: ${parts.length > 0 ? parts.join(', ') : 'nothing to show'}`;
}

/**
 * Register the status source's two commands. Show collects for the target
 * diagram and publishes what comes back, replacing what was shown; a failure
 * is reported and leaves the diagram as it was. Clear publishes nothing.
 *
 * One collect at a time per diagram: a second Show while the first is still
 * out waits for that one instead of starting a race whose loser would be
 * painted last. A Clear while one is out wins: its answer is not shown.
 */
export function registerStatusSource(source: DiagramStatusSource, host: StatusSourceHost): { dispose(): void } {
    const inFlight = new Map<string, Promise<boolean>>();
    // Bumped by Clear, so an answer that arrives after it is dropped.
    const clears = new Map<string, number>();

    const show = (arg?: unknown): Promise<boolean> => {
        const target = host.targetOf(arg);
        if (!target) {
            host.showWarning(`No diagram to show ${source.label} on. Focus an open diagram tab and try again.`);
            return Promise.resolve(false);
        }
        const pending = inFlight.get(target.sourceUri);
        if (pending) {
            return pending;
        }
        const clearsAtStart = clears.get(target.sourceUri) ?? 0;
        const run = (async (): Promise<boolean> => {
            host.output.appendLine(`[${source.label}] ${target.file}`);
            try {
                const states = statesFromCollect(
                    await host.withProgress(source.label, () => source.collect(target.file, { output: host.output }))
                );
                if ((clears.get(target.sourceUri) ?? 0) !== clearsAtStart) {
                    host.output.appendLine(`[${source.label}] cleared while it ran; not shown`);
                    return false;
                }
                host.overlay.publish(target.sourceUri, states);
                const summary = summarizeStates(source.label, states);
                host.output.appendLine(`[${source.label}] ${summary}`);
                host.setStatusMessage(summary);
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                host.output.appendLine(`[${source.label}] failed: ${message}`);
                host.showError(`${source.label} failed: ${message}`);
                return false;
            } finally {
                inFlight.delete(target.sourceUri);
            }
        })();
        inFlight.set(target.sourceUri, run);
        return run;
    };

    const clear = (arg?: unknown): boolean => {
        const target = host.targetOf(arg);
        if (!target) {
            host.showWarning(`No diagram to clear ${source.label} from. Focus an open diagram tab and try again.`);
            return false;
        }
        clears.set(target.sourceUri, (clears.get(target.sourceUri) ?? 0) + 1);
        host.overlay.publish(target.sourceUri, []);
        return true;
    };

    const registrations = [
        host.registerCommand(source.showCommand, show),
        host.registerCommand(source.clearCommand, clear)
    ];
    return { dispose: () => registrations.forEach(registration => registration.dispose()) };
}
