/**
 * The launcher: a command that starts an external program, in its own window
 * and process group, on the arguments a viewer gives it.
 *
 * Some outputs have no editor in VS Code (a chip layout opens in KLayout, a
 * waveform database in its own viewer). A viewer reaches such a program by
 * running the profile's `launch` command with the program and its arguments
 * as strings, the token's path already substituted:
 *
 *     ["klayout", "-nn", "/run/out/objects/x/klayout.lyt", "/run/out/results/x/final.gds"]
 *
 * The first word is the program, a name on the PATH or an absolute path. Of
 * the rest, a word starting with `-` is an option and goes through as it is;
 * any other word with a `*` or `?` in it is a path pattern, replaced by the
 * paths it matches, so a viewer whose arguments are fixed can still name the
 * files inside a folder token whose layout it only knows in shape. A pattern
 * that matches nothing, or an absolute path that does not exist, stops the
 * launch with a message saying which.
 *
 * The program starts in `<settingsNamespace>.launcher.workingDirectory` when
 * that is set (absolute, or relative to the first workspace folder), else in
 * the folder of the first file it is given: a program that resolves relative
 * paths in its own configuration needs the former. Every launch's command
 * line, and the program's output, goes to the profile's Launcher output
 * channel. It runs only in a trusted workspace.
 *
 * The program is named by a file of the workspace, so the first time one is
 * started the user is shown the command line and asked; "always" is kept for
 * that program on this machine. The program outlives the window: its output
 * goes to a file the channel follows, not to a pipe that would end with the
 * extension host and take the program with it.
 */

import * as vscode from 'vscode';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DiagramProfile } from '../../api';

/** A launch whose program exits with an error within this time failed, and says so. */
const EARLY_EXIT_MS = 5000;

/** How many folders a pattern may read before it is given up as too wide (a wildcard at every level from the root). */
const PATTERN_FOLDER_BUDGET = 20000;

/** Where the programs a user said "always" to are kept (a machine's, not a workspace's). */
export const ALLOWED_PROGRAMS_KEY = 'dialogram.launcher.allowedPrograms';

/** The setting, under the profile's namespace, naming the folder programs start in. */
export const LAUNCHER_WORKING_DIRECTORY_SETTING = 'launcher.workingDirectory';

/** The command's arguments as words: Uris and `file://` strings as paths, lists flattened. */
export function launcherWords(args: readonly unknown[]): string[] {
    const words: string[] = [];
    const add = (value: unknown): void => {
        if (value === undefined || value === null) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(add);
        } else if (value instanceof vscode.Uri) {
            words.push(value.fsPath);
        } else if (typeof value === 'string') {
            if (!value.startsWith('file://')) {
                words.push(value);
            } else if (/[*?]/.test(value)) {
                // A pattern on a `{uri}`: a `?` is its wildcard, not a URI's query.
                words.push(decodeURIComponent(value.slice('file://'.length)));
            } else {
                words.push(vscode.Uri.parse(value).fsPath);
            }
        } else {
            throw new Error(`cannot pass a ${typeof value} to a program: ${JSON.stringify(value)}`);
        }
    };
    args.forEach(add);
    return words;
}

/** A program's arguments with options as they are, patterns replaced by their matches, paths checked. */
export function expandLauncherArguments(words: readonly string[], base?: string): string[] {
    const expanded: string[] = [];
    for (const word of words) {
        if (word.startsWith('-')) {
            expanded.push(word);
        } else if (/[*?]/.test(word)) {
            const matches = expandPathPattern(word, base);
            if (matches.length === 0) {
                throw new Error(`nothing matches ${word}`);
            }
            expanded.push(...matches);
        } else {
            if (path.isAbsolute(word) && !fs.existsSync(word)) {
                throw new Error(`${word} does not exist`);
            }
            expanded.push(word);
        }
    }
    return expanded;
}

/**
 * The paths a pattern matches, sorted within each folder: `*` is any run of
 * characters within one path segment, `?` any one character. As in a shell,
 * a wildcard does not match a name starting with a dot unless the segment
 * starts with one.
 */
export function expandPathPattern(pattern: string, base?: string): string[] {
    // A relative pattern is the launch's: from where the program starts.
    const { root, segments } = patternSegments(path.resolve(base ?? process.cwd(), pattern));
    let paths = [root];
    let read = 0;
    for (const segment of segments) {
        const next: string[] = [];
        if (/[*?]/.test(segment)) {
            const regex = segmentRegex(segment);
            for (const base of paths) {
                let names: string[];
                if (++read > PATTERN_FOLDER_BUDGET) {
                    throw new Error(`${pattern} is too wide: it reads more than ${PATTERN_FOLDER_BUDGET} folders`);
                }
                try {
                    names = fs.readdirSync(base);
                } catch {
                    continue;
                }
                for (const name of names.sort()) {
                    if (regex.test(name) && (segment.startsWith('.') || !name.startsWith('.'))) {
                        next.push(path.join(base, name));
                    }
                }
            }
        } else {
            for (const base of paths) {
                const candidate = path.join(base, segment);
                if (fs.existsSync(candidate)) {
                    next.push(candidate);
                }
            }
        }
        paths = next;
    }
    return paths;
}

/**
 * An absolute path as its root and the names under it: the root is not one of
 * the names (`C:\\run\\*` is `C:\\` and `run`, `*`; a share's root is the share).
 */
export function patternSegments(absolute: string, pathApi: typeof path = path): { root: string; segments: string[] } {
    const root = pathApi.parse(absolute).root;
    return { root, segments: pathApi.relative(root, absolute).split(pathApi.sep).filter(segment => segment !== '') };
}

function segmentRegex(segment: string): RegExp {
    const body = segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${body}$`);
}

/**
 * Where a program starts: the configured folder (absolute, or relative to
 * `workspaceFolder`, `${workspaceFolder}` allowed), which must exist; else the
 * folder of the first absolute path among its arguments; else nowhere in
 * particular (`undefined`, the extension host's own).
 */
export function launcherWorkingDirectory(
    configured: string | undefined,
    args: readonly string[],
    workspaceFolder: string | undefined
): string | undefined {
    if (configured && configured.trim() !== '') {
        if (workspaceFolder === undefined && (configured.includes('${workspaceFolder}') || !path.isAbsolute(configured))) {
            throw new Error(`the launcher's working directory ${configured} is relative to a workspace folder, and there is none`);
        }
        const base = workspaceFolder ?? '';
        const dir = path.resolve(base, configured.replace(/\$\{workspaceFolder\}/g, base));
        if (!fs.existsSync(dir)) {
            throw new Error(`the launcher's working directory ${dir} does not exist`);
        }
        return dir;
    }
    const firstFile = args.find(word => !word.startsWith('-') && path.isAbsolute(word));
    return firstFile ? path.dirname(firstFile) : undefined;
}

/** A word as a shell would need it written, for the output channel's command lines. */
export function quoteWord(word: string): string {
    return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Why `program` cannot be one: an existing file that is not executable (a viewer with no args hands the launcher its token). */
export function notAProgram(program: string): string | undefined {
    if (!path.isAbsolute(program) || !fs.existsSync(program)) {
        return undefined;  // a name on the PATH, or nothing: the spawn says
    }
    try {
        if (fs.statSync(program).isDirectory()) {
            return `${program} is a folder, not a program`;
        }
        fs.accessSync(program, fs.constants.X_OK);
        return undefined;
    } catch {
        return `${program} is not a program: a viewer's args start with the program to run`;
    }
}

/** What remembers the programs a user always allows: an extension's `globalState`. */
export interface ProgramMemory {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

export const START = 'Start';
export const ALWAYS = 'Always Start';

/**
 * Whether the user lets `program` start: yes when they said "always" for it
 * before, else asked, with the command line in front of them.
 */
export async function allowedToStart(
    program: string,
    commandLine: string,
    memory: ProgramMemory | undefined,
    ask: (message: string, detail: string, ...items: string[]) => PromiseLike<string | undefined>
): Promise<boolean> {
    const allowed = memory?.get<string[]>(ALLOWED_PROGRAMS_KEY, []) ?? [];
    if (allowed.includes(program)) {
        return true;
    }
    const always = `${ALWAYS} ${path.basename(program)}`;
    const choice = await ask(
        `Start ${path.basename(program)}?`,
        `A workflow in this workspace asks to run:\n\n${commandLine}`,
        START, ...(memory ? [always] : []));
    if (choice === always && memory) {
        await memory.update(ALLOWED_PROGRAMS_KEY, [...allowed, program]);
    }
    return choice === START || choice === always;
}

/**
 * Start `program` on its own: detached, its output in a file under the
 * system's temporary folder, so it lives on when the window that started it
 * closes (a pipe into the extension host would break then, and the program's
 * next line of output would end it).
 */
export function startDetached(program: string, args: readonly string[], cwd: string | undefined): { child: childProcess.ChildProcess; log: string } {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dialogram-launcher-')), 'output.log');
    const fd = fs.openSync(log, 'a');
    try {
        const child = childProcess.spawn(program, [...args], { cwd, detached: true, stdio: ['ignore', fd, fd] });
        child.unref();
        return { child, log };
    } finally {
        fs.closeSync(fd);
    }
}

/** Follows a growing file, handing what was added to `sink`; the returned function reads the rest and stops. */
export function followFile(file: string, sink: (text: string) => void, everyMs = 400): () => void {
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    const read = (): void => {
        try {
            const size = fs.statSync(file).size;
            if (size <= offset) {
                return;
            }
            const fd = fs.openSync(file, 'r');
            try {
                const buffer = Buffer.alloc(size - offset);
                offset += fs.readSync(fd, buffer, 0, buffer.length, offset);
                sink(decoder.write(buffer));
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // gone, or the channel is: nothing to follow
        }
    };
    const timer = setInterval(read, everyMs);
    return () => {
        clearInterval(timer);
        read();
    };
}

/** Registers `commandId` as the profile's launcher. `memory` keeps the programs always allowed. */
export function registerLauncher(commandId: string, profile: DiagramProfile, memory?: ProgramMemory): vscode.Disposable {
    const output = vscode.window.createOutputChannel(`${profile.displayName} Launcher`);
    const command = vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
        try {
            await launch(launcherWords(args), profile, output, commandId, memory);
        } catch (error) {
            // Said here rather than thrown: a viewer's failing command is
            // retried after its token is opened in the editor, which a
            // missing file or a bad pattern would only repeat.
            void vscode.window.showErrorMessage(`Launcher: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    return vscode.Disposable.from(command, output);
}

async function launch(
    words: readonly string[],
    profile: DiagramProfile,
    output: vscode.OutputChannel,
    commandId: string,
    memory: ProgramMemory | undefined
): Promise<void> {
    if (words.length === 0) {
        throw new Error(`${commandId} needs a program and its arguments, as a viewer gives them: ["program", "argument", ...].`);
    }
    if (vscode.workspace.isTrusted === false) {
        throw new Error('it starts programs only in a trusted workspace.');
    }
    const [program, ...rest] = words;
    const wrong = notAProgram(program);
    if (wrong) {
        throw new Error(wrong);
    }
    // The workspace folder of the first file named, for its settings and for
    // what is relative: the first folder when no file says.
    const firstFile = rest.find(word => !word.startsWith('-') && path.isAbsolute(word));
    const folder = (firstFile ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(firstFile)) : undefined)
        ?? vscode.workspace.workspaceFolders?.[0];
    const configured = vscode.workspace
        .getConfiguration(profile.settingsNamespace, folder?.uri)
        .get<string>(LAUNCHER_WORKING_DIRECTORY_SETTING);
    const configuredDir = launcherWorkingDirectory(configured, [], folder?.uri.fsPath);
    const args = expandLauncherArguments(rest, configuredDir ?? folder?.uri.fsPath);
    const cwd = configuredDir ?? launcherWorkingDirectory(undefined, args, folder?.uri.fsPath);
    const commandLine = [program, ...args].map(quoteWord).join(' ');

    const ask = (message: string, detail: string, ...items: string[]): PromiseLike<string | undefined> =>
        vscode.window.showWarningMessage(message, { modal: true, detail }, ...items);
    if (!(await allowedToStart(program, commandLine, memory, ask))) {
        return;
    }

    const say = (text: string): void => {
        try {
            output.append(text);
        } catch {
            // the channel went with the window
        }
    };
    say(`$ ${commandLine}${cwd ? `   (in ${cwd})` : ''}\n`);
    const started = Date.now();
    const { child, log } = startDetached(program, args, cwd);
    const stop = followFile(log, say);
    const finish = (): void => {
        stop();
        fs.rmSync(path.dirname(log), { recursive: true, force: true });
    };
    child.on('error', error => {
        finish();
        void vscode.window.showErrorMessage(`Launcher: ${program} did not start (${error.message}).`);
    });
    child.on('exit', (code, signal) => {
        finish();
        say(`${program} (pid ${child.pid}) exited: ${signal ?? code}\n`);
        if (code && Date.now() - started < EARLY_EXIT_MS) {
            void vscode.window.showErrorMessage(`Launcher: ${program} exited with code ${code}.`, 'Show Output')
                .then(choice => {
                    if (choice) {
                        output.show(true);
                    }
                });
        }
    });
}
