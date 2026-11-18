/**
 * The one way the toolkit talks to a sidecar: one JSON request on stdin
 * (`{ file, op, args }`), one JSON answer on stdout (`{ status, message?,
 * diagnostic? }`), one process per request. The invoker behind every diagram
 * edit, the chat's edit backend and registry tools, the openability probe,
 * the graph export of the model source and the raw `sidecar.send` command all
 * send through here, so a sidecar that misbehaves is described the same way
 * wherever it was asked from. A product that asks a slow-starting sidecar
 * several things at once sends them to one process (`invokeSidecarBatch`).
 */
import * as path from 'node:path';
import type { ToolQueryResult } from '@dialogram/shared';
import { describeChildFailure, runChildProcess } from './run-child-process.js';
import { findPackageRootForFile, withPythonPackageRoot } from './server/source-files.js';

/** The graph-export op every sidecar answers to (contract v2), when the product names no other. */
export const DEFAULT_EXPORT_OP = 'exportGraph';

/** How a request failed: the process, or the answer. */
export type SidecarFailure = 'start' | 'timeout' | 'exit' | 'rejected' | 'invalid-json';

export interface SidecarOpResult {
    ok: boolean;
    /** The parsed answer, when the sidecar gave one. */
    response?: any;
    /** Why `ok` is false, for a person. A process failure starts with the command and carries its stderr. */
    message?: string;
    /** How it failed, when it did. */
    failure?: SidecarFailure;
    /** The sidecar's `diagnostic.code`, when it rejected the request with one. */
    code?: string;
    /** What the sidecar wrote to stderr, when it failed. */
    stderr?: string;
    /** The request hit its deadline. */
    timedOut?: boolean;
}

export interface SidecarRequest {
    /** The sidecar executable, as the setting resolved it. */
    command: string;
    /** The source file the request is about, absolute. */
    file: string;
    /** The fully qualified op, `<prefix>.<name>`. */
    op: string;
    args: Record<string, unknown>;
    /** The deadline; the child-process default when absent. */
    timeoutMs?: number;
}

/**
 * The answer in `stdout`: the whole of it when it is one JSON document (a
 * sidecar may pretty-print), else its last non-empty line (a sidecar may log
 * above its answer); `undefined` for no output, `null` for output that is
 * neither.
 */
function parseAnswer(stdout: string): unknown {
    const whole = stdout.trim();
    if (whole === '') {
        return undefined;
    }
    try {
        return JSON.parse(whole);
    } catch {
        // fall through to the last line
    }
    const last = whole.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1) ?? '';
    try {
        return JSON.parse(last);
    } catch {
        return null;
    }
}

/** Where and with what environment a sidecar is started for `file`: its Python package root, first on `PYTHONPATH`. */
async function sidecarStartFor(file: string): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
    const packageRoot = await findPackageRootForFile(file);
    return { cwd: packageRoot ?? path.dirname(file), env: withPythonPackageRoot(process.env, packageRoot) };
}

/**
 * Send one request to a sidecar and read its answer. Never throws. The sidecar
 * runs from the file's Python package root with that root first on
 * `PYTHONPATH`, so a sidecar that imports the file resolves its intra-package
 * imports, whichever path asked.
 */
export async function invokeSidecar(request: SidecarRequest): Promise<SidecarOpResult> {
    const { command, op } = request;
    try {
        const start = await sidecarStartFor(request.file);
        const result = await runChildProcess(command, [], {
            input: JSON.stringify({ file: request.file, op, args: request.args }) + '\n',
            ...start,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
        });
        const stderr = result.stderr.trim() || undefined;
        const failure = describeChildFailure(command, result);
        if (failure) {
            // `describeChildFailure` names the command and, for an exit, carries stderr.
            return {
                ok: false,
                failure: result.spawnError ? 'start' : result.timedOut ? 'timeout' : 'exit',
                message: `${failure} (while handling ${op})`,
                stderr,
                timedOut: result.timedOut === true
            };
        }
        const response: any = parseAnswer(result.stdout);
        if (response === undefined) {
            return { ok: true };
        }
        if (response === null) {
            return { ok: false, failure: 'invalid-json', message: `Sidecar returned invalid JSON while handling ${op}.`, stderr };
        }
        if (response?.status === 'ok') {
            return { ok: true, response };
        }
        return {
            ok: false,
            failure: 'rejected',
            response,
            message: typeof response?.message === 'string' && response.message.trim() !== ''
                ? response.message
                : `Sidecar rejected ${op}.`,
            code: typeof response?.diagnostic?.code === 'string' ? response.diagnostic.code : undefined,
            stderr
        };
    } catch (error) {
        return { ok: false, failure: 'start', message: error instanceof Error ? error.message : `Unable to start sidecar for ${op}.` };
    }
}

export interface SidecarBatchRequest {
    /** The sidecar executable, as the setting resolved it. */
    command: string;
    /** The source file the requests are about, absolute. */
    file: string;
    /** In the order they are written; each op fully qualified, `<prefix>.<name>`. */
    requests: ReadonlyArray<{ op: string; args?: Record<string, unknown> }>;
    /** The deadline for the whole process; the child-process default when absent. */
    timeoutMs?: number;
}

/**
 * The answers in `stdout`, in order: each line that is a JSON object with a
 * string `status`. Anything else a sidecar writes (a log line) is passed over.
 */
function answerLines(stdout: string): unknown[] {
    const answers: unknown[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith('{')) {
            continue;
        }
        try {
            const answer = JSON.parse(text);
            if (answer && typeof answer === 'object' && !Array.isArray(answer) && typeof answer.status === 'string') {
                answers.push(answer);
            }
        } catch {
            // not an answer
        }
    }
    return answers;
}

/**
 * Send several requests to one start of a sidecar, one JSON line each, and
 * read every answer: one process instead of one per request, for a sidecar
 * slow to start that is asked several things at once. Started as
 * {@link invokeSidecar} starts it. An answer with `status: 'error'` is in
 * `answers` like any other; `failure` says only how the process ended, and
 * the answers it gave before a failure are kept. Never throws.
 */
export async function invokeSidecarBatch(request: SidecarBatchRequest): Promise<ToolQueryResult> {
    const { command, file } = request;
    const fallbackCwd = path.dirname(file);
    try {
        const start = await sidecarStartFor(file);
        const input = request.requests
            .map(({ op, args }) => JSON.stringify({ file, op, args: args ?? {} }) + '\n')
            .join('');
        const result = await runChildProcess(command, [], {
            input,
            ...start,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
        });
        const stderr = result.stderr.trim() || undefined;
        const failure = describeChildFailure(command, result);
        const ended = result.spawnError ? 'start' : result.timedOut ? 'timeout' : failure ? 'exit' : undefined;
        return {
            command,
            cwd: start.cwd,
            answers: answerLines(result.stdout),
            exitCode: result.spawnError || result.timedOut ? null : result.code,
            ...(ended ? { failure: ended, message: failure } : {}),
            ...(stderr ? { stderr } : {})
        };
    } catch (error) {
        return {
            command,
            cwd: fallbackCwd,
            answers: [],
            exitCode: null,
            failure: 'start',
            message: error instanceof Error ? error.message : `Unable to start ${command}.`
        };
    }
}
