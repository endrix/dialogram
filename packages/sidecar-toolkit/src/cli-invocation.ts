/**
 * The CLI as a run of a source file starts it, and `runCli`, which a product's
 * host code is handed on its profile to run that CLI itself. The rules stay
 * the toolkit's own: the run driver starts a run by them, and only `runCli`
 * is handed out.
 */
import * as vscode from 'vscode';
import {
    cliProcessEnv,
    getCliInvocation,
    getCliVariables,
    getGraphLoadTimeoutMs,
    type CliCommandConfig,
    type SidecarRuntimeConfig
} from './server/sidecar-runtime-config';
import { resolveRunRoot } from './run-root';
import { describeChildFailure, runChildProcess } from './run-child-process.js';

/**
 * The CLI as a run of `forUri` starts it: the one rule for the command
 * (`getCliInvocation`: the setting under the product's namespace scoped to
 * the file, its default when blank, `-m <module>` when the command is a
 * Python interpreter), the module form for a Python source only, from the
 * run root (`resolveRunRoot`), with the variables the product's settings give
 * it there (`getCliVariables`, present when one does; `leftOut` is told of an
 * entry left out). Undefined when the setting and the profile's default are
 * both blank, found before the run root is looked for.
 */
export async function resolveCliInvocation(
    config: CliCommandConfig,
    forUri: vscode.Uri,
    isPython: boolean = forUri.fsPath.endsWith('.py'),
    leftOut?: (message: string) => void
): Promise<{ cmd: string; argsPrefix: string[]; cwd: string; variables?: Record<string, string> } | undefined> {
    const { cmd, argsPrefix } = getCliInvocation(config, vscode, forUri);
    if (cmd.trim() === '') {
        return undefined;
    }
    const cwd = await resolveRunRoot(forUri);
    const variables = getCliVariables(config, vscode, forUri, cwd, leftOut);
    return { cmd, argsPrefix: isPython ? argsPrefix : [], cwd, ...(Object.keys(variables).length > 0 ? { variables } : {}) };
}

/** What a run says when it has no command to start. */
export function noCliCommandMessage(config: CliCommandConfig): string {
    return `Cannot run: ${config.settingsNamespace}.${config.cliCommandSettingKey} names no command, and this extension has no default for it.`;
}

/**
 * How one `runCli` went. `exitCode` is the CLI's own, and an exit other than
 * 0 is its answer, not a `failure`: `failure` says the CLI did not run to its
 * end, because no command is set (`no-command`), it could not be started
 * (`start`: not installed, not executable), the deadline stopped it
 * (`timeout`), or the toolkit failed before starting it, reading a setting
 * for instance (`internal`).
 */
export interface CliRunResult {
    /** The CLI's exit code; `-1` when it did not run to its end. */
    exitCode: number;
    stdout: string;
    stderr: string;
    failure?: 'no-command' | 'start' | 'timeout' | 'internal';
    /** Why, for a person, when `failure` is set. */
    message?: string;
    /**
     * The directory the command was started in, the run root: what a run of
     * the file would take as its working directory. Absent when no command
     * was started.
     */
    cwd?: string;
    /**
     * The variables the product's settings gave the CLI (`cliEnvironment`),
     * over this extension's environment, as a run of the file is given them.
     * Absent when none was, or no command was started.
     */
    variables?: Record<string, string>;
}

/**
 * Run the profile's CLI for `file` with `args`, started exactly as a run of
 * the file starts it (`resolveCliInvocation`: the command, the module form
 * for an interpreter, the run root as the working directory, this
 * extension's environment with the variables the product's settings give
 * the CLI), with stdin closed, its output read as UTF-8.
 * The deadline is `options.timeoutMs` when that is a positive number, else
 * the profile's graph-load deadline for the file, and at most
 * `MAX_CHILD_TIMEOUT_MS` (about 24.8 days). At the deadline the CLI is
 * stopped: on POSIX it leads its own process group, and the whole group is
 * stopped, what it started included; on Windows only the CLI itself is.
 * Never throws.
 */
export async function runCli(
    config: SidecarRuntimeConfig,
    file: vscode.Uri,
    args: readonly string[],
    options: { timeoutMs?: number } | undefined = {}
): Promise<CliRunResult> {
    try {
        const cli = await resolveCliInvocation(config, file);
        if (!cli) {
            return { exitCode: -1, stdout: '', stderr: '', failure: 'no-command', message: noCliCommandMessage(config) };
        }
        const given = options?.timeoutMs;
        // As for the graph-load setting: zero, negative or not a number means
        // nobody's deadline, so the default applies.
        const timeoutMs = typeof given === 'number' && Number.isFinite(given) && given > 0
            ? given
            : getGraphLoadTimeoutMs(config, vscode, file);
        const result = await runChildProcess(cli.cmd, [...cli.argsPrefix, ...args], {
            cwd: cli.cwd,
            timeoutMs,
            env: cliProcessEnv(cli.variables)
        });
        const failure = result.spawnError ? 'start' : result.timedOut ? 'timeout' : undefined;
        return {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(failure ? { failure, message: describeChildFailure(cli.cmd, result) } : {}),
            cwd: cli.cwd,
            ...(cli.variables ? { variables: cli.variables } : {})
        };
    } catch (error) {
        // `runChildProcess` never rejects: this is the toolkit's own failure
        // before anything was started, not a command missing from the machine.
        return {
            exitCode: -1,
            stdout: '',
            stderr: '',
            failure: 'internal',
            message: `Could not work out how to start the CLI: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
