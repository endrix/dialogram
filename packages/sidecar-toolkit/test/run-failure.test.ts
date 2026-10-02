/**
 * A failed run told to the person (one line) and to the agent asked to fix it
 * (the error, where it happened, the traceback, where the run's files are).
 */
import { describe, expect, it } from 'vitest';
import { appendTail, failureHeadline, failureWhere, fixTask } from '../src/run-failure';

const deep = { message: 'ValueError: deep down', entityInstancePath: ['m', 'i', 'x'], entityInstanceName: 'x' };

describe('where a run failed', () => {
    it('names the node and the nested workflows it is in', () => {
        expect(failureWhere(deep)).toBe('x (in m › i)');
        expect(failureWhere({ entityInstancePath: ['x'] })).toBe('x');
        expect(failureWhere({ entityInstanceName: 'y' })).toBe('y');
        expect(failureWhere(undefined)).toBeUndefined();
    });

    it('fits in a notification: where, and the first line of the error', () => {
        expect(failureHeadline(deep, 1)).toBe('Run failed in x (in m › i): ValueError: deep down');
        expect(failureHeadline(undefined, 3)).toBe('Run failed: exit code 3');
        expect(failureHeadline({ message: 'x'.repeat(400) }, 1).length).toBeLessThan(200);
    });
});

describe('the end of the run’s error output', () => {
    it('keeps the end, where the traceback is', () => {
        expect(appendTail('abc', 'def', 4)).toBe('cdef');
        expect(appendTail('', 'Traceback', 100)).toBe('Traceback');
    });
});

describe('the task the chat is asked to start', () => {
    const task = fixTask({
        workflowName: 'top',
        sourceFile: '/w/top.py',
        failure: deep,
        exitCode: 1,
        stderrTail: 'Traceback (most recent call last):\n  ...\nValueError: deep down\n',
        runDir: '/w/wf-out/r1',
        canResume: true
    });

    it('is a plan-mode session named for where it failed', () => {
        expect(task.mode).toBe('plan');
        expect(task.name).toBe('Fix: x (in m › i)');
    });

    it('gives the agent what it needs to find the cause', () => {
        expect(task.prompt).toContain('workflow `top` (/w/top.py) failed');
        expect(task.prompt).toContain('node `x`, inside the nested workflows `m` › `i` (instance path `m/i/x`)');
        expect(task.prompt).toContain('- Error: ValueError: deep down');
        expect(task.prompt).toContain('/w/wf-out/r1');
        expect(task.prompt).toContain('```text\nTraceback (most recent call last):');
        expect(task.prompt).toContain('Once the fix is applied, call the `resume_failed_run` tool');
        expect(task.prompt).toContain('resume the run from where it failed');
    });

    it('says nothing of resuming when the run cannot be resumed', () => {
        const plain = fixTask({ sourceFile: '/w/top.py', failure: undefined, exitCode: 2, stderrTail: '', canResume: false });
        expect(plain.prompt).toContain('- Error: the run exited with code 2');
        expect(plain.prompt).not.toContain('resume_failed_run');
        expect(plain.prompt).not.toContain('```text');
    });
});
