/**
 * A failed run, told to the person and to the agent that may fix it.
 *
 * When a run fails in a diagram with a chat behind it, the driver offers to
 * have the chat look at it: a new session, in plan mode, whose first message is
 * the failure -- where it happened, the error, the end of the run's output and
 * where its files are. Plan mode, because the person asked for a diagnosis and
 * a proposal, not for files to change under them.
 */

/** What a run record says about a failure (all of it optional). */
export interface RunFailure {
    message?: string;
    /** The failing node's instance path from the root, `['m', 'i', 'x']`. */
    entityInstancePath?: string[];
    entityInstanceName?: string;
}

/** The task the chat is asked to start: its session's name, its mode, its first message. */
export interface FixTask {
    name: string;
    mode: 'plan' | 'build';
    prompt: string;
}

/** The chat tool that resumes the failed run once a fix is in. */
export const RESUME_TOOL = 'resume_failed_run';

/** At most this much of the run's stderr goes to the agent: the end, where the traceback is. */
export const STDERR_TAIL_CHARS = 8000;

/** Keep the end of a growing stream of text, as the run writes it. */
export function appendTail(tail: string, chunk: string, max = STDERR_TAIL_CHARS): string {
    const next = tail + chunk;
    return next.length > max ? next.slice(next.length - max) : next;
}

/** Where it failed, for a person: `x (in m › i)`, or the node alone at the root. */
export function failureWhere(failure: RunFailure | undefined): string | undefined {
    const path = failure?.entityInstancePath?.filter(part => part.trim() !== '') ?? [];
    if (path.length > 0) {
        const node = path[path.length - 1];
        return path.length > 1 ? `${node} (in ${path.slice(0, -1).join(' › ')})` : node;
    }
    return failure?.entityInstanceName?.trim() || undefined;
}

/** The first line of the error, short enough for a notification. */
export function failureHeadline(failure: RunFailure | undefined, exitCode: number): string {
    const first = failure?.message?.split(/\r?\n/).find(line => line.trim() !== '')?.trim();
    const error = first ? (first.length > 160 ? `${first.slice(0, 157)}…` : first) : `exit code ${exitCode}`;
    const where = failureWhere(failure);
    return where ? `Run failed in ${where}: ${error}` : `Run failed: ${error}`;
}

/** The chat task that asks the agent for the cause and a fix. */
export function fixTask(opts: {
    workflowName?: string;
    sourceFile: string;
    failure: RunFailure | undefined;
    exitCode: number;
    stderrTail: string;
    runDir?: string;
    canResume: boolean;
}): FixTask {
    const workflow = opts.workflowName ? `\`${opts.workflowName}\` (${opts.sourceFile})` : opts.sourceFile;
    const path = opts.failure?.entityInstancePath?.filter(part => part.trim() !== '') ?? [];
    const lines = [`The last run of workflow ${workflow} failed. Find the cause and propose a fix.`, ''];
    if (path.length > 0) {
        const node = path[path.length - 1];
        lines.push(
            path.length > 1
                ? `- Where: node \`${node}\`, inside the nested workflows ${path.slice(0, -1).map(p => `\`${p}\``).join(' › ')} (instance path \`${path.join('/')}\`).`
                : `- Where: node \`${node}\`.`
        );
    } else if (opts.failure?.entityInstanceName) {
        lines.push(`- Where: node \`${opts.failure.entityInstanceName}\`.`);
    }
    lines.push(`- Error: ${opts.failure?.message?.trim() || `the run exited with code ${opts.exitCode}`}`);
    if (opts.runDir) {
        lines.push(`- Run directory: ${opts.runDir} (its run record, logs and intermediate files).`);
    }
    const tail = opts.stderrTail.trim();
    if (tail) {
        lines.push('', 'The end of the run\'s error output:', '', '```text', tail, '```');
    }
    lines.push('', 'Explain the cause first, then propose the change, and say which file it goes in.');
    if (opts.canResume) {
        lines.push(
            '',
            `Once the fix is applied, call the \`${RESUME_TOOL}\` tool: it offers the user to resume the run from where it failed, `
                + 'with what ran before replayed rather than run again.'
        );
    }
    const where = failureWhere(opts.failure);
    return {
        name: `Fix: ${where ?? opts.workflowName ?? 'failed run'}`,
        mode: 'plan',
        prompt: lines.join('\n')
    };
}
