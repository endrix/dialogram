import * as cp from 'node:child_process';

export const WORKFLOW_STOP_GRACE_PERIOD_MS = 1500;

export type WorkflowCliInvocation = {
    cmd: string;
    args: string[];
    cwd: string;
};

export interface WorkflowProcessLike {
    pid?: number;
    killed: boolean;
    kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WorkflowOutputLike {
    appendLine(value: string): void;
}

export interface ManagedWorkflowRun {
    child: WorkflowProcessLike;
    output: WorkflowOutputLike;
    stopRequested: boolean;
}

export type SpawnWorkflowProcess = typeof cp.spawn;
export type KillWorkflowProcess = typeof process.kill;

function canSignalWorkflowProcessGroup(child: WorkflowProcessLike, platform: NodeJS.Platform): child is WorkflowProcessLike & { pid: number } {
    return platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0;
}

export function signalWorkflowProcess(
    child: WorkflowProcessLike,
    signal: NodeJS.Signals | number,
    platform: NodeJS.Platform = process.platform,
    killProcess: KillWorkflowProcess = process.kill
): boolean {
    if (canSignalWorkflowProcessGroup(child, platform)) {
        try {
            killProcess(-child.pid, signal);
            return true;
        } catch {
            // Fall through to direct child termination if group signaling is unavailable.
        }
    }

    try {
        return child.kill(signal);
    } catch {
        return false;
    }
}

export function spawnWorkflowProcess(
    invocation: WorkflowCliInvocation,
    spawnProcess: SpawnWorkflowProcess = cp.spawn,
    platform: NodeJS.Platform = process.platform
): cp.ChildProcessWithoutNullStreams {
    return spawnProcess(invocation.cmd, invocation.args, {
        cwd: invocation.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32'
    }) as cp.ChildProcessWithoutNullStreams;
}

export function requestWorkflowStop(
    activeRun: ManagedWorkflowRun,
    getIsStillActive: () => boolean,
    schedule: typeof setTimeout = setTimeout,
    platform: NodeJS.Platform = process.platform,
    killProcess: KillWorkflowProcess = process.kill
): boolean {
    activeRun.stopRequested = true;
    activeRun.output.appendLine('[wf-lang] Stop requested. Sending SIGTERM...');

    const signalSent = signalWorkflowProcess(activeRun.child, 'SIGTERM', platform, killProcess);

    if (!signalSent) {
        activeRun.output.appendLine('[wf-lang] Could not send SIGTERM (process may have already exited).');
        return false;
    }

    schedule(() => {
        if (getIsStillActive()) {
            activeRun.output.appendLine('[wf-lang] Process still running after SIGTERM. Sending SIGKILL...');
            signalWorkflowProcess(activeRun.child, 'SIGKILL', platform, killProcess);
        }
    }, WORKFLOW_STOP_GRACE_PERIOD_MS);

    return true;
}