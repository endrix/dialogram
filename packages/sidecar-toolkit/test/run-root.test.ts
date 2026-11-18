/**
 * Where a run starts and with which command (`run-root.ts`): the run driver's
 * rules, which `runCli` starts a product's CLI by too. They are the toolkit's
 * own; these tests hold the run driver to what it did before they moved here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, workspace } from './vscode-mock';
import { resolveCliInvocation, resolveRunRoot } from '../src/run-root';

const temps: string[] = [];
const savedWorkspace = { ...workspace };

afterEach(() => {
    for (const key of Object.keys(workspace)) {
        if (!(key in savedWorkspace)) {
            delete (workspace as Record<string, unknown>)[key];
        }
    }
    Object.assign(workspace, savedWorkspace);
    for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** A directory with `files` (path → content), resolved. */
function tree(files: Record<string, string>): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-root-')));
    temps.push(root);
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

describe('the directory a run starts in', () => {
    it('is the nearest directory above the file holding a package.json or a .git, without a workspace', async () => {
        const root = tree({ 'package.json': '{}', 'flows/inner/main.py': '' });
        expect(await resolveRunRoot(Uri.file(path.join(root, 'flows', 'inner', 'main.py')) as any)).toBe(root);
        const repo = tree({ 'flows/main.py': '' });
        fs.mkdirSync(path.join(repo, '.git'));
        expect(await resolveRunRoot(Uri.file(path.join(repo, 'flows', 'main.py')) as any)).toBe(repo);
    });

    it('starts from the file’s workspace folder, the first one when it is in none', async () => {
        const root = tree({ 'work/.git/HEAD': '', 'elsewhere/flows/main.py': '' });
        Object.assign(workspace, {
            getWorkspaceFolder: () => undefined,
            workspaceFolders: [{ uri: Uri.file(path.join(root, 'work')) }]
        });
        expect(await resolveRunRoot(Uri.file(path.join(root, 'elsewhere', 'flows', 'main.py')) as any)).toBe(path.join(root, 'work'));
    });

    it('is the workspace folder when it holds a package.json or a .git', async () => {
        const root = tree({ '.git/HEAD': '', 'folder/package.json': '{}', 'folder/flows/main.py': '' });
        Object.assign(workspace, { getWorkspaceFolder: () => ({ uri: Uri.file(path.join(root, 'folder')) }) });
        expect(await resolveRunRoot(Uri.file(path.join(root, 'folder', 'flows', 'main.py')) as any)).toBe(path.join(root, 'folder'));
    });

    it('climbs above a workspace folder that holds neither, to the nearest directory that does', async () => {
        // As the run driver always has: a `.git` above the workspace folder (a
        // home directory kept in git, say) is where a run of a file in it starts.
        const root = tree({ '.git/HEAD': '', 'folder/flows/main.py': '' });
        Object.assign(workspace, { getWorkspaceFolder: () => ({ uri: Uri.file(path.join(root, 'folder')) }) });
        expect(await resolveRunRoot(Uri.file(path.join(root, 'folder', 'flows', 'main.py')) as any)).toBe(root);
    });
});

describe('the CLI a run starts', () => {
    const config = { settingsNamespace: 'x', cliCommandSettingKey: 'cliCommand', cliCommandDefault: 'x-cli', cliPythonModule: 'x.cli' };

    it('is the setting’s command from the run root, `-m <module>` for an interpreter and a Python source only', async () => {
        const root = tree({ 'package.json': '{}', 'flows/main.py': '', 'flows/main.cal': '' });
        expect(await resolveCliInvocation(config, Uri.file(path.join(root, 'flows', 'main.py')) as any))
            .toEqual({ cmd: 'x-cli', argsPrefix: [], cwd: root });
        let configured = '/venv/bin/python3';
        Object.assign(workspace, {
            getConfiguration: () => ({ get: <T>(_key: string, _fallback?: T) => configured as unknown as T })
        });
        expect(await resolveCliInvocation(config, Uri.file(path.join(root, 'flows', 'main.py')) as any))
            .toEqual({ cmd: '/venv/bin/python3', argsPrefix: ['-m', 'x.cli'], cwd: root });
        expect(await resolveCliInvocation(config, Uri.file(path.join(root, 'flows', 'main.cal')) as any))
            .toEqual({ cmd: '/venv/bin/python3', argsPrefix: [], cwd: root });
        // Blank is the default, as everywhere the command is read.
        configured = '  ';
        expect((await resolveCliInvocation(config, Uri.file(path.join(root, 'flows', 'main.py')) as any))?.cmd).toBe('x-cli');
    });

    it('is none when the setting and the default are blank, found before the run root is looked for', async () => {
        let looked = false;
        Object.assign(workspace, {
            getWorkspaceFolder: () => {
                looked = true;
                return undefined;
            }
        });
        expect(await resolveCliInvocation({ ...config, cliCommandDefault: '' }, Uri.file('/nowhere/main.py') as any)).toBeUndefined();
        expect(looked).toBe(false);
    });
});
