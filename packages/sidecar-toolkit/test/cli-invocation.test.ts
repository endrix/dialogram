/**
 * Which command a run starts, and where (`cli-invocation.ts`): the run
 * driver's rule, which `runCli` starts a product's CLI by too. It is the
 * toolkit's own; the folder is the run root (`run-root.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, openWorkspaceFolders, workspace } from './vscode-mock';
import { resolveCliInvocation } from '../src/cli-invocation';

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

describe('the CLI a run starts', () => {
    const config = { settingsNamespace: 'x', cliCommandSettingKey: 'cliCommand', cliCommandDefault: 'x-cli', cliPythonModule: 'x.cli' };

    it('is the setting’s command from the run root, `-m <module>` for an interpreter and a Python source only', async () => {
        const root = tree({ 'package.json': '{}', 'flows/main.py': '', 'flows/main.cal': '' });
        openWorkspaceFolders(root);
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

    it('starts in the file’s workspace folder, not at a marker above it, and in the file’s own folder outside every folder', async () => {
        const root = tree({ '.git/HEAD': '', 'project/flows/main.py': '', 'loose/main.py': '' });
        openWorkspaceFolders(path.join(root, 'project'));
        expect((await resolveCliInvocation(config, Uri.file(path.join(root, 'project', 'flows', 'main.py')) as any))?.cwd)
            .toBe(path.join(root, 'project'));
        expect((await resolveCliInvocation(config, Uri.file(path.join(root, 'loose', 'main.py')) as any))?.cwd)
            .toBe(path.join(root, 'loose'));
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
