import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Which step of a run to resume at: one the stepper shows, or the step before a node's last firing. */
export interface ResumeRequest {
    /** A step of the run's queue trace, as the stepper numbers it (1 is the first; 0 starts over). */
    atStep?: number;
    /** A node: resume at the step before its last firing, so that firing happens again. */
    actor?: string;
}

export type ResumeStep = { step: number } | { error: string };

/**
 * The step a resume of the run in `runDir` starts from.
 *
 * Read from the run's queue trace, the same file the stepper reads, so the
 * numbers agree with what the person sees. A trace whose steps carry no
 * journal position was written by a runtime that cannot replay one, and is
 * refused here rather than by the runtime after a process start.
 */
export async function resumeStepFor(runDir: string, request: ResumeRequest): Promise<ResumeStep> {
    let steps: Array<{ step?: number; actorInstanceName?: string; journalSeq?: number }>;
    try {
        const trace = JSON.parse(await fs.readFile(path.join(runDir, 'run.wf-queues.json'), 'utf-8'));
        steps = Array.isArray(trace?.steps) ? trace.steps : [];
    } catch {
        return { error: `The run in ${runDir} has no queue trace to resume from.` };
    }
    if (steps.length === 0) {
        return { error: `The run in ${runDir} completed no step to resume from.` };
    }
    if (!steps.every(step => typeof step.journalSeq === 'number')) {
        return { error: `The run in ${runDir} was made by a runtime that cannot resume at a step.` };
    }

    if (request.actor !== undefined) {
        // The last step at which it fired; resuming at the step before runs it again.
        for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].actorInstanceName === request.actor) {
                return { step: i };
            }
        }
        return { error: `${request.actor} did not fire in the run in ${runDir}.` };
    }

    const step = request.atStep;
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > steps.length) {
        return { error: `The run in ${runDir} has no step ${String(step)}; its steps are 1 to ${steps.length}.` };
    }
    return { step };
}
