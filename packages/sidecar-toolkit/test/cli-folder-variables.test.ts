/**
 * The variables a product's settings give its CLI (`cliEnvironment`): a
 * setting that lists folders, read as VS Code reads a path, from the folder
 * the CLI starts in (the run root), joined into one variable, and given to
 * every start of the CLI (`sidecar-runtime-config.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { Uri, openWorkspaceFolders, resetWorkspace, workspace } from './vscode-mock';
import {
    cliProcessEnv,
    getCliVariables,
    resolveFolderList,
    type FolderListContext
} from '../src/server/sidecar-runtime-config';
import { resolveCliInvocation, runCli } from '../src/cli-invocation';
import { runCliJson } from '../src/cli-status-source';
import { exportGraphFromCli } from '../src/cli-graph-export';
import { spawnWorkflowProcess } from '../src/process-control';
import { CliGraphModelSource } from '../src/server/cli-graph-model-source';
import * as vscode from 'vscode';

const HOME = path.resolve('/home/someone');
const temps: string[] = [];

afterEach(() => {
    resetWorkspace();
    delete process.env.X_ROOTS;
    for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** A new empty directory, resolved. */
function tempDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    temps.push(dir);
    return dir;
}

/** Settings where each key of `values` is that value, and each other key its default; what was asked, kept. */
function settings(values: Record<string, unknown>): Array<{ section?: string; scope?: unknown }> {
    const asked: Array<{ section?: string; scope?: unknown }> = [];
    Object.assign(workspace, {
        getConfiguration: (section?: string, scope?: unknown) => {
            asked.push({ section, scope });
            return { get: <T>(key: string, fallback?: T) => (key in values ? values[key] as T : fallback) };
        }
    });
    return asked;
}

/** A script `node` runs that prints the variable `X_ROOTS`, or `-` when it is unset. */
const PRINT_ROOTS = "process.stdout.write(process.env.X_ROOTS ?? '-')";

const config = {
    settingsNamespace: 'x',
    cliCommandSettingKey: 'cliCommand',
    cliCommandDefault: 'x-cli',
    cliEnvironment: [{ variable: 'X_ROOTS', folderListSettingKey: 'roots' }]
};

describe('a folder-list setting', () => {
    const base = path.resolve('/work/project');
    const context = (more: Partial<FolderListContext> = {}): FolderListContext => ({
        base,
        home: HOME,
        folderNamed: name => (name === 'shared' ? path.resolve('/work/shared') : undefined),
        env: { SKILLS_HOME: path.resolve('/opt/team') },
        ...more
    });

    it('reads each folder as a VS Code setting path, a relative one from the base', () => {
        expect(resolveFolderList([
            'skills',
            './shared/../shared/skills/',
            '${workspaceFolder}/team',
            '${workspaceFolder:shared}/skills',
            '${env:SKILLS_HOME}/skills',
            '~',
            '~/my-skills',
            '${userHome}/more',
            path.resolve('/opt/skills/./x/..')
        ], context())).toEqual([
            path.join(base, 'skills'),
            path.join(base, 'shared', 'skills'),
            path.join(base, 'team'),
            path.resolve('/work/shared/skills'),
            path.resolve('/opt/team/skills'),
            HOME,
            path.join(HOME, 'my-skills'),
            path.join(HOME, 'more'),
            path.resolve('/opt/skills')
        ]);
    });

    it('skips blank and non-text entries, and takes a lone string as a list of one', () => {
        expect(resolveFolderList(['', '   ', 3, null, ' a '], context())).toEqual([path.join(base, 'a')]);
        expect(resolveFolderList('a', context())).toEqual([path.join(base, 'a')]);
        expect(resolveFolderList(undefined, context())).toEqual([]);
        expect(resolveFolderList({ a: 1 }, context())).toEqual([]);
    });

    it('leaves out, saying so, what it cannot read: another user’s home, an unknown variable or folder, an unset variable', () => {
        const leftOut: string[] = [];
        const separated = path.resolve(`/data/a${path.delimiter}b`);
        expect(resolveFolderList(
            ['~nobody/skills', '${config:x.y}/skills', '${workspaceFolder:nope}/skills', '${env:NOT_SET_HERE}/skills', separated, 'kept'],
            context({ env: { SKILLS_HOME: path.resolve('/opt/team'), EMPTY: '' } }),
            entry => leftOut.push(entry)
        )).toEqual([path.join(base, 'kept')]);
        // An unset variable is not the root folder it would leave, and a folder holding the separator would be read as two.
        expect(leftOut).toEqual(['~nobody/skills', '${config:x.y}/skills', '${workspaceFolder:nope}/skills', '${env:NOT_SET_HERE}/skills', separated]);
        expect(resolveFolderList(['${env:EMPTY}/skills'], context({ env: { EMPTY: '' } }))).toEqual([]);
    });

    it('with no base, keeps a relative folder for the CLI and leaves out one naming the workspace folder', () => {
        const leftOut: string[] = [];
        expect(resolveFolderList(['skills', '${workspaceFolder}/team', '~/s'], context({ base: undefined }), entry => leftOut.push(entry)))
            .toEqual(['skills', path.join(HOME, 's')]);
        expect(leftOut).toEqual(['${workspaceFolder}/team']);
    });
});

describe('the variables a CLI start is given', () => {
    it('are none, and no setting is read, when the profile declares none', () => {
        const asked = settings({ roots: ['skills'] });
        expect(getCliVariables({ settingsNamespace: 'x' }, vscode, Uri.file('/w/a.py') as any, '/w')).toEqual({});
        expect(asked).toEqual([]);
    });

    it('join the folders of the file’s setting, a relative one from the run root, naming the setting of one left out', () => {
        const asked = settings({ roots: ['skills', path.resolve('/opt/skills'), '${nope}'] });
        const file = Uri.file(path.resolve('/work/flows/main.py'));
        const leftOut: string[] = [];
        expect(getCliVariables(config, vscode, file as any, path.resolve('/work'), message => leftOut.push(message)))
            .toEqual({ X_ROOTS: [path.resolve('/work/skills'), path.resolve('/opt/skills')].join(path.delimiter) });
        // Read under the product's namespace, for the run root: its folder's own setting wins.
        expect(asked).toEqual([{ section: 'x', scope: Uri.file(path.resolve('/work')) }]);
        expect(leftOut).toEqual([expect.stringMatching(/^x\.roots: '\$\{nope\}' is left out/)]);
    });

    it('leave out a variable whose setting lists nothing', () => {
        settings({ roots: [] });
        expect(getCliVariables(config, vscode, Uri.file('/w/a.py') as any, '/w')).toEqual({});
        settings({});
        expect(getCliVariables(config, vscode, Uri.file('/w/a.py') as any, '/w')).toEqual({});
    });

    it('are read from the folder the CLI starts in, also for a file named through a link to the workspace folder', async () => {
        const root = tempDir('cli-vars-link-');
        const work = path.join(root, 'work');
        fs.mkdirSync(path.join(work, 'flows'), { recursive: true });
        fs.writeFileSync(path.join(work, 'flows', 'main.py'), '');
        try {
            fs.symlinkSync(work, path.join(root, 'link-to-work'), 'dir');
        } catch {
            return; // no symlink privilege (Windows)
        }
        openWorkspaceFolders(work);
        // The folder's own setting, as VS Code reads one: for a resource in the folder only.
        Object.assign(workspace, {
            getConfiguration: (_section?: string, scope?: { fsPath?: string }) => ({
                get: <T>(key: string, fallback?: T) =>
                    (key === 'roots' && scope?.fsPath !== undefined && (scope.fsPath === work || scope.fsPath.startsWith(work + path.sep))
                        ? ['skills'] as T : fallback)
            })
        });
        // VS Code says the file is in no folder; the run root follows the link, and its setting is read.
        const cli = await resolveCliInvocation(config, Uri.file(path.join(root, 'link-to-work', 'flows', 'main.py')) as any);
        expect(cli).toMatchObject({ cwd: work, variables: { X_ROOTS: path.join(work, 'skills') } });
    });

    it('go over this extension’s environment, replacing the variable it had; none leaves the environment inherited', () => {
        expect(cliProcessEnv(undefined)).toBeUndefined();
        expect(cliProcessEnv({})).toBeUndefined();
        const inherited = { PATH: '/bin', X_ROOTS: 'inherited' };
        expect(cliProcessEnv({ X_ROOTS: '/a' }, inherited, 'linux')).toEqual({ PATH: '/bin', X_ROOTS: '/a' });
        expect(inherited.X_ROOTS).toBe('inherited');
    });

    it('on Windows replace the variable of any case, which Windows reads as the same', () => {
        const inherited = { Path: 'C:\\bin', x_roots: 'C:\\old' };
        expect(cliProcessEnv({ X_ROOTS: 'C:\\new' }, inherited, 'win32')).toEqual({ Path: 'C:\\bin', X_ROOTS: 'C:\\new' });
        // Elsewhere the two names are two variables.
        expect(cliProcessEnv({ X_ROOTS: '/new' }, { x_roots: '/old' }, 'linux')).toEqual({ x_roots: '/old', X_ROOTS: '/new' });
    });
});

describe('every start of the CLI', () => {
    it('`runCli` starts the CLI with them, and says which it gave', async () => {
        const folder = tempDir('cli-vars-');
        openWorkspaceFolders(folder);
        const file = Uri.file(path.join(folder, 'main.py'));
        process.env.X_ROOTS = 'inherited';
        settings({ cliCommand: process.execPath, roots: ['skills'] });
        const given = await runCli(config as any, file as any, ['-e', PRINT_ROOTS]);
        expect(given).toMatchObject({ exitCode: 0, stdout: path.join(folder, 'skills'), variables: { X_ROOTS: path.join(folder, 'skills') } });
        // Nothing listed: the variable the extension was started with goes through.
        settings({ cliCommand: process.execPath, roots: [] });
        const inherited = await runCli(config as any, file as any, ['-e', PRINT_ROOTS]);
        expect(inherited.stdout).toBe('inherited');
        expect(inherited.variables).toBeUndefined();
    });

    it('a run is spawned with the environment it is handed', () => {
        const spawnProcess = vi.fn(() => ({}) as cp.ChildProcessWithoutNullStreams);
        const env = { X_ROOTS: '/a' };
        spawnWorkflowProcess({ cmd: 'x-cli', args: ['run'], cwd: '/tmp', env }, spawnProcess);
        expect(spawnProcess).toHaveBeenCalledWith('x-cli', ['run'], expect.objectContaining({ env }));
    });

    it('a status source’s command and the chat’s graph are started with them', async () => {
        const json = await runCliJson([], {
            cmd: process.execPath,
            argsPrefix: ['-e', 'process.stdout.write(JSON.stringify(process.env.X_ROOTS))'],
            variables: { X_ROOTS: '/a' }
        });
        expect(json).toBe('/a');
        const exported = await exportGraphFromCli('/w/a.py', {
            cmd: process.execPath,
            argsPrefix: ['-e', 'process.stdout.write(JSON.stringify({ graph: { id: process.env.X_ROOTS } }))'],
            cliGraphArgs: () => [],
            variables: { X_ROOTS: '/a' }
        });
        expect(exported).toMatchObject({ ok: true, response: { diagnostic: { graph: { id: '/a' } } } });
    });

    it('the diagram’s plan is started with them, from its run root, and planned again when they change; so is the hierarchy export', async () => {
        const dir = tempDir('cli-vars-plan-');
        const top = path.join(dir, 'top.py');
        fs.writeFileSync(top, '@workflow\ndef top():\n    pass\n');
        const plan = path.join(dir, 'plan.cjs');
        fs.writeFileSync(plan, "process.stdout.write(JSON.stringify({ version: '1', graph: { id: 'wf:' + process.env.X_ROOTS, nodes: [], edges: [] } }));");
        const fallback: any = { analysis: { pickDefaultWorkflowName: () => 'top' }, attachDiagnostics: (d: unknown) => d };
        const src: any = new CliGraphModelSource({
            cliCommandDefault: 'runtime',
            cliGraphArgs: () => [],
            cliHierarchyArgs: () => []
        } as any, fallback);
        src.getCliInvocation = () => ({ cmd: process.execPath, argsPrefix: [plan] });
        let roots = 'first';
        const asked: Array<{ file: string; cwd: string }> = [];
        src.cliVariables = (file: string, cwd: string) => {
            asked.push({ file, cwd });
            return { X_ROOTS: roots };
        };
        const load = async () => (await src.getGraph(URI.file(top).toString(), { requestOptions: { networkName: 'top' } })).graph.id;

        expect(await load()).toBe('wf:first');
        expect(asked[0]).toEqual({ file: top, cwd: dir });
        roots = 'second';
        // A plan kept from other variables is not this one.
        expect(await load()).toBe('wf:second');
        expect(JSON.parse(await src.exportHierarchy(top, 'top', dir, { X_ROOTS: 'given' })).graph.id).toBe('wf:given');
    });
});
