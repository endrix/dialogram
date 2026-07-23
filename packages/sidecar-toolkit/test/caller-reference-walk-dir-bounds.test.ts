// Directory-traversal bound for the caller-reference ("Used By" breadcrumb) source walk.
//
// The existing `MAX_SOURCE_FILES_PER_SCAN` ceiling caps the number of `.py` files COLLECTED, but not
// the number of DIRECTORIES VISITED. In a monorepo with sparse Python (e.g. an MLIR/LLVM-scale repo
// whose scan root — the workspace folder — holds hundreds of thousands of build/vendor directories
// but very few `.py` files), the file ceiling never trips, so the walk recurses into the entire
// tree. That unbounded traversal is the one genuinely O(workspace) operation reachable from a
// diagram load: it runs in the background (deferred caller discovery) after the first open and, on a
// warm machine in a real MLIR workspace, took ~24s — long enough to starve a concurrent
// refresh-queue-visibility build's overlay phase (its `overlaysRest` bucket absorbed the wait).
//
// These tests pin a hard directory-visit ceiling that bounds the traversal regardless of how sparse
// the `.py` files are, while preserving selection semantics when the tree is under the ceiling.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    collectPythonFilesUnderRoots,
    MAX_SOURCE_FILES_PER_SCAN,
    MAX_DIRS_PER_SCAN
} from '../src/server/source-analysis';

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function writeFile(filePath: string, content = ''): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Build a wide, `.py`-sparse tree: `dirCount` sibling directories under `root`, none of which hold
 * any Python file. This is the shape that defeats the file-count ceiling (it never trips) so the
 * walk visits every directory — the pathology this suite bounds. A single `.py` lives at the root so
 * `collectPythonFilesUnderRoots` still has one collectible result.
 */
async function seedSparseWideTree(root: string, dirCount: number): Promise<void> {
    await writeFile(path.join(root, 'root.py'), '# the only python file\n');
    for (let i = 0; i < dirCount; i++) {
        // A file (not .py) inside each dir so it is a real, non-empty directory that must be read.
        await writeFile(path.join(root, `d${i}`, 'notes.txt'), 'x');
    }
}

afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('caller-reference source walk: directory-visit ceiling', () => {
    it('RED-on-HEAD: without a dir ceiling the walk reads every directory in a .py-sparse tree', async () => {
        const root = await mkTempDir('wf-walk-dir-red-');
        const DIR_COUNT = 3000;
        await seedSparseWideTree(root, DIR_COUNT);

        const readdirSpy = vi.spyOn(fsp, 'readdir');
        // Cap dirs far below the tree size; a bounded implementation must stop early.
        await collectPythonFilesUnderRoots([root], path.join(root, 'root.py'), MAX_SOURCE_FILES_PER_SCAN, 200);

        // With the ceiling honored, readdir fires at most (ceiling + the root) times — never once per
        // directory in the tree. On the pre-fix implementation this count was ~DIR_COUNT+1.
        expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(201);
        expect(readdirSpy.mock.calls.length).toBeLessThan(DIR_COUNT);
    });

    it('stops at the directory ceiling and warns once naming the root', async () => {
        const root = await mkTempDir('wf-walk-dir-ceiling-');
        await seedSparseWideTree(root, 500);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const readdirSpy = vi.spyOn(fsp, 'readdir');

        await collectPythonFilesUnderRoots([root], path.join(root, 'root.py'), MAX_SOURCE_FILES_PER_SCAN, 50);

        expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(51);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('50-directory ceiling');
        expect(String(warnSpy.mock.calls[0][0])).toContain(path.resolve(root));
    });

    it('parity: a tree under the ceiling still collects exactly the same first-party .py files', async () => {
        const root = await mkTempDir('wf-walk-dir-parity-');
        const target = path.join(root, 'pkg', 'child.py');
        const realA = path.join(root, 'pkg', 'parent.py');
        const realB = path.join(root, 'pkg', 'sub', 'other.py');
        const realC = path.join(root, 'other-pkg', 'main.py');
        await writeFile(target, '# target\n');
        await writeFile(realA, '# a\n');
        await writeFile(realB, '# b\n');
        await writeFile(realC, '# c\n');

        // A generous ceiling (well above the handful of dirs here) must not change the result.
        const files = await collectPythonFilesUnderRoots([root], target, MAX_SOURCE_FILES_PER_SCAN, 10_000);

        expect(files.sort()).toEqual([path.resolve(realA), path.resolve(realB), path.resolve(realC)].sort());
        expect(files).not.toContain(path.resolve(target));
    });

    it('exports a sane production directory ceiling', () => {
        expect(MAX_DIRS_PER_SCAN).toBeGreaterThanOrEqual(2000);
        expect(Number.isFinite(MAX_DIRS_PER_SCAN)).toBe(true);
    });
});
