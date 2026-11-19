/**
 * Where a run starts (`run-root.ts`): the one rule every start of a
 * product's CLI takes its working directory from (a run, `runCli`, the
 * `cli-plan` graph export, a status source). A file in a workspace folder
 * runs in that folder, never above it; a file outside every folder, or in a
 * window with no folder, runs in its own folder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, openWorkspaceFolders as openFolders, workspace } from './vscode-mock';
import { resolveRunRoot } from '../src/run-root';

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

function runRootOf(file: string): Promise<string> {
    return resolveRunRoot(Uri.file(file) as any);
}

describe('the directory a run starts in', () => {
    it('is the workspace folder that holds the file', async () => {
        const root = tree({ 'folder/.git/HEAD': '', 'folder/flows/main.py': '' });
        openFolders(path.join(root, 'folder'));
        expect(await runRootOf(path.join(root, 'folder', 'flows', 'main.py'))).toBe(path.join(root, 'folder'));
    });

    it('is the workspace folder when a `.git` above it holds it too: never above the folder (a home directory kept in git)', async () => {
        const root = tree({ '.git/HEAD': '', 'project/flows/main.py': '' });
        openFolders(path.join(root, 'project'));
        expect(await runRootOf(path.join(root, 'project', 'flows', 'main.py'))).toBe(path.join(root, 'project'));
    });

    it('is the workspace folder when someone planted markers above it', async () => {
        // A `/tmp/.git` and a `/tmp/package.json` do not move a `/tmp/job` run to `/tmp`.
        const root = tree({ '.git/HEAD': '', 'tmp/package.json': '{}', 'tmp/.git/HEAD': '', 'tmp/job/main.py': '' });
        openFolders(path.join(root, 'tmp', 'job'));
        expect(await runRootOf(path.join(root, 'tmp', 'job', 'main.py'))).toBe(path.join(root, 'tmp', 'job'));
    });

    it('is the workspace folder whatever lies between it and the file: a marker inside never moved a run', async () => {
        // A package of its own, and a submodule, whose `.git` is a file.
        const root = tree({
            'repo/.git/HEAD': '',
            'repo/packages/tool/package.json': '{}',
            'repo/packages/tool/flows/main.py': '',
            'repo/vendor/lib/.git': 'gitdir: ../../.git/modules/lib\n',
            'repo/vendor/lib/main.py': ''
        });
        openFolders(path.join(root, 'repo'));
        expect(await runRootOf(path.join(root, 'repo', 'packages', 'tool', 'flows', 'main.py'))).toBe(path.join(root, 'repo'));
        expect(await runRootOf(path.join(root, 'repo', 'vendor', 'lib', 'main.py'))).toBe(path.join(root, 'repo'));
    });

    it('is the file’s own folder when the file is outside every workspace folder: not the first folder, not a marker above', async () => {
        const root = tree({ '.git/HEAD': '', 'work/.git/HEAD': '', 'elsewhere/package.json': '{}', 'elsewhere/flows/main.py': '' });
        openFolders(path.join(root, 'work'));
        expect(await runRootOf(path.join(root, 'elsewhere', 'flows', 'main.py'))).toBe(path.join(root, 'elsewhere', 'flows'));
    });

    it('is the file’s own folder in a window with no folder open, whatever markers lie above it', async () => {
        const root = tree({ '.git/HEAD': '', 'tmp/.git/HEAD': '', 'tmp/job/main.py': '' });
        expect(await runRootOf(path.join(root, 'tmp', 'job', 'main.py'))).toBe(path.join(root, 'tmp', 'job'));
        // The same without a workspace API answering at all.
        Object.assign(workspace, { workspaceFolders: undefined, getWorkspaceFolder: () => undefined });
        expect(await runRootOf(path.join(root, 'tmp', 'job', 'main.py'))).toBe(path.join(root, 'tmp', 'job'));
    });

    it('is the file’s own folder for a file that is not there, without throwing', async () => {
        const root = tree({});
        openFolders(path.join(root, 'work'));
        expect(await runRootOf(path.join(root, 'gone', 'main.py'))).toBe(path.join(root, 'gone'));
    });
});

describe('the directory a run starts in, in a multi-root workspace', () => {
    it('is the folder that holds the file, not the first one', async () => {
        const root = tree({ '.git/HEAD': '', 'a/.git/HEAD': '', 'b/flows/main.py': '' });
        openFolders(path.join(root, 'a'), path.join(root, 'b'));
        expect(await runRootOf(path.join(root, 'b', 'flows', 'main.py'))).toBe(path.join(root, 'b'));
    });

    it('is the innermost folder when one folder is inside another', async () => {
        const root = tree({ 'repo/.git/HEAD': '', 'repo/sub/flows/main.py': '', 'repo/top.py': '' });
        openFolders(path.join(root, 'repo'), path.join(root, 'repo', 'sub'));
        expect(await runRootOf(path.join(root, 'repo', 'sub', 'flows', 'main.py'))).toBe(path.join(root, 'repo', 'sub'));
        expect(await runRootOf(path.join(root, 'repo', 'top.py'))).toBe(path.join(root, 'repo'));
    });
});

describe.skipIf(process.platform === 'win32')('the directory a run starts in, through symbolic links', () => {
    it('is the workspace folder opened through a link when the file is named by the path the link leads to', async () => {
        // The folder is open as `link`; the file arrives as `real/flows/main.py`
        // (opened from a terminal, or named by a tool that resolves links).
        const root = tree({ '.git/HEAD': '', 'real/flows/main.py': '' });
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
        openFolders(path.join(root, 'link'));
        expect(await runRootOf(path.join(root, 'real', 'flows', 'main.py'))).toBe(path.join(root, 'link'));
    });

    it('is the innermost folder, through links, when folders are inside one another', async () => {
        const root = tree({ '.git/HEAD': '', 'real/sub/main.py': '', 'real/top.py': '' });
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'outer'), 'dir');
        fs.symlinkSync(path.join(root, 'real', 'sub'), path.join(root, 'inner'), 'dir');
        openFolders(path.join(root, 'outer'), path.join(root, 'inner'));
        expect(await runRootOf(path.join(root, 'real', 'sub', 'main.py'))).toBe(path.join(root, 'inner'));
        expect(await runRootOf(path.join(root, 'real', 'top.py'))).toBe(path.join(root, 'outer'));
    });

    it('is the workspace folder for a file named through a link inside it, and the file’s own folder when named by where it lies', async () => {
        // `work/shared` leads out of the folder: VS Code counts a file named
        // through it as the folder's, and the run follows; named by its real
        // path, the file is outside every folder.
        const root = tree({ '.git/HEAD': '', 'work/.git/HEAD': '', 'outside/shared/main.py': '' });
        fs.symlinkSync(path.join(root, 'outside', 'shared'), path.join(root, 'work', 'shared'), 'dir');
        openFolders(path.join(root, 'work'));
        expect(await runRootOf(path.join(root, 'work', 'shared', 'main.py'))).toBe(path.join(root, 'work'));
        expect(await runRootOf(path.join(root, 'outside', 'shared', 'main.py'))).toBe(path.join(root, 'outside', 'shared'));
    });

    it('is not a folder that only a link’s name, not its target, puts the file under', async () => {
        // `work-other` starts with `work` but is not inside it, followed or not.
        const root = tree({ 'work/.git/HEAD': '', 'work-other/main.py': '' });
        openFolders(path.join(root, 'work'));
        expect(await runRootOf(path.join(root, 'work-other', 'main.py'))).toBe(path.join(root, 'work-other'));
    });
});
