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

export interface SidecarOpResult {
    ok: boolean;
    /** The parsed answer, when the sidecar gave one. */
    response?: any;
    /** Why `ok` is false, for a person. */
    message?: string;
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
    /**
     * Run from the file's Python package root with it first on `PYTHONPATH`, so
     * a sidecar that imports the file resolves its intra-package imports. For
     * the requests that import the file (graph export, edits through the chat);
     * the diagram's own edits never asked for it and still do not.
     */
    pythonPackageRoot?: boolean;
}

/** The last non-empty line of `stdout`: a sidecar may log above its answer. */
function lastLine(stdout: string): string | undefined {
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1);
}

/** Send one request to a sidecar and read its answer. Never throws. */
export async function invokeSidecar(request: SidecarRequest): Promise<SidecarOpResult> {
    const { command, op } = request;
    try {
        const packageRoot = request.pythonPackageRoot ? await findPackageRootForFile(request.file) : undefined;
        const result = await runChildProcess(command, [], {
            input: JSON.stringify({ file: request.file, op, args: request.args }) + '\n',
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
            ...(request.pythonPackageRoot
                ? { cwd: packageRoot ?? path.dirname(request.file), env: withPythonPackageRoot(process.env, packageRoot) }
                : {})
        });
        const stderr = result.stderr.trim() || undefined;
        const failure = describeChildFailure(command, result);
        if (failure) {
            return {
                ok: false,
                message: result.timedOut
                    ? `${failure} (while handling ${op})`
                    : result.spawnError
                        ? failure
                        : `Sidecar exited with code ${result.code} while handling ${op}.`,
                stderr,
                timedOut: result.timedOut === true
            };
        }
        const answer = lastLine(result.stdout);
        if (answer === undefined) {
            return { ok: true };
        }
        let response: any;
        try {
            response = JSON.parse(answer);
        } catch {
            return { ok: false, message: `Sidecar returned invalid JSON while handling ${op}.`, stderr };
        }
        if (response?.status === 'ok') {
            return { ok: true, response };
        }
        return {
            ok: false,
            response,
            message: typeof response?.message === 'string' && response.message.trim() !== ''
                ? response.message
                : `Sidecar rejected ${op}.`,
            code: typeof response?.diagnostic?.code === 'string' ? response.diagnostic.code : undefined,
            stderr
        };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : `Unable to start sidecar for ${op}.` };
    }
}
