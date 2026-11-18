/**
 * The one way the toolkit talks to a sidecar: one JSON request on stdin
 * (`{ file, op, args }`), one JSON answer on stdout (`{ status, message?,
 * diagnostic? }`), one process per request. The invoker behind every diagram
 * edit, the chat's edit backend and registry tools, the openability probe,
 * the graph export of the model source and the raw `sidecar.send` command all
 * send through here, so a sidecar that misbehaves is described the same way
 * wherever it was asked from.
 */
import * as path from 'node:path';
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

/**
 * Send one request to a sidecar and read its answer. Never throws. The sidecar
 * runs from the file's Python package root with that root first on
 * `PYTHONPATH`, so a sidecar that imports the file resolves its intra-package
 * imports, whichever path asked.
 */
export async function invokeSidecar(request: SidecarRequest): Promise<SidecarOpResult> {
    const { command, op } = request;
    try {
        const packageRoot = await findPackageRootForFile(request.file);
        const result = await runChildProcess(command, [], {
            input: JSON.stringify({ file: request.file, op, args: request.args }) + '\n',
            cwd: packageRoot ?? path.dirname(request.file),
            env: withPythonPackageRoot(process.env, packageRoot),
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
