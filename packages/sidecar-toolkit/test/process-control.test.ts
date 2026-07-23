import type * as cp from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    requestWorkflowStop,
    spawnWorkflowProcess,
    WORKFLOW_STOP_GRACE_PERIOD_MS,
    type ManagedWorkflowRun,
    type WorkflowOutputLike
} from '../src/process-control';

describe('workflow process control', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('spawns workflow runs in a dedicated process group on posix', () => {
        const spawnProcess = vi.fn(() => ({}) as cp.ChildProcessWithoutNullStreams);

        spawnWorkflowProcess(
            {
                cmd: 'wfpy',
                args: ['run', '/tmp/example.py'],
                cwd: '/tmp'
            },
            spawnProcess
        );

        expect(spawnProcess).toHaveBeenCalledWith(
            'wfpy',
            ['run', '/tmp/example.py'],
            expect.objectContaining({
                cwd: '/tmp',
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true
            })
        );
    });

    it('spawns workflow runs without detached mode on Windows', () => {
        const spawnProcess = vi.fn(() => ({}) as cp.ChildProcessWithoutNullStreams);

        spawnWorkflowProcess(
            {
                cmd: 'wfpy',
                args: ['run', 'workflow.py'],
                cwd: 'C:/tmp'
            },
            spawnProcess,
            'win32'
        );

        expect(spawnProcess).toHaveBeenCalledWith(
            'wfpy',
            ['run', 'workflow.py'],
            expect.objectContaining({
                detached: false
            })
        );
    });

    it('signals the full process group when stopping a workflow run', () => {
        vi.useFakeTimers();

        const kill = vi.fn(() => true);
        const child = {
            pid: 4242,
            killed: false,
            kill
        } as unknown as cp.ChildProcessWithoutNullStreams;
        const output: WorkflowOutputLike = {
            appendLine: vi.fn()
        };
        const activeRun: ManagedWorkflowRun = {
            child,
            output,
            stopRequested: false
        };
        const killProcess = vi.spyOn(process, 'kill').mockImplementation(() => true);

        requestWorkflowStop(activeRun, () => true, setTimeout, 'darwin', killProcess);

        expect(activeRun.stopRequested).toBe(true);
        expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM');
        expect(kill).not.toHaveBeenCalled();

        vi.advanceTimersByTime(WORKFLOW_STOP_GRACE_PERIOD_MS);

        expect(killProcess).toHaveBeenLastCalledWith(-4242, 'SIGKILL');
    });

    it('falls back to direct child termination when process-group signaling fails', () => {
        vi.useFakeTimers();

        const kill = vi.fn(() => true);
        const child = {
            pid: 777,
            killed: false,
            kill
        } as unknown as cp.ChildProcessWithoutNullStreams;
        const activeRun: ManagedWorkflowRun = {
            child,
            output: {
                appendLine: vi.fn()
            },
            stopRequested: false
        };
        const killProcess = vi.fn(() => {
            throw new Error('group kill unavailable');
        });

        requestWorkflowStop(activeRun, () => true, setTimeout, 'darwin', killProcess);

        expect(kill).toHaveBeenCalledWith('SIGTERM');

        vi.advanceTimersByTime(WORKFLOW_STOP_GRACE_PERIOD_MS);

        expect(kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('skips escalation once the workflow is no longer active', () => {
        vi.useFakeTimers();

        const kill = vi.fn(() => true);
        const child = {
            pid: 313,
            killed: false,
            kill
        } as unknown as cp.ChildProcessWithoutNullStreams;
        const output: WorkflowOutputLike = {
            appendLine: vi.fn()
        };
        const activeRun: ManagedWorkflowRun = {
            child,
            output,
            stopRequested: false
        };
        const killProcess = vi.spyOn(process, 'kill').mockImplementation(() => true);

        requestWorkflowStop(activeRun, () => false, setTimeout, 'darwin', killProcess);

        vi.advanceTimersByTime(WORKFLOW_STOP_GRACE_PERIOD_MS);

        expect(killProcess).toHaveBeenCalledTimes(1);
        expect(output.appendLine).not.toHaveBeenCalledWith('[wf-lang] Process still running after SIGTERM. Sending SIGKILL...');
    });
});