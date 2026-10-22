/**
 * Graph export through the CLI's plan command, for a profile with no sidecar.
 *
 * A read-only profile (`SidecarProfileInput.readOnly`) draws its diagram from
 * the document the CLI plan emits, and the chat's `get_graph` and context need
 * that same graph. This runs the plan the way the model source does (the same
 * argv builder, the same `--workflow` scoping, the same deadline) and answers
 * in the envelope the sidecar export would have used, `{ status: 'ok',
 * diagnostic: { graph, partial, errors } }`, so the chat tools and the
 * source-reference context read it unchanged whichever transport fed them.
 */

import type { SidecarOpResult } from './sidecar-graph-export.js';
import { describeChildFailure, runChildProcess } from './run-child-process.js';

export interface CliGraphExportOptions {
    /** The CLI command and the arguments that precede the plan's own (`-m <module>`, say). */
    cmd: string;
    argsPrefix: string[];
    /** The plan argv for a file, as the profile declares it (`cliGraphArgs`). */
    cliGraphArgs: (file: string, requestedWorkflow?: string) => string[];
    /** The unit within the file to export; the plan's default when absent. */
    networkName?: string;
    /** Deadline for the plan, in ms; the child-process default when absent. */
    timeoutMs?: number;
}

/**
 * Export the graph of `filePath` by running the CLI plan. Never throws: a
 * command that fails, times out or prints something other than a graph
 * document answers `{ ok: false, message }`.
 */
export async function exportGraphFromCli(filePath: string, options: CliGraphExportOptions): Promise<SidecarOpResult> {
    const networkName = options.networkName && options.networkName.trim() !== '' ? options.networkName.trim() : undefined;
    const args = [...options.argsPrefix, ...options.cliGraphArgs(filePath, networkName)];
    if (networkName) {
        args.push('--workflow', networkName);
    }
    try {
        const result = await runChildProcess(options.cmd, args, { timeoutMs: options.timeoutMs });
        const failure = describeChildFailure(options.cmd, result);
        if (failure) {
            return {
                ok: false,
                message: result.spawnError || result.timedOut
                    ? failure
                    : result.stderr.trim() || `${options.cmd} exited with ${result.code}`
            };
        }
        const parsed = JSON.parse(result.stdout) as { graph?: unknown; partial?: unknown; errors?: unknown };
        if (!parsed || typeof parsed !== 'object' || !parsed.graph || typeof parsed.graph !== 'object') {
            return { ok: false, message: `${options.cmd}: the plan document has no graph` };
        }
        return {
            ok: true,
            response: {
                status: 'ok',
                diagnostic: {
                    graph: parsed.graph,
                    ...(parsed.partial === true ? { partial: true } : {}),
                    ...(Array.isArray(parsed.errors) && parsed.errors.length > 0 ? { errors: parsed.errors } : {})
                }
            }
        };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
