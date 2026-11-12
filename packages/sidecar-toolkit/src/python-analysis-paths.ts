/**
 * The Python language server's import paths, from the sidecar's interpreter.
 *
 * A Python product's sidecar is run by the interpreter that imports the
 * source, so it draws a diagram of a file whose imports the editor underlines:
 * the language server (Pylance) resolves them from its own configuration,
 * which may name another interpreter or miss the project's import roots. The
 * sidecar is asked where its interpreter looks (`pythonEnvironment`: the
 * file's import roots, and the folders its installed packages come from) and
 * what the language server lacks is added to `python.analysis.extraPaths` of
 * the file's workspace folder, when a diagram of the file is opened.
 *
 * Paths are only added, never removed, and only for a folder without a
 * `pyrightconfig.json` (which overrides the setting: its author is told what
 * it lacks instead). The interpreter's installed packages are added only when
 * the Python extension has another interpreter selected for the folder.
 */
import * as path from 'node:path';

/** The op a sidecar answers with its interpreter's paths (canonical, bare). */
export const PYTHON_ENVIRONMENT_OP = 'pythonEnvironment';

/** The setting the language server reads its extra import paths from. */
export const EXTRA_PATHS_SECTION = 'python.analysis';
export const EXTRA_PATHS_KEY = 'extraPaths';

/** What a sidecar says of its interpreter, for one source file. */
export interface PythonEnvironment {
    /** `sys.prefix`: what tells one interpreter's environment from another's. */
    prefix?: string;
    /** The import roots of the file's own project. */
    roots: string[];
    /** Where installed packages are imported from. */
    libraryPaths: string[];
}

const absolutePaths = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));

/** The answer in a sidecar's `diagnostic`; nothing for an answer of another shape. */
export function parsePythonEnvironment(diagnostic: unknown): PythonEnvironment | undefined {
    if (!diagnostic || typeof diagnostic !== 'object') {
        return undefined;
    }
    const { prefix, roots, libraryPaths } = diagnostic as Record<string, unknown>;
    if (!Array.isArray(roots)) {
        return undefined;
    }
    return {
        ...(typeof prefix === 'string' && prefix.trim() !== '' ? { prefix } : {}),
        roots: absolutePaths(roots),
        libraryPaths: absolutePaths(libraryPaths)
    };
}

/** An `extraPaths` entry as an absolute path: relative to the folder, `${workspaceFolder}` expanded. */
function resolveEntry(entry: string, folder: string): string {
    const expanded = entry.replace(/\$\{workspaceFolder\}/g, folder);
    return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(folder, expanded));
}

const sameDir = (a: string, b: string): boolean => path.normalize(a).replace(/[\\/]+$/, '') === path.normalize(b).replace(/[\\/]+$/, '');

/**
 * The entries to add to a folder's `extraPaths`, in the order the interpreter
 * searches: the file's import roots, then (when the language server runs
 * another interpreter) where the sidecar's packages are installed. A path
 * inside the folder is written relative to it, so the setting reads the same
 * on another machine; the folder itself is left out, the language server
 * searching it anyway; what `existing` has already is not added again.
 */
export function extraPathsToAdd(options: {
    folder: string;
    existing: readonly string[];
    environment: PythonEnvironment;
    /** The language server runs the sidecar's interpreter: its packages are found already. */
    sameInterpreter: boolean;
}): string[] {
    const { folder, environment } = options;
    const have = options.existing.filter(entry => typeof entry === 'string').map(entry => resolveEntry(entry, folder));
    const wanted = [...environment.roots, ...(options.sameInterpreter ? [] : environment.libraryPaths)];
    const added: string[] = [];
    const taken: string[] = [];
    for (const candidate of wanted) {
        if (sameDir(candidate, folder) || [...have, ...taken].some(known => sameDir(known, candidate))) {
            continue;
        }
        taken.push(candidate);
        const relative = path.relative(folder, candidate);
        const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        added.push(inside ? relative.split(path.sep).join('/') : candidate);
    }
    return added;
}

/** A workspace folder, as far as this goes. */
export interface AnalysisFolder {
    /** Its path on disk. */
    path: string;
    name: string;
}

/** What the paths are read from and written to: `vscode`, or a test's stand-in. */
export interface PythonAnalysisHost {
    /** The workspace folder of a file; nothing for a file in none. */
    folderOf(file: string): AnalysisFolder | undefined;
    /** Whether the product's setting lets the paths be written for this file. */
    enabled(file: string): boolean;
    /** Whether a language server that reads the setting is installed. */
    languageServerInstalled(): boolean;
    /** The sidecar's answer for the file; nothing when it has none (an older sidecar, a failure). */
    environmentOf(file: string): Promise<PythonEnvironment | undefined>;
    /** `sys.prefix` of the interpreter the Python extension has selected for the folder, when it says. */
    selectedPrefix(folder: AnalysisFolder): Promise<string | undefined>;
    /** The `extraPaths` in a `pyrightconfig.json` of the folder: nothing when there is no such file, `'unreadable'` for one that is not plain JSON. */
    pyrightConfigPaths(folder: AnalysisFolder): Promise<string[] | 'unreadable' | undefined>;
    /** Whether the folder's `pyproject.toml` configures Pyright. */
    pyprojectConfiguresPyright(folder: AnalysisFolder): Promise<boolean>;
    /** The folder's effective `extraPaths`. */
    extraPaths(folder: AnalysisFolder): string[];
    /** Set the folder's `extraPaths`. */
    writeExtraPaths(folder: AnalysisFolder, paths: string[]): Promise<void>;
    /** Say what was added; `stop` turns the product's setting off for the folder. Not waited for. */
    notifyAdded(folder: AnalysisFolder, added: string[], stop: () => Promise<void>): void;
    /** Say what a `pyrightconfig.json` lacks. Not waited for. */
    notifyLacking(folder: AnalysisFolder, lacking: string[]): void;
    /** Turn the product's setting off for the folder. */
    disable(folder: AnalysisFolder): Promise<void>;
    log(message: string): void;
}

/**
 * Considers a source file whose diagram was opened: once per file in a
 * session, one folder's setting written at a time (a read and a write of one
 * list), and never throwing (this runs beside the opening of a diagram, which
 * it must not disturb).
 */
export class PythonAnalysisPaths {
    private readonly considered = new Set<string>();
    private readonly toldLacking = new Set<string>();
    private readonly toldAdded = new Set<string>();
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly host: PythonAnalysisHost) {}

    /** Resolves when the file has been dealt with. */
    consider(file: string): Promise<void> {
        if (this.considered.has(file)) {
            return this.queue;
        }
        this.considered.add(file);
        this.queue = this.queue.then(() => this.configure(file)).catch(error => {
            this.host.log(`python analysis paths: ${error instanceof Error ? error.message : String(error)}`);
        });
        return this.queue;
    }

    /** A file is considered again: after its sidecar, its interpreter or the setting changed. */
    forget(): void {
        this.considered.clear();
    }

    private async configure(file: string): Promise<void> {
        const { host } = this;
        const folder = host.folderOf(file);
        if (!folder || !host.enabled(file) || !host.languageServerInstalled()) {
            return;
        }
        const environment = await host.environmentOf(file);
        if (!environment) {
            return;
        }
        const selected = await host.selectedPrefix(folder);
        const sameInterpreter = selected !== undefined && environment.prefix !== undefined && sameDir(selected, environment.prefix);

        // A pyrightconfig.json, or Pyright's table in pyproject.toml, is the
        // folder's configuration: the setting is not read, and the file is its
        // author's to change.
        const configured = await host.pyrightConfigPaths(folder);
        if (configured !== undefined) {
            const lacking = configured === 'unreadable'
                ? []
                : extraPathsToAdd({ folder: folder.path, existing: configured, environment, sameInterpreter });
            if (lacking.length > 0 && !this.toldLacking.has(folder.path)) {
                this.toldLacking.add(folder.path);
                host.notifyLacking(folder, lacking);
            }
            return;
        }
        if (await host.pyprojectConfiguresPyright(folder)) {
            host.log(`python analysis paths: ${folder.name} configures Pyright in pyproject.toml; nothing written`);
            return;
        }

        const existing = host.extraPaths(folder);
        const added = extraPathsToAdd({ folder: folder.path, existing, environment, sameInterpreter });
        if (added.length === 0) {
            return;
        }
        await host.writeExtraPaths(folder, [...existing, ...added]);
        host.log(`python analysis paths: added ${added.join(', ')} to ${EXTRA_PATHS_SECTION}.${EXTRA_PATHS_KEY} of ${folder.name}`);
        if (!this.toldAdded.has(folder.path)) {
            this.toldAdded.add(folder.path);
            host.notifyAdded(folder, added, () => host.disable(folder));
        }
    }
}
