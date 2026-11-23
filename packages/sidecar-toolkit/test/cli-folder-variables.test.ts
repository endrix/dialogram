/**
 * The variables a product's settings give its CLI (`cliEnvironment`): a
 * setting that lists folders, read as VS Code reads a path, joined into one
 * variable, and given to every start of the CLI (`sidecar-runtime-config.ts`).
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
    getCliInvocation,
    getCliVariables,
    resolveFolderList
} from '../src/server/sidecar-runtime-config';
import { runCli } from '../src/cli-invocation';
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

/** Settings where `key` of the namespace `x` is `value`, and each other key its default; what was asked, kept. */
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
    it('reads each folder as a VS Code setting path, from the base', () => {
        const base = path.resolve('/work/project');
        expect(resolveFolderList([
            'skills',
            './shared/../shared/skills/',
            '${workspaceFolder}/team',
            '~',
            '~/my-skills',
            '${userHome}/more',
            path.resolve('/opt/skills/./x/..')
        ], base, HOME)).toEqual([
            path.join(base, 'skills'),
            path.join(base, 'shared', 'skills'),
            path.join(base, 'team'),
            HOME,
            path.join(HOME, 'my-skills'),
            path.join(HOME, 'more'),
            path.resolve('/opt/skills')
        ]);
    });

    it('skips blank and non-text entries, and takes a lone string as a list of one', () => {
        const base = path.resolve('/work');
        expect(resolveFolderList(['', '   ', 3, null, ' a '], base, HOME)).toEqual([path.join(base, 'a')]);
        expect(resolveFolderList('a', base, HOME)).toEqual([path.join(base, 'a')]);
        expect(resolveFolderList(undefined, base, HOME)).toEqual([]);
        expect(resolveFolderList({ a: 1 }, base, HOME)).toEqual([]);
    });

    it('with no base, leaves a relative folder for the CLI and drops one naming the workspace folder', () => {
        expect(resolveFolderList(['skills', '${workspaceFolder}/team', '~/s'], undefined, HOME))
            .toEqual(['skills', path.join(HOME, 's')]);
    });
});

describe('the variables a CLI start is given', () => {
    it('are none, and no setting is read, when the profile declares none', () => {
        const asked = settings({ roots: ['skills'] });
        expect(getCliVariables({ settingsNamespace: 'x' }, vscode, Uri.file('/w/a.py') as any)).toEqual({});
        expect(asked).toEqual([]);
    });

    it('join the folders of the file’s folder setting, from its workspace folder, or its own folder outside every folder', () => {
        const folder = path.resolve('/work/project');
        openWorkspaceFolders(folder);
        const asked = settings({ roots: ['skills', path.resolve('/opt/skills')] });
        const inFolder = Uri.file(path.join(folder, 'flows', 'main.py'));
        expect(getCliVariables(config, vscode, inFolder as any))
            .toEqual({ X_ROOTS: [path.join(folder, 'skills'), path.resolve('/opt/skills')].join(path.delimiter) });
        // Read under the product's namespace, scoped to the file: a folder's own setting wins.
        expect(asked.at(-1)).toEqual({ section: 'x', scope: inFolder });
        expect(getCliVariables(config, vscode, Uri.file(path.resolve('/loose/main.py')) as any))
            .toEqual({ X_ROOTS: [path.resolve('/loose/skills'), path.resolve('/opt/skills')].join(path.delimiter) });
    });

    it('leave out a variable whose setting lists nothing', () => {
        settings({ roots: [] });
        expect(getCliVariables(config, vscode, Uri.file('/w/a.py') as any)).toEqual({});
        settings({});
        expect(getCliVariables(config, vscode, Uri.file('/w/a.py') as any)).toEqual({});
    });

    it('come with the invocation only when a setting gives one', () => {
        settings({});
        expect(getCliInvocation(config, vscode, Uri.file('/w/a.py') as any)).toEqual({ cmd: 'x-cli', argsPrefix: [] });
        settings({ roots: [path.resolve('/opt/skills')] });
        expect(getCliInvocation(config, vscode, Uri.file('/w/a.py') as any))
            .toEqual({ cmd: 'x-cli', argsPrefix: [], variables: { X_ROOTS: path.resolve('/opt/skills') } });
    });

    it('go over this extension’s environment, replacing the variable it had; none leaves the environment inherited', () => {
        process.env.X_ROOTS = 'inherited';
        expect(cliProcessEnv(undefined)).toBeUndefined();
        expect(cliProcessEnv({})).toBeUndefined();
        const env = cliProcessEnv({ X_ROOTS: '/a' });
        expect(env?.X_ROOTS).toBe('/a');
        expect(env?.PATH).toBe(process.env.PATH);
        expect(process.env.X_ROOTS).toBe('inherited');
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

    it('the diagram’s plan and the hierarchy export are started with them', async () => {
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
        src.getCliInvocation = () => ({ cmd: process.execPath, argsPrefix: [plan], variables: { X_ROOTS: 'given' } });

        const doc = await src.getGraph(URI.file(top).toString(), { requestOptions: { networkName: 'top' } });
        expect(doc.graph.id).toBe('wf:given');
        expect(JSON.parse(await src.exportHierarchy(top, 'top', dir)).graph.id).toBe('wf:given');
    });
});
