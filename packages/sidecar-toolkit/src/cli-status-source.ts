/**
 * A status source fed by the product's CLI: the toolkit runs the commands, the
 * product reads their JSON and says what state each node is in.
 *
 * The platform's status source (`DiagramProfile.statusSource`) asks for node
 * states and shows them; where they come from is the product's business. For
 * a CLI-backed product it is almost always the same thing: run the tool a
 * diagram is drawn with, with other arguments, and read the report it prints.
 * The part that is the same for every product -- which command (the
 * configured CLI, as a Python module or a binary), where it runs, how long it
 * may take, what a failure to start or to answer says -- lives here; the
 * product's `collect` gets a `cli(args)` that does all of it and is left with
 * the arguments and the mapping, which only it knows. A report that takes
 * several commands (index, then query) is several calls.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExecutionNodeState } from '@dialogram/shared';
import { describeChildFailure, runChildProcess } from './run-child-process.js';
import { getCliInvocation, getGraphLoadTimeoutMs, type SidecarRuntimeConfig } from './server/sidecar-runtime-config.js';

/**
 * Runs the product's CLI with `args` (after any `-m <module>` prefix the
 * configured command needs) and resolves to what it printed, parsed as JSON.
 */
export type StatusCli = (args: string[]) => Promise<unknown>;

/** A status source as a CLI-backed product declares it (`SidecarProfileInput.statusSource`). */
export interface SidecarStatusSourceInput {
    /** What the states say, in a word or two (`Coverage`): the menu, progress and messages say it. */
    label: string;
    /** Consumer-owned command ids the platform registers and the diagram's context menu offers. */
    showCommand: string;
    clearCommand: string;
    /**
     * The node states for the diagram of `file`, from the CLI's reports.
     * `cli(args)` runs the configured CLI command in the file's folder, with
     * the graph-load deadline, and resolves to its stdout parsed as JSON,
     * whatever its exit code: a CLI that speaks JSON reports its own failures
     * there, and `collect` knows what they mean. It rejects when the command
     * cannot start, does not answer in time, or prints no JSON. A throw from
     * `collect` is shown to the person; the states shown stay as they were.
     */
    collect(file: string, cli: StatusCli): Promise<ExecutionNodeState[]>;
}

export interface CliJsonOptions {
    cmd: string;
    argsPrefix: string[];
    cwd?: string;
    timeoutMs?: number;
    /** Each command line, before it runs. */
    log?: (line: string) => void;
}

/**
 * Run the CLI once and parse its stdout as JSON. See {@link StatusCli} for
 * when it resolves and when it rejects; a rejection says which it was, with
 * the command's stderr when it has one.
 */
export async function runCliJson(args: string[], options: CliJsonOptions): Promise<unknown> {
    const argv = [...options.argsPrefix, ...args];
    options.log?.(`$ ${[options.cmd, ...argv].join(' ')}`);
    const result = await runChildProcess(options.cmd, argv, { cwd: options.cwd, timeoutMs: options.timeoutMs });
    if (result.spawnError || result.timedOut) {
        throw new Error(describeChildFailure(options.cmd, result));
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(describeChildFailure(options.cmd, result) ?? `${options.cmd} ${args.join(' ')}: printed no JSON`);
    }
}

/**
 * The platform's status source for a CLI-backed product: `collect` gets a
 * {@link StatusCli} bound to the CLI command, folder and deadline of the file
 * it is asked about, read from the same settings the diagram's own plan uses,
 * so the report comes from the same tool the diagram was drawn with.
 */
export function createCliStatusSource(input: SidecarStatusSourceInput, runtimeConfig: SidecarRuntimeConfig) {
    return {
        label: input.label,
        showCommand: input.showCommand,
        clearCommand: input.clearCommand,
        collect: (file: string, context: { output: { appendLine(line: string): void } }): Promise<ExecutionNodeState[]> => {
            const scopeUri = vscode.Uri.file(file);
            const options: CliJsonOptions = {
                ...getCliInvocation(runtimeConfig, vscode, scopeUri),
                cwd: path.dirname(file),
                timeoutMs: getGraphLoadTimeoutMs(runtimeConfig, vscode, scopeUri),
                log: line => context.output.appendLine(line)
            };
            return input.collect(file, args => runCliJson(args, options));
        }
    };
}
