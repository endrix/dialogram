/**
 * The source tree as the toolkit reads it, written once for the analysis, the
 * create-node handler, the graph export and the run driver.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectPythonFilesUnderRoots, fileExists, findPackageRootForFile, withPythonPackageRoot } from '../src/server/source-files';

let root: string;

async function write(relative: string, text = ''): Promise<string> {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text);
    return full;
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogram-source-files-'));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('findPackageRootForFile', () => {
    it('is the directory above the outermost package', async () => {
        await write('proj/pkg/__init__.py');
        await write('proj/pkg/sub/__init__.py');
        const file = await write('proj/pkg/sub/flow.py');
        expect(await findPackageRootForFile(file)).toBe(path.join(root, 'proj'));
    });

    it("is the file's own directory when it is in no package", async () => {
        const file = await write('proj/flow.py');
        expect(await findPackageRootForFile(file)).toBe(path.join(root, 'proj'));
        expect(await fileExists(file)).toBe(true);
        expect(await fileExists(path.join(root, 'missing.py'))).toBe(false);
    });
});

describe('withPythonPackageRoot', () => {
    it('puts the root first on PYTHONPATH and leaves the environment alone without one', () => {
        const env = { PYTHONPATH: '/already' } as NodeJS.ProcessEnv;
        expect(withPythonPackageRoot(env, '/pkg').PYTHONPATH).toBe(`/pkg${path.delimiter}/already`);
        expect(withPythonPackageRoot({} as NodeJS.ProcessEnv, '/pkg').PYTHONPATH).toBe('/pkg');
        expect(withPythonPackageRoot(env, undefined)).toEqual(env);
        expect(withPythonPackageRoot(env, undefined)).not.toBe(env);
    });
});

describe('collectPythonFilesUnderRoots', () => {
    it('lists the .py files under the roots once, absolute, without the current file', async () => {
        const current = await write('a/current.py');
        await write('a/one.py');
        await write('a/deep/two.py');
        await write('a/readme.md');
        const files = await collectPythonFilesUnderRoots([path.join(root, 'a'), path.join(root, 'a')], current, { excludedDirs: new Set() });
        expect(files.sort()).toEqual([path.join(root, 'a/deep/two.py'), path.join(root, 'a/one.py')]);
    });

    it('skips the excluded directories, and the dot-directories unless told otherwise', async () => {
        await write('a/node_modules/x.py');
        await write('a/.venv/y.py');
        await write('a/keep.py');
        const options = { excludedDirs: new Set(['node_modules']) };
        expect(await collectPythonFilesUnderRoots([path.join(root, 'a')], '/none', options)).toEqual([path.join(root, 'a/keep.py')]);
        const withDots = await collectPythonFilesUnderRoots([path.join(root, 'a')], '/none', { ...options, skipDotDirs: false });
        expect(withDots.sort()).toEqual([path.join(root, 'a/.venv/y.py'), path.join(root, 'a/keep.py')]);
    });

    it('stops at the file ceiling and says which scan hit it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        for (let i = 0; i < 5; i += 1) {
            await write(`a/f${i}.py`);
        }
        const files = await collectPythonFilesUnderRoots([path.join(root, 'a')], '/none', { excludedDirs: new Set(), maxFiles: 2, scanLabel: 'type scan' });
        expect(files).toHaveLength(2);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0][0])).toContain('type scan hit the 2-file ceiling');
    });
});
