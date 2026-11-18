/**
 * Where a run of a source file starts, and with which command: the run
 * driver's rules, kept here so that `runCli`, which a product's host code is
 * handed on its profile, starts the CLI exactly as a run does. The rules
 * stay the toolkit's own; only `runCli` is handed out.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    getCliInvocation,
    getGraphLoadTimeoutMs,
    type CliCommandConfig,
    type SidecarRuntimeConfig
} from './server/sidecar-runtime-config';
import { fileExists } from './server/source-files';
import { describeChildFailure, runChildProcess } from './run-child-process.js';

/**
 * The directory a run of `forUri` starts in: from the file's workspace folder
 * (the first one when it is in none, the file's own directory without any),
 * the nearest directory holding a `package.json` or a `.git`; that folder when
 * none does.
 */
export async function resolveRunRoot(forUri: vscode.Uri): Promise<string> {
    const wsFolder = vscode.workspace.getWorkspaceFolder(forUri) ?? vscode.workspace.workspaceFolders?.[0];
    const base = wsFolder ? wsFolder.uri.fsPath : path.dirname(forUri.fsPath);
    return (await findProjectRoot(base)) ?? base;
}

async function findProjectRoot(startDir: string): Promise<string | undefined> {
    let current = startDir;
    for (;;) {
        const pkg = path.resolve(current, 'package.json');
        const gitDir = path.resolve(current, '.git');
        if (await fileExists(pkg) || await fileExists(gitDir)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}

/**
 * The CLI as a run of `forUri` starts it: the one rule for the command
 * (`getCliInvocation`: the setting under the product's namespace scoped to
 * the file, its default when blank, `-m <module>` when the command is a
 * Python interpreter), the module form for a Python source only, from the
 * run root. Undefined when the setting and the profile's default are both
 * blank, found before the run root is looked for.
 */
export async function resolveCliInvocation(
    config: CliCommandConfig,
    forUri: vscode.Uri,
    isPython: boolean = forUri.fsPath.endsWith('.py')
): Promise<{ cmd: string; argsPrefix: string[]; cwd: string } | undefined> {
    const { cmd, argsPrefix } = getCliInvocation(config, vscode, forUri);
    if (cmd.trim() === '') {
        return undefined;
    }
    return { cmd, argsPrefix: isPython ? argsPrefix : [], cwd: await resolveRunRoot(forUri) };
}

/** What a run says when it has no command to start. */
export function noCliCommandMessage(config: CliCommandConfig): string {
    return `Cannot run: ${config.settingsNamespace}.${config.cliCommandSettingKey} names no command, and this extension has no default for it.`;
}

/**
 * How one `runCli` went. `exitCode` is the CLI's own, and an exit other than
 * 0 is its answer, not a `failure`: `failure` says the CLI did not run to its
 * end, because no command is set (`no-command`), it could not be started
 * (`start`), or the deadline stopped it and all it started (`timeout`).
 */
export interface CliRunResult {
    /** The CLI's exit code; `-1` when it did not run to its end. */
    exitCode: number;
    stdout: string;
    stderr: string;
    failure?: 'no-command' | 'start' | 'timeout';
    /** Why, for a person, when `failure` is set. */
    message?: string;
}

/**
 * Run the profile's CLI for `file` with `args`, started exactly as a run of
 * the file starts it (`resolveCliInvocation`: the command, the module form
 * for an interpreter, the run root as the working directory, this
 * extension's environment), with stdin closed. It leads its own process
 * group, and at the deadline the whole group is stopped. The deadline is
 * `options.timeoutMs` when that is a positive number, else the profile's
 * graph-load deadline for the file. Never throws.
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
        const result = await runChildProcess(cli.cmd, [...cli.argsPrefix, ...args], { cwd: cli.cwd, timeoutMs });
        const failure = result.spawnError ? 'start' : result.timedOut ? 'timeout' : undefined;
        return {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(failure ? { failure, message: describeChildFailure(cli.cmd, result) } : {})
        };
    } catch (error) {
        return {
            exitCode: -1,
            stdout: '',
            stderr: '',
            failure: 'start',
            message: `The CLI was not started: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
