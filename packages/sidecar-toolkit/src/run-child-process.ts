/**
 * Run a child process and ALWAYS settle.
 *
 * Every child this toolkit starts is awaited by something a user is looking at —
 * a diagram that says "Model loading in progress", an edit that has not applied
 * yet. A promise that never settles turns into a notification that never leaves
 * and a diagram that never opens, with no cancel button and no way out short of
 * closing the tab. So the contract here is total: spawn failure, non-zero exit,
 * a child that never exits — each of them resolves, and each of them says which
 * one it was.
 *
 * Three ways a child fails to settle, all covered here rather than at six call
 * sites that each remembered a different subset:
 *
 *  - It cannot start (ENOENT — command not installed, or a typo'd setting).
 *    Node reports that as an `error` EVENT, not a throw; with no listener it
 *    becomes an uncaught exception in the extension host AND the exit promise
 *    stays pending forever.
 *  - It starts and never exits. A language runtime imports the user's module to
 *    describe it, so anything the module does at import time — `input()`, a
 *    sleep, a socket, a lock — hangs the child, and nothing here can tell that
 *    apart from slow work except by giving it a deadline.
 *  - It exits but leaves a grandchild holding the pipes, so `close` never comes.
 *    The child leads its own process group, so the deadline signals the whole
 *    tree; `exit` also settles after a short grace period even if `close` never
 *    arrives.
 */
import type { ChildProcess } from 'node:child_process';

/**
 * Default deadline for a one-shot child.
 *
 * Long enough that ordinary work is never cut short (these commands import user
 * code, which can be slow the first time), short enough that a wedged child
 * surfaces as an error a reader can act on instead of a spinner they wait out.
 * Callers with a different budget pass their own.
 */
export const DEFAULT_CHILD_TIMEOUT_MS = 60_000;

/** Grace after SIGTERM before the group is signalled again with SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

/** Grace after `exit` for `close` to arrive, before settling without it. */
const CLOSE_GRACE_MS = 250;

export interface RunChildProcessOptions {
    /** Written to stdin, which is then closed. Omit to run with stdin closed. */
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Deadline in ms; defaults to {@link DEFAULT_CHILD_TIMEOUT_MS}. */
    timeoutMs?: number;
}

export interface ChildProcessResult {
    /** Exit code; `-1` when the process could not be started or was killed on the deadline. */
    code: number;
    stdout: string;
    stderr: string;
    /** Set when the process could not be started at all. */
    spawnError?: Error;
    /** Set when OUR deadline killed it — a self-inflicted death, not the command's own failure. */
    timedOut: boolean;
    /** The deadline that applied, so a message can quote it. */
    timeoutMs: number;
}

/**
 * Spawn `command` with `args` and resolve with its output and how it ended.
 *
 * Never rejects: a caller awaiting this cannot be left hanging by an error path
 * it forgot to handle.
 */
export async function runChildProcess(
    command: string,
    args: string[],
    options: RunChildProcessOptions = {}
): Promise<ChildProcessResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
    const { spawn } = await import('node:child_process');

    return new Promise<ChildProcessResult>(resolve => {
        // Own process group so the deadline reaches whatever the command forked.
        // Killing only the direct child leaves a grandchild alive holding the
        // pipes we are waiting on. Windows has no process groups to speak of and
        // `detached` there only detaches the console, so it stays off.
        const ownGroup = process.platform !== 'win32';

        let child: ChildProcess;
        try {
            child = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: options.cwd,
                env: options.env,
                detached: ownGroup
            });
        } catch (error) {
            // Resolve directly: the timers below do not exist yet to be cleared.
            resolve({
                code: -1,
                stdout: '',
                stderr: '',
                spawnError: error instanceof Error ? error : new Error(String(error)),
                timedOut: false,
                timeoutMs
            });
            return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let graceTimer: NodeJS.Timeout | undefined;

        const settle = (result: ChildProcessResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(sigtermTimer);
            clearTimeout(sigkillTimer);
            clearTimeout(graceTimer);
            // Release our ends of the pipes: a surviving grandchild must not keep
            // this process's event loop or its file descriptors alive.
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(result);
        };

        /** Signal the group when we have one, else the child; never throw. */
        const killTree = (signal: NodeJS.Signals): void => {
            const pid = child.pid;
            try {
                if (ownGroup && pid !== undefined) {
                    process.kill(-pid, signal);
                    return;
                }
            } catch {
                // The group is already gone, or we never got one — fall through.
            }
            try {
                child.kill(signal);
            } catch {
                // Already reaped; nothing left to signal.
            }
        };

        const sigtermTimer = setTimeout(() => {
            timedOut = true;
            killTree('SIGTERM');
        }, timeoutMs);
        const sigkillTimer = setTimeout(() => {
            killTree('SIGKILL');
            // An unkillable tree may still hold the pipes; settle regardless.
            child.stdout?.destroy();
            child.stderr?.destroy();
        }, timeoutMs + SIGKILL_GRACE_MS);
        // Neither timer should keep the host process alive on its own.
        sigtermTimer.unref?.();
        sigkillTimer.unref?.();

        const finish = (code: number | null): void =>
            settle({
                // A killed child reports a null code; call that -1 like a failed spawn,
                // and let `timedOut` say which it was.
                code: timedOut ? -1 : code ?? 1,
                stdout,
                stderr,
                timedOut,
                timeoutMs
            });

        child.stdout?.on('data', chunk => (stdout += String(chunk)));
        child.stderr?.on('data', chunk => (stderr += String(chunk)));

        child.on('error', error => {
            settle({ code: -1, stdout, stderr, spawnError: error, timedOut, timeoutMs });
        });
        // Prefer `close` (pipes drained) but never wait for it forever.
        child.on('exit', code => {
            graceTimer = setTimeout(() => finish(code), CLOSE_GRACE_MS);
            graceTimer.unref?.();
        });
        child.on('close', code => finish(code));

        if (options.input !== undefined) {
            // A process that never started still has a stdin stream, and writing
            // to it raises EPIPE asynchronously; the `error` event above already
            // carries the real reason, so this listener only stops the EPIPE from
            // becoming an uncaught exception.
            child.stdin?.on('error', () => undefined);
            child.stdin?.write(options.input);
        }
        child.stdin?.end();
    });
}

/**
 * How a run ended, in one sentence, for a message shown to the user.
 *
 * A deadline miss reads nothing like a crash and must not be reported as one:
 * the command did not fail, it did not answer, and the thing to do about it is
 * different. Returns `undefined` when the run succeeded.
 */
export function describeChildFailure(command: string, result: ChildProcessResult): string | undefined {
    if (result.spawnError) {
        return `${command}: failed to start: ${result.spawnError.message}`;
    }
    if (result.timedOut) {
        return `${command}: no response after ${Math.round(result.timeoutMs / 1000)}s (the process was stopped). ` +
            'A command that never answers is usually blocked at import time — check for code that runs on import.';
    }
    if (result.code !== 0) {
        const detail = result.stderr.trim();
        return `${command}: ${detail !== '' ? detail : `exited with ${result.code}`}`;
    }
    return undefined;
}
