/**
 * `createSidecarDiagramProfile` assembles a sidecar-backed diagram profile from
 * one flat product literal. These tests pin the wiring the deleted extension-core
 * adapter used to own: live edits, storage options, chat operation prefix, watch
 * globs, and the openability check being present iff the input requests it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, workspace } from './vscode-mock';
import {
    createSidecarDiagramProfile,
    type SidecarProfileInput
} from '../src/sidecar-diagram-profile';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config';

const CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: () => 'task',
    classNamePlaceholder: () => 'MyTask',
    sidecarDisplayName: 'Workflow sidecar',
    invalidCapabilitiesResponse: 'invalid caps',
    missingCapabilities: () => 'missing',
    invalidListResponse: () => 'invalid list'
};

const CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

const COMMANDS: SidecarProfileInput['commands'] = Object.fromEntries(
    [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ].map((k) => [k, `pfx.${k}`])
) as SidecarProfileInput['commands'];

function baseInput(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
    return {
        key: 'wfpy',
        displayName: 'WorkflowPy',
        settingsNamespace: 'wfLang',
        customEditorViewType: 'workflow.networkDiagram',
        glspClientId: 'wf.client',
        glspClientName: 'wf',
        commands: COMMANDS,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: 'wfpy-sidecar',
        cliCommandSettingKey: 'wfpyCliCommand',
        cliCommandDefault: 'wfpy',
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file) => ['plan', file, '--format', 'graph', '--best-effort'],
        undoLabelSuffix: ' (wfpy)',
        createNodeStrings: CREATE_NODE_STRINGS,
        createNodeBehavior: CREATE_NODE_BEHAVIOR,
        sourceExtension: '.py',
        mcpEnabledSetting: { section: 'workflow.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'workflow',
        newContainer: { label: 'Workflow', decorator: 'workflow', importLine: 'from wfpy import workflow' },
        identifierNoun: 'Python',
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: 'wfpy', fullName: 'WorkflowPy', skill: 'skill' },
        ...overrides
    };
}

describe('createSidecarDiagramProfile', () => {
    it('carries the neutral identity fields through unchanged', () => {
        const p = createSidecarDiagramProfile(baseInput());
        expect(p).toMatchObject({
            key: 'wfpy',
            settingsNamespace: 'wfLang',
            customEditorViewType: 'workflow.networkDiagram',
            glspClientId: 'wf.client'
        });
    });

    it('produces a LIVE edit strategy with operation modules (not read-only)', () => {
        const p = createSidecarDiagramProfile(baseInput());
        expect(p.edits).not.toBe('read-only');
        expect(Array.isArray((p.edits as { operationModules: unknown[] }).operationModules)).toBe(true);
        expect((p.edits as { operationModules: unknown[] }).operationModules.length).toBeGreaterThan(0);
    });

    it('builds storage options + watch globs from the source extension', () => {
        const p = createSidecarDiagramProfile(baseInput());
        expect(p.storageOptions).toEqual({
            settingsNamespace: 'wfLang',
            operationPrefix: 'wfpy',
            useAlternateEntityPalette: undefined
        });
        expect(p.watch).toEqual({ globs: ['**/*.py'] });
        // The same extension reaches the platform as a declaration, so the
        // open/rename commands filter on it and their warnings name it. Left
        // unset, the platform accepts any file — right for a profile that cannot
        // say what its sources are called, wrong for this builder, which can.
        expect(p.sourceExtensions).toEqual([baseInput().sourceExtension]);
    });

    it('accepts several source extensions, the first being the one new files take', () => {
        // A language with two spellings of its files (`.sv` and `.v`, `.vhd` and
        // `.vhdl`) names them all; the platform filters on every one and the
        // watcher covers every one. The single `sourceExtension` is then ignored,
        // so a shell can leave it at the first for older platforms.
        const p = createSidecarDiagramProfile(baseInput({ sourceExtension: '.sv', sourceExtensions: ['.sv', '.v'] }));
        expect(p.sourceExtensions).toEqual(['.sv', '.v']);
        expect(p.watch).toEqual({ globs: ['**/*.sv', '**/*.v'] });
        // An explicit watch list still wins.
        const explicit = createSidecarDiagramProfile(baseInput({ sourceExtensions: ['.sv', '.v'], watchGlobs: ['**/*.sv', '**/hdl.json'] }));
        expect(explicit.watch).toEqual({ globs: ['**/*.sv', '**/hdl.json'] });
        // Blank entries do not count as an extension.
        expect(createSidecarDiagramProfile(baseInput({ sourceExtensions: [' ', ''] })).sourceExtensions).toEqual(['.py']);
    });

    it('builds the Python navigation provider only for a product that names it, and carries the palette and MIME choices', () => {
        const bare = createSidecarDiagramProfile(baseInput());
        expect(bare.navigation).toBeUndefined();
        expect(bare.chat?.sourceMimeType).toBe('text/plain');
        const python = createSidecarDiagramProfile(baseInput({ navigation: 'python', chat: { name: 'wf', fullName: 'WF', sourceMimeType: 'text/x-python' } }));
        expect(python.navigation).toBeDefined();
        expect(python.chat?.sourceMimeType).toBe('text/x-python');

        const other = createSidecarDiagramProfile(baseInput({
            navigation: 'none',
            platformEntityItems: false,
            entityPaletteItems: [{ elementTypeId: 'node:actor', label: 'Module Instance', description: 'x' }],
            chat: { name: 'hw', fullName: 'HW', sourceMimeType: 'text/x-systemverilog' }
        }));
        expect(other.navigation).toBeUndefined();
        expect(other.chat?.sourceMimeType).toBe('text/x-systemverilog');
        // The deprecated flag is accepted and no longer reaches the server.
        expect(other.storageOptions?.platformEntityItems).toBeUndefined();
        expect(other.storageOptions?.entityPaletteItems?.map(i => i.label)).toEqual(['Module Instance']);
    });

    it('carries the product’s default layout to the server', () => {
        expect(createSidecarDiagramProfile(baseInput()).storageOptions?.defaultLayout).toBeUndefined();
        expect(createSidecarDiagramProfile(baseInput({ defaultLayout: 'free-ports' })).storageOptions?.defaultLayout)
            .toBe('free-ports');
    });

    it('carries the product’s ELK server jar onto the profile', () => {
        expect(createSidecarDiagramProfile(baseInput()).elkServer).toBeUndefined();
        expect(createSidecarDiagramProfile(baseInput({ elkServer: { jar: 'resources/elk.jar' } })).elkServer)
            .toEqual({ jar: 'resources/elk.jar' });
    });

    it('turns on resuming at a step exactly when the product says how', () => {
        const without = createSidecarDiagramProfile(baseInput({ clientBehavior: { noneSentinel: 'x' } }));
        expect((without.clientBehavior as any)?.resumeAtStep).toBeUndefined();

        const withResume = createSidecarDiagramProfile(baseInput({
            clientBehavior: { noneSentinel: 'x' },
            cliResumeArgs: (runDir: string, step: number) => ['--resume-from', runDir, '--at-step', String(step)]
        }));
        // Derived, and the product's own flags kept beside it.
        expect(withResume.clientBehavior).toMatchObject({ noneSentinel: 'x', resumeAtStep: true });
    });

    it('builds no run driver, offers no run or resume, for a product whose CLI has no run', () => {
        const resume = (runDir: string, step: number) => ['--resume-from', runDir, '--at-step', String(step)];
        const runs = createSidecarDiagramProfile(baseInput({ cliResumeArgs: resume }));
        expect(typeof runs.runDriver).toBe('function');
        expect(runs.chat?.tools?.map(t => t.name)).toEqual(expect.arrayContaining(['run_workflow', 'resume_failed_run']));
        // A run starts processes: kept off the auto-approved read-only bridge.
        expect(runs.chat?.tools?.find(t => t.name === 'run_workflow')?.mutates).toBe(true);
        // Inputs only where the plan names them; a run here hands on no others.
        const inputsOf = (profile: typeof runs) =>
            Object.keys((profile.chat?.tools?.find(t => t.name === 'run_workflow')?.inputSchema as any)?.properties ?? {});
        expect(inputsOf(runs)).toContain('inputs');
        expect(inputsOf(createSidecarDiagramProfile(baseInput({ graphAcquisition: 'sidecar-export' } as any)))).not.toContain('inputs');

        const none = createSidecarDiagramProfile(baseInput({ cliRuns: false, cliResumeArgs: resume }));
        expect(none.runDriver).toBeUndefined();
        expect((none.clientBehavior as any)?.resumeAtStep).toBeUndefined();
        expect(none.chat?.tools?.map(t => t.name)).not.toContain('resume_failed_run');
        expect(none.chat?.tools?.map(t => t.name)).not.toContain('run_workflow');
    });

    it('leaves the creation palette alone unless the product suppresses it', () => {
        // Default `true` by omission, so the assembler cannot silently empty the
        // palette of a product that never mentioned it.
        expect(createSidecarDiagramProfile(baseInput()).supportsElementCreation).toBeUndefined();
        expect(
            createSidecarDiagramProfile(baseInput({ supportsElementCreation: false })).supportsElementCreation
        ).toBe(false);
    });

    it('threads the sidecar operation prefix onto the storage options, and no longer onto the chat (nothing read it there)', () => {
        const p = createSidecarDiagramProfile(baseInput({ sidecarOperationPrefix: 'calpy' }));
        expect(p.storageOptions?.operationPrefix).toBe('calpy');
        expect(p.chat?.operationPrefix).toBeUndefined();
    });

    it('omits the openability check when the input requests none (always openable)', () => {
        const p = createSidecarDiagramProfile(baseInput());
        expect(p.canOpenSource).toBeUndefined();
    });

    it('builds an openability check when the input supplies openability', () => {
        const p = createSidecarDiagramProfile(baseInput({
            key: 'calpy',
            sidecarOperationPrefix: 'calpy',
            graphAcquisition: 'sidecar-export',
            openability: { probeOp: 'exportNetworkGraph', decoratorName: 'network' }
        }));
        expect(typeof p.canOpenSource).toBe('function');
    });

    it('exposes model source, server modules, edit backend, navigation and factories', () => {
        const p = createSidecarDiagramProfile(baseInput({ navigation: 'python' }));
        expect(typeof p.modelSource).toBe('function');
        expect(Array.isArray(p.serverModules)).toBe(true);
        expect(p.editBackend).toBeDefined();
        expect(p.navigation).toBeDefined();
        expect(typeof p.runDriver).toBe('function');
        expect(typeof p.newSourceFile).toBe('function');
    });

    // --- T7 (GLSP-MCP): registry-tool relocation + profile.mcp default ---

    it('bridges the 5 sidecar-registry READ tools into chat.tools (mutation tools excluded), beside the run', () => {
        const p = createSidecarDiagramProfile(baseInput());
        const names = (p.chat?.tools ?? []).map((t) => t.name).sort();
        expect(names).toEqual(
            ['get_graph', 'list_nodes', 'list_task_types', 'list_workflow_types', 'validate_workflow', 'run_workflow'].sort()
        );
        // create_node/connect moved to GLSP-MCP built-ins; they must NOT be in chat.tools.
        expect(names).not.toContain('create_node');
        expect(names).not.toContain('connect');
    });

    it('ships profile.mcp ON (the in-host GLSP-MCP server)', () => {
        expect(createSidecarDiagramProfile(baseInput()).mcp).toEqual({ enabled: true });
    });
});

describe('runCli: the product’s CLI, started as a run starts it', () => {
    const temps: string[] = [];
    const savedWorkspace = { ...workspace };
    afterEach(() => {
        Object.assign(workspace, savedWorkspace);
        for (const dir of temps.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A project of the test's own (a `package.json`, so the run root), with a CLI `name` whose script is `body` (node). */
    function project(name: string, body: string[]): { dir: string; command: string; file: any } {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-cli-')));
        temps.push(dir);
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.mkdirSync(path.join(dir, 'flows'));
        fs.writeFileSync(path.join(dir, 'flows', 'main.py'), '');
        const command = path.join(dir, name);
        fs.writeFileSync(command, ['#!/usr/bin/env node', ...body].join('\n'));
        fs.chmodSync(command, 0o755);
        return { dir, command, file: Uri.file(path.join(dir, 'flows', 'main.py')) };
    }

    /** Settings the test gives: `values` by key, the default otherwise. */
    function settings(values: Record<string, unknown>, scopes: unknown[] = []): void {
        workspace.getConfiguration = ((_section?: string, scope?: unknown) => {
            scopes.push(scope);
            return { get: <T>(key: string, fallback?: T) => (key in values ? values[key] : fallback) as T };
        }) as typeof workspace.getConfiguration;
    }

    /** Prints its arguments and where it ran, says something on stderr, exits with the code it is given last. */
    const ECHO = [
        'const args = process.argv.slice(2);',
        'console.log(JSON.stringify({ args, cwd: process.cwd() }));',
        "console.error('said on stderr');",
        'process.exit(Number(args[args.length - 1]) || 0);'
    ];

    it.skipIf(process.platform === 'win32')('runs the command from the run root with the arguments given, and returns what it said', async () => {
        const { dir, command, file } = project('x-cli', ECHO);
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: command }));
        expect(await p.runCli!(file, ['skills', '--json', file.fsPath])).toEqual({
            exitCode: 0,
            stdout: JSON.stringify({ args: ['skills', '--json', file.fsPath], cwd: dir }) + '\n',
            stderr: 'said on stderr\n'
        });
    });

    it.skipIf(process.platform === 'win32')('starts an interpreter with the module form, as a run does', async () => {
        const { dir, command, file } = project('python3', ECHO);
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: command, cliPythonModule: 'wfpy.cli' }));
        const result = await p.runCli!(file, ['skills']);
        expect(JSON.parse(result.stdout)).toEqual({ args: ['-m', 'wfpy.cli', 'skills'], cwd: dir });
    });

    it.skipIf(process.platform === 'win32')('gives an exit other than 0 as the CLI’s answer, not a failure', async () => {
        const { command, file } = project('x-cli', ECHO);
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: command }));
        const result = await p.runCli!(file, ['no-such-subcommand', '2']);
        expect(result).toMatchObject({ exitCode: 2, stderr: 'said on stderr\n' });
        expect(result.failure).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('stops the CLI and all it started at the graph-load deadline for the file, or the one given', async () => {
        // The CLI starts a child that outlives it unless the group is stopped,
        // and says the child's pid; neither ever exits on its own.
        const { dir, command, file } = project('x-cli', [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });",
            "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'child.pid'), String(child.pid));",
            'setInterval(() => undefined, 1000);'
        ]);
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: command }));
        const scopes: unknown[] = [];
        settings({ graphLoadTimeoutSeconds: 1 }, scopes);
        let started = Date.now();
        for (const timeoutMs of [undefined, 0, -5, Number.NaN]) {
            // Not a deadline anyone means: the setting's, not "stop at once".
            started = Date.now();
            expect(await p.runCli!(file, [], { timeoutMs })).toMatchObject({ exitCode: -1, failure: 'timeout' });
            expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        }
        expect(scopes.some(scope => (scope as { fsPath?: string } | undefined)?.fsPath === file.fsPath)).toBe(true);
        started = Date.now();
        const result = await p.runCli!(file, [], { timeoutMs: 200 });
        expect(Date.now() - started).toBeLessThan(900);
        expect(result.message).toContain('no response after');
        const childPid = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
        expect(() => process.kill(childPid, 0)).toThrow();
    }, 30_000);

    it('says why when there is no command, before it looks for the run root', async () => {
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: '' }));
        let looked = false;
        workspace.getWorkspaceFolder = (() => {
            looked = true;
            return undefined;
        }) as typeof workspace.getWorkspaceFolder;
        expect(await p.runCli!(Uri.file('/nowhere/main.py') as any, ['skills'])).toEqual({
            exitCode: -1,
            stdout: '',
            stderr: '',
            failure: 'no-command',
            message: 'Cannot run: wfLang.wfpyCliCommand names no command, and this extension has no default for it.'
        });
        expect(looked).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('says so when the command cannot be started, and never throws', async () => {
        const { dir, file } = project('unused', []);
        const p = createSidecarDiagramProfile(baseInput({ cliCommandDefault: path.join(dir, 'not-there') }));
        expect(await p.runCli!(file, [])).toMatchObject({ exitCode: -1, failure: 'start' });
        workspace.getConfiguration = (() => {
            throw new Error('settings unreadable');
        }) as typeof workspace.getConfiguration;
        expect(await p.runCli!(file, [])).toMatchObject({
            exitCode: -1,
            failure: 'start',
            message: 'The CLI was not started: settings unreadable'
        });
    });

    it('is absent where the CLI runs no diagram', () => {
        expect(createSidecarDiagramProfile(baseInput({ cliRuns: false })).runCli).toBeUndefined();
        expect(createSidecarDiagramProfile(baseInput()).runCli).toBeTypeOf('function');
    });
});
