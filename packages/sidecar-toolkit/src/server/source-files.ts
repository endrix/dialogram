/**
 * The source tree as the toolkit reads it: whether a file exists, the Python
 * package a file belongs to, and the source files under a set of roots.
 * Written once; the analysis, the create-node handler, the graph export and
 * the run driver all read through here.
 */
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

export async function fileExists(pathValue: string): Promise<boolean> {
    try {
        await fs.access(pathValue);
        return true;
    } catch {
        return false;
    }
}

/**
 * The directory above the outermost `__init__.py` package that holds `filePath`,
 * the file's own directory when it is in none: what goes on `PYTHONPATH` so the
 * file's imports resolve. `undefined` only when the walk reaches the filesystem
 * root without leaving a package.
 */
export async function findPackageRootForFile(filePath: string): Promise<string | undefined> {
    let current = path.dirname(filePath);
    for (;;) {
        if (!(await fileExists(path.join(current, '__init__.py')))) {
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
    return current;
}

/** `env` with `packageRoot` first on `PYTHONPATH`; `env` itself when there is no root. */
export function withPythonPackageRoot(env: NodeJS.ProcessEnv, packageRoot: string | undefined): NodeJS.ProcessEnv {
    if (!packageRoot) {
        return env;
    }
    const existing = env.PYTHONPATH;
    return {
        ...env,
        PYTHONPATH: existing && existing.trim() !== '' ? `${packageRoot}${path.delimiter}${existing}` : packageRoot
    };
}

export interface CollectSourceFilesOptions {
    /** Directory names never descended into. */
    excludedDirs: ReadonlySet<string>;
    /** Skip every directory whose name begins with a dot. Default `true`. */
    skipDotDirs?: boolean;
    /** Stop after this many files; `Infinity` for no ceiling. */
    maxFiles?: number;
    /** Stop after this many directories; `Infinity` for no ceiling. */
    maxDirs?: number;
    /** What the ceiling warning calls the scan, e.g. `caller-reference scan`. */
    scanLabel?: string;
}

/**
 * The `.py` files under `scanRoots`, absolute, each once, without `excludeFilePath`.
 * A ceiling, when hit, is logged and ends the scan: a heavy checkout must not
 * stall the diagram.
 */
export async function collectPythonFilesUnderRoots(
    scanRoots: string[],
    excludeFilePath: string,
    options: CollectSourceFilesOptions
): Promise<string[]> {
    const files: string[] = [];
    const seen = new Set<string>();
    const skipDotDirs = options.skipDotDirs !== false;
    const maxFiles = options.maxFiles ?? Infinity;
    const maxDirs = options.maxDirs ?? Infinity;
    const label = options.scanLabel ?? 'source scan';
    const targetPath = path.resolve(excludeFilePath);
    let ceilingHit = false;
    let dirsVisited = 0;

    const visit = async (dirPath: string, root: string): Promise<void> => {
        if (ceilingHit) {
            return;
        }
        dirsVisited += 1;
        if (dirsVisited > maxDirs) {
            ceilingHit = true;
            // eslint-disable-next-line no-console
            console.warn(
                `[dialogram] ${label} hit the ${maxDirs}-directory ceiling under `
                + `${root}; cross-file "Used By" references may be incomplete for this project.`
            );
            return;
        }
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch {
            return;
        }
        for (const entry of entries) {
            if (ceilingHit) {
                return;
            }
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                if ((skipDotDirs && entry.name.startsWith('.')) || options.excludedDirs.has(entry.name)) {
                    continue;
                }
                await visit(entryPath, root);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.py')) {
                continue;
            }
            const normalizedPath = path.resolve(entryPath);
            if (normalizedPath === targetPath || seen.has(normalizedPath)) {
                continue;
            }
            seen.add(normalizedPath);
            files.push(normalizedPath);
            if (files.length >= maxFiles) {
                ceilingHit = true;
                // eslint-disable-next-line no-console
                console.warn(
                    `[dialogram] ${label} hit the ${maxFiles}-file ceiling under `
                    + `${root}; cross-file "Used By" references may be incomplete for this project.`
                );
                return;
            }
        }
    };

    for (const root of scanRoots) {
        if (ceilingHit) {
            break;
        }
        const normalizedRoot = path.resolve(root);
        if (seen.has(`dir:${normalizedRoot}`)) {
            continue;
        }
        seen.add(`dir:${normalizedRoot}`);
        await visit(normalizedRoot, normalizedRoot);
    }
    return files;
}
