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

describe('the sidecar and CLI a profile hands the product', () => {
    const temps: string[] = [];
    const savedConfiguration = workspace.getConfiguration;
    afterEach(() => {
        workspace.getConfiguration = savedConfiguration;
        for (const dir of temps.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A directory of the test's own, with a sidecar `name` whose script is `body` (node). */
    function sidecar(name: string, body: string[]): { dir: string; command: string } {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-host-')));
        temps.push(dir);
        const command = path.join(dir, name);
        fs.writeFileSync(command, ['#!/usr/bin/env node', ...body].join('\n'));
        fs.chmodSync(command, 0o755);
        return { dir, command };
    }

    /** Answers the one request it reads with the op and args it was asked, and where it ran. */
    const ECHO = [
        "let buf = '';",
        "process.stdin.on('data', d => { buf += d; });",
        "process.stdin.on('end', () => {",
        "    const r = JSON.parse(buf);",
        "    console.log(JSON.stringify({ status: 'ok', diagnostic: { op: r.op, args: r.args, cwd: process.cwd() } }));",
        '});'
    ];

    it.skipIf(process.platform === 'win32')('asks the profile’s sidecar one request, the op prefixed, as the diagram’s requests are read', async () => {
        const { dir, command } = sidecar('echo-sidecar', ECHO);
        const p = createSidecarDiagramProfile(baseInput({ sidecarCommandDefault: command }));
        const file = path.join(dir, 'flow.py');
        fs.writeFileSync(file, '');
        expect(await p.externalTool!.query!(file, { op: 'agentSkills', args: { cwd: dir } })).toEqual({
            ok: true,
            response: { status: 'ok', diagnostic: { op: 'wfpy.agentSkills', args: { cwd: dir }, cwd: dir } },
            command,
            cwd: dir
        });
    });

    it.skipIf(process.platform === 'win32')('waits the profile’s graph-load deadline for the file, unless told otherwise', async () => {
        const { dir, command } = sidecar('silent-sidecar', ["process.stdin.resume();", "setInterval(() => undefined, 1000);"]);
        const p = createSidecarDiagramProfile(baseInput({ sidecarCommandDefault: command }));
        const file = path.join(dir, 'flow.py');
        fs.writeFileSync(file, '');
        const scopes: unknown[] = [];
        workspace.getConfiguration = ((_section?: string, scope?: unknown) => {
            scopes.push(scope);
            return { get: <T>(key: string, fallback?: T) => (key === 'graphLoadTimeoutSeconds' ? 1 : fallback) as T };
        }) as typeof workspace.getConfiguration;
        let started = Date.now();
        expect(await p.externalTool!.query!(file, { op: 'agentSkills' })).toMatchObject({ ok: false, failure: 'timeout', command });
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        expect(scopes.some(scope => (scope as { fsPath?: string } | undefined)?.fsPath === file)).toBe(true);
        started = Date.now();
        expect(await p.externalTool!.query!(file, { op: 'agentSkills' }, { timeoutMs: 200 })).toMatchObject({ failure: 'timeout' });
        expect(Date.now() - started).toBeLessThan(900);
    }, 20_000);

    it('gives the run root and the CLI by the run driver’s rules', async () => {
        const { dir } = sidecar('unused', []);
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.mkdirSync(path.join(dir, 'flows'));
        const file = Uri.file(path.join(dir, 'flows', 'main.py')) as any;
        const p = createSidecarDiagramProfile(baseInput());
        expect(await p.externalTool!.resolveRunRoot!(file)).toBe(dir);
        expect(await p.externalTool!.cliInvocation!(file)).toEqual({ cmd: 'wfpy', argsPrefix: [], cwd: dir });
    });

    it('gives a read-only profile with a CLI the run root and the CLI, and no query', () => {
        const p = createSidecarDiagramProfile(baseInput({
            readOnly: true,
            sidecarCommandSettingKey: undefined,
            sidecarCommandDefault: undefined
        }));
        expect(Object.keys(p.externalTool ?? {}).sort()).toEqual(['cliInvocation', 'resolveRunRoot']);
    });
});
