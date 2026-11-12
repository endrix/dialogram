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
 * Paths are only added, never removed. A `pyrightconfig.json` or a
 * `pyproject.toml` that sets `extraPaths` itself overrides the setting: it is
 * its author's, who is told what it lacks instead. The interpreter's
 * installed packages are added only when the Python extension is known to
 * have another interpreter selected for the folder.
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
    const expanded = entry.replace(/\$\{workspaceFolder\}/g, () => folder);
    return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(folder, expanded));
}

/** A folder path to compare: forward slashes, no trailing one, and no case where the file system has none. */
const comparable = (dir: string, platform: string): string => {
    const plain = path.normalize(dir).split('\\').join('/').replace(/\/+$/, '');
    return platform === 'win32' ? plain.toLowerCase() : plain;
};

/** Whether two paths name one folder, as written (links are not followed). */
export const sameDir = (a: string, b: string, platform: string = process.platform): boolean =>
    comparable(a, platform) === comparable(b, platform);

/** What follows `base` in `candidate`: `''` for the folder itself, nothing for a path not under it. */
function below(candidate: string, base: string, platform: string): string | undefined {
    const head = comparable(candidate, platform);
    const root = comparable(base, platform);
    if (head === root) {
        return '';
    }
    return head.startsWith(`${root}/`) ? path.normalize(candidate).split('\\').join('/').replace(/\/+$/, '').slice(root.length + 1) : undefined;
}

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
    /**
     * The folder with its links followed, when that is another path: the
     * interpreter names paths that way, and one under it is a path of the
     * folder.
     */
    folderRealPath?: string;
    /** `process.platform`, for a test. */
    platform?: string;
}): string[] {
    const { folder, environment } = options;
    const platform = options.platform ?? process.platform;
    const bases = [folder, ...(options.folderRealPath ? [options.folderRealPath] : [])];
    /** A path as the folder's own (`''` the folder, `flows` a folder in it), else as it is. */
    const placed = (candidate: string): { inside?: string; path: string } => {
        for (const base of bases) {
            const inside = below(candidate, base, platform);
            if (inside !== undefined) {
                return { inside, path: candidate };
            }
        }
        return { path: candidate };
    };
    const key = (place: { inside?: string; path: string }): string =>
        (place.inside !== undefined ? `in:${platform === 'win32' ? place.inside.toLowerCase() : place.inside}` : `at:${comparable(place.path, platform)}`);
    const have = new Set(options.existing.filter(entry => typeof entry === 'string').map(entry => key(placed(resolveEntry(entry, folder)))));
    const wanted = [...environment.roots, ...(options.sameInterpreter ? [] : environment.libraryPaths)];
    const added: string[] = [];
    for (const candidate of wanted) {
        const place = placed(candidate);
        if (place.inside === '' || have.has(key(place))) {
            continue;
        }
        have.add(key(place));
        added.push(place.inside !== undefined ? place.inside : candidate);
    }
    return added;
}

/** A workspace folder, as far as this goes. */
export interface AnalysisFolder {
    /** Its path on disk. */
    path: string;
    name: string;
    /** Its path with links followed, when the host knows it. */
    realPath?: string;
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
    /**
     * The `extraPaths` a `pyrightconfig.json` of the folder sets: nothing when
     * there is no such file or it sets none (the setting is then read),
     * `'unreadable'` for a file that is not plain JSON.
     */
    pyrightConfigPaths(folder: AnalysisFolder): Promise<string[] | 'unreadable' | undefined>;
    /** Whether the folder's `pyproject.toml` sets Pyright's `extraPaths`. */
    pyprojectSetsExtraPaths(folder: AnalysisFolder): Promise<boolean>;
    /** The folder's effective `extraPaths`. */
    extraPaths(folder: AnalysisFolder): string[];
    /** Set the folder's `extraPaths`. */
    writeExtraPaths(folder: AnalysisFolder, paths: string[]): Promise<void>;
    /** Say what was added; `stop` turns the product's setting off for the folder (what was added stays). Not waited for. */
    notifyAdded(folder: AnalysisFolder, added: string[], stop: () => Promise<void>): void;
    /** Say what a `pyrightconfig.json` lacks. Not waited for. */
    notifyLacking(folder: AnalysisFolder, lacking: string[]): void;
    /** Turn the product's setting off for the folder. */
    disable(folder: AnalysisFolder): Promise<void>;
    log(message: string): void;
}

/**
 * Considers a source file whose diagram was opened: once per file in a
 * session once its sidecar has answered (a sidecar with no answer is asked
 * again the next time the file is opened), one folder's setting written at a
 * time (a read and a write of one list), and never throwing (this runs
 * beside the opening of a diagram, which it must not disturb).
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
        this.queue = this.queue.then(() => this.configure(file)).then(answered => {
            if (!answered) {
                this.considered.delete(file);
            }
        }).catch(error => {
            this.considered.delete(file);
            this.host.log(`python analysis paths: ${error instanceof Error ? error.message : String(error)}`);
        });
        return this.queue;
    }

    /** Every file is considered again: after the product's settings changed (the sidecar command, the setting that turns this off). */
    forget(): void {
        this.considered.clear();
    }

    /** Whether the file is dealt with: `false` when its sidecar gave no answer. */
    private async configure(file: string): Promise<boolean> {
        const { host } = this;
        const folder = host.folderOf(file);
        if (!folder || !host.enabled(file) || !host.languageServerInstalled()) {
            return true;
        }
        const environment = await host.environmentOf(file);
        if (!environment) {
            return false;
        }
        // Another interpreter only when that is known: an interpreter not
        // told yet (the Python extension still starting) is not a reason to
        // write a machine's package folders into the folder's settings.
        const selected = await host.selectedPrefix(folder);
        const sameInterpreter = selected === undefined || environment.prefix === undefined || sameDir(selected, environment.prefix);
        const toAdd = (existing: readonly string[]): string[] =>
            extraPathsToAdd({ folder: folder.path, folderRealPath: folder.realPath, existing, environment, sameInterpreter });

        // A pyrightconfig.json, or Pyright's table in pyproject.toml, that
        // sets extraPaths is the folder's configuration: the setting is not
        // read, and the file is its author's to change.
        const configured = await host.pyrightConfigPaths(folder);
        if (configured !== undefined) {
            const lacking = configured === 'unreadable' ? [] : toAdd(configured);
            if (lacking.length > 0 && !this.toldLacking.has(folder.path)) {
                this.toldLacking.add(folder.path);
                host.notifyLacking(folder, lacking);
            }
            return true;
        }
        if (await host.pyprojectSetsExtraPaths(folder)) {
            host.log(`python analysis paths: ${folder.name} sets Pyright's extraPaths in pyproject.toml; nothing written`);
            return true;
        }

        const existing = host.extraPaths(folder);
        const added = toAdd(existing);
        if (added.length === 0) {
            return true;
        }
        await host.writeExtraPaths(folder, [...existing, ...added]);
        host.log(`python analysis paths: added ${added.join(', ')} to ${EXTRA_PATHS_SECTION}.${EXTRA_PATHS_KEY} of ${folder.name}`);
        if (!this.toldAdded.has(folder.path)) {
            this.toldAdded.add(folder.path);
            host.notifyAdded(folder, added, () => host.disable(folder));
        }
        return true;
    }
}
