/**
 * The one property that matters: it always settles.
 *
 * Every case here is a way a child process used to leave a promise pending —
 * and a pending promise is the "Model loading in progress" notification that
 * never goes away, since that notification lives exactly as long as the load.
 *
 * Real processes, not mocks: what is being tested is Node's event behaviour
 * (`error` vs `exit` vs `close`, signals, process groups), which a fake would
 * only restate.
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CHILD_TIMEOUT_MS,
    describeChildFailure,
    runChildProcess
} from '../src/run-child-process';

/** Run a snippet of JS in a real child, so the process behaviour is the real one. */
function node(script: string, timeoutMs?: number, input?: string) {
    return runChildProcess(process.execPath, ['-e', script], { timeoutMs, input });
}

describe('runChildProcess', () => {
    it('returns what the command wrote and how it exited', async () => {
        const result = await node('process.stdout.write("out"); console.error("err");');

        expect(result.code).toBe(0);
        expect(result.stdout).toBe('out');
        expect(result.stderr.trim()).toBe('err');
        expect(result.timedOut).toBe(false);
    });

    it('delivers stdin and closes it, so a reader can finish', async () => {
        // The language runtimes read one request line and exit on EOF; a stdin
        // left open would hang them on every call.
        const script = 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(s.trim().toUpperCase()));';
        const result = await node(script, undefined, 'hello\n');

        expect(result.stdout).toBe('HELLO');
    });

    it('resolves when the command cannot be started at all', async () => {
        // ENOENT arrives as an EVENT, not a throw: unlistened it is both an
        // uncaught exception in the host and a promise that never settles.
        const result = await runChildProcess('definitely-not-a-real-command-9f3a', []);

        expect(result.spawnError).toBeDefined();
        expect(result.code).toBe(-1);
        expect(result.timedOut).toBe(false);
    });

    it('kills a process that never exits, and says the deadline did it', async () => {
        const result = await node('setInterval(() => {}, 1000);', 300);

        expect(result.timedOut).toBe(true);
        expect(result.code).toBe(-1);
        expect(result.timeoutMs).toBe(300);
    });

    it('does not blame the deadline for a command that failed on its own', async () => {
        const result = await node('process.exit(3);', 5_000);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(3);
    });

    it('settles even when a grandchild outlives the command and holds the pipes', async () => {
        // The exact shape that makes `close` never fire: the parent exits, but a
        // forked child inherited the pipes and keeps them open.
        const script =
            'const {spawn} = require("node:child_process");' +
            'spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], {stdio: "inherit"});' +
            'process.exit(0);';
        const result = await node(script, 5_000);

        expect(result.code).toBe(0);
        expect(result.timedOut).toBe(false);
    }, 10_000);

    it('has a default deadline, so a caller that forgets one is still bounded', () => {
        expect(DEFAULT_CHILD_TIMEOUT_MS).toBeGreaterThan(0);
    });
});

describe('describeChildFailure', () => {
    const base = { stdout: '', stderr: '', timedOut: false, timeoutMs: 60_000 };

    it('says nothing when the run succeeded', () => {
        expect(describeChildFailure('cmd', { ...base, code: 0 })).toBeUndefined();
    });

    it('reports a timeout as no answer rather than as a crash', () => {
        const message = describeChildFailure('cmd', { ...base, code: -1, timedOut: true, timeoutMs: 30_000 });

        // The seconds are quoted so the reader can tell a deadline from a hang,
        // and the cause named so they know where to look.
        expect(message).toContain('30s');
        expect(message).toContain('import');
        expect(message).not.toContain('exited with');
    });

    it('quotes stderr when the command failed on its own', () => {
        const message = describeChildFailure('cmd', { ...base, code: 2, stderr: 'boom\n' });

        expect(message).toContain('boom');
    });

    it('falls back to the exit code when the command said nothing', () => {
        expect(describeChildFailure('cmd', { ...base, code: 2 })).toContain('exited with 2');
    });

    it('reports an unstartable command as such', () => {
        const message = describeChildFailure('cmd', { ...base, code: -1, spawnError: new Error('ENOENT') });

        expect(message).toContain('failed to start');
    });
});
