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
 */

import * as vscode from 'vscode';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiagramProfile } from '../../api';

/** A launch whose program exits with an error within this time failed, and says so. */
const EARLY_EXIT_MS = 5000;

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
            words.push(value.startsWith('file://') ? vscode.Uri.parse(value).fsPath : value);
        } else {
            throw new Error(`cannot pass a ${typeof value} to a program: ${JSON.stringify(value)}`);
        }
    };
    args.forEach(add);
    return words;
}

/** A program's arguments with options as they are, patterns replaced by their matches, paths checked. */
export function expandLauncherArguments(words: readonly string[]): string[] {
    const expanded: string[] = [];
    for (const word of words) {
        if (word.startsWith('-')) {
            expanded.push(word);
        } else if (/[*?]/.test(word)) {
            const matches = expandPathPattern(word);
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
export function expandPathPattern(pattern: string): string[] {
    const absolute = path.resolve(pattern);
    const segments = absolute.split(path.sep).filter(segment => segment !== '');
    let paths = [path.parse(absolute).root];
    for (const segment of segments) {
        const next: string[] = [];
        if (/[*?]/.test(segment)) {
            const regex = segmentRegex(segment);
            for (const base of paths) {
                let names: string[];
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

/** Registers `commandId` as the profile's launcher. */
export function registerLauncher(commandId: string, profile: DiagramProfile): vscode.Disposable {
    const output = vscode.window.createOutputChannel(`${profile.displayName} Launcher`);
    const command = vscode.commands.registerCommand(commandId, (...args: unknown[]) => {
        try {
            launch(launcherWords(args), profile, output, commandId);
        } catch (error) {
            // Said here rather than thrown: a viewer's failing command is
            // retried after its token is opened in the editor, which a
            // missing file or a bad pattern would only repeat.
            void vscode.window.showErrorMessage(`Launcher: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    return vscode.Disposable.from(command, output);
}

function launch(words: readonly string[], profile: DiagramProfile, output: vscode.OutputChannel, commandId: string): void {
    if (words.length === 0) {
        throw new Error(`${commandId} needs a program and its arguments, as a viewer gives them: ["program", "argument", ...].`);
    }
    if (vscode.workspace.isTrusted === false) {
        throw new Error('it starts programs only in a trusted workspace.');
    }
    const [program, ...rest] = words;
    const args = expandLauncherArguments(rest);
    const configured = vscode.workspace
        .getConfiguration(profile.settingsNamespace)
        .get<string>(LAUNCHER_WORKING_DIRECTORY_SETTING);
    const cwd = launcherWorkingDirectory(configured, args, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

    output.appendLine(`$ ${[program, ...args].map(quoteWord).join(' ')}${cwd ? `   (in ${cwd})` : ''}`);
    const started = Date.now();
    const child = childProcess.spawn(program, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (data: Buffer) => output.append(data.toString()));
    child.stderr?.on('data', (data: Buffer) => output.append(data.toString()));
    child.on('error', error => {
        void vscode.window.showErrorMessage(`Launcher: ${program} did not start (${error.message}).`);
    });
    child.on('exit', (code, signal) => {
        output.appendLine(`${program} (pid ${child.pid}) exited: ${signal ?? code}`);
        if (code && Date.now() - started < EARLY_EXIT_MS) {
            void vscode.window.showErrorMessage(`Launcher: ${program} exited with code ${code}.`, 'Show Output')
                .then(choice => {
                    if (choice) {
                        output.show(true);
                    }
                });
        }
    });
    child.unref();
}
