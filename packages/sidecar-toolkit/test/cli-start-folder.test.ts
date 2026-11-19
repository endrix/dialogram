/**
 * Every start of a product's CLI runs in the same folder, the run root
 * (`run-root.ts`): the `cli-plan` graph export (the plan, the hierarchy
 * export, the node identities of a child), the chat's graph from the plan,
 * the status source's reports and `runCli` all start where a run of the file
 * starts. A file in a workspace folder runs in that folder, never at a marker
 * above it; a file outside every folder runs in its own folder.
 *
 * Each start is a real child process (`fixtures/fake-cli.cjs`, which logs the
 * directory it was started in to `FAKE_CLI_CWD_LOG`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import { Uri, openWorkspaceFolders, workspace } from './vscode-mock';
import { createSidecarModelSource } from '../src/server/cli-graph-model-source';
import { type SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.cjs');
const FAKE_STATUS_CLI = path.join(FIXTURES, 'fake-status-cli.cjs');

// The model source does a bare `require('vscode')` for its settings, which
// vitest's `vscode` alias (ESM only) does not cover; see
// characterization-graph-load.test.ts.
let originalModuleLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
beforeAll(() => {
    originalModuleLoad = (Module as any)._load;
    (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalModuleLoad.call(this, request, parent, isMain);
    };
});
afterAll(() => {
    (Module as any)._load = originalModuleLoad;
});

const temps: string[] = [];
const savedWorkspace = { ...workspace };
afterEach(() => {
    delete process.env.FAKE_CLI_CWD_LOG;
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

/**
 * A home directory kept in git with a project in it, open as the only
 * workspace folder, the file two folders down; and a file of the same home
 * outside the project. The CLI logs where it starts.
 */
function homeWithProject(): { home: string; folder: string; file: string; loose: string; starts: () => string[] } {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-start-')));
    temps.push(home);
    fs.mkdirSync(path.join(home, '.git'));
    fs.writeFileSync(path.join(home, 'package.json'), '{}');
    const folder = path.join(home, 'project');
    fs.mkdirSync(path.join(folder, 'flows'), { recursive: true });
    const file = path.join(folder, 'flows', 'main.py');
    fs.writeFileSync(file, '# a workflow\n');
    fs.mkdirSync(path.join(home, 'loose'));
    const loose = path.join(home, 'loose', 'main.py');
    fs.writeFileSync(loose, '# a workflow\n');
    openWorkspaceFolders(folder);
    const log = path.join(home, 'starts.log');
    process.env.FAKE_CLI_CWD_LOG = log;
    const starts = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(line => line !== '') : []);
    return { home, folder, file, loose, starts };
}

/** A `cli-plan` runtime config on the fake CLI, with a hierarchy export, and no sidecar to ask. */
function planCfg(): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: path.join(os.tmpdir(), 'no-such-sidecar'),
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: process.execPath,
        cliPythonModule: undefined,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        ...NEUTRAL_CREATE_NODE_CONFIG,
        acceptedOperationPrefixes: ['wfpy'],
        graphAcquisition: 'cli-plan',
        readOnly: true,
        cliGraphArgs: (file: string) => [FAKE_CLI, 'plan', file, '--format', 'graph'],
        cliHierarchyArgs: (file: string, root: string) => [FAKE_CLI, 'plan', file, '--hierarchy', '--workflow', root]
    };
}

describe('the cli-plan graph export starts the CLI in the run root', () => {
    it('runs the plan in the workspace folder, not at the `.git` above it', async () => {
        const { folder, file, starts } = homeWithProject();
        const source = createSidecarModelSource(planCfg());

        await source.getGraph(Uri.file(file).toString(), { requestOptions: {} });

        expect(starts()).toEqual([folder]);
    });

    it('runs the hierarchy export there too', async () => {
        const { folder, file, starts } = homeWithProject();
        const source = createSidecarModelSource(planCfg());

        // A workflow named: the view is looked for in its hierarchy's export
        // first (the fake answers no hierarchy), then planned on its own.
        await source.getGraph(Uri.file(file).toString(), { requestOptions: { networkName: 'main' } });

        expect(starts()).toEqual([folder, folder]);
    });

    it('runs the plan for a child’s node identities there too', async () => {
        const { folder, file, starts } = homeWithProject();
        const source = createSidecarModelSource(planCfg());

        await source.getNodeIdentities!(Uri.file(file).toString(), { requestOptions: { networkName: 'child' } });

        expect(starts()).toEqual([folder]);
    });

    it('runs the plan of a file outside every workspace folder in the file’s own folder', async () => {
        const { loose, starts } = homeWithProject();
        const source = createSidecarModelSource(planCfg());

        await source.getGraph(Uri.file(loose).toString(), { requestOptions: {} });

        expect(starts()).toEqual([path.dirname(loose)]);
    });
});

const COMMANDS: SidecarProfileInput['commands'] = Object.fromEntries(
    [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ].map((k) => [k, `doc.${k}`])
) as SidecarProfileInput['commands'];

/** A read-only `cli-plan` profile on the fake CLI, with a status source that asks the fake status CLI where it ran. */
function profileInput(seen: unknown[]): SidecarProfileInput {
    return {
        key: 'doc',
        displayName: 'Doc Diagrams',
        settingsNamespace: 'docLang',
        customEditorViewType: 'doc.diagram',
        glspClientId: 'doc.client',
        glspClientName: 'doc',
        commands: COMMANDS,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        sidecarOperationPrefix: 'doc',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: path.join(os.tmpdir(), 'no-such-sidecar'),
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: process.execPath,
        acceptedOperationPrefixes: ['doc'],
        graphAcquisition: 'cli-plan',
        readOnly: true,
        cliGraphArgs: (file) => [FAKE_CLI, 'plan', file, '--format', 'graph'],
        undoLabelSuffix: ' (doc)',
        createNodeStrings: {
            newTypeNamePrompt: () => 'New class name',
            typeLabel: () => 'unit',
            classNamePlaceholder: () => 'MyUnit',
            sidecarDisplayName: 'Doc sidecar',
            invalidCapabilitiesResponse: 'invalid caps',
            missingCapabilities: () => 'missing',
            invalidListResponse: () => 'invalid list'
        },
        createNodeBehavior: { capabilityProbeBeforeCreate: true, mergeProjectDiscoveredTypes: false, surfaceSidecarListErrors: true },
        sourceExtension: '.py',
        mcpEnabledSetting: { section: 'doc.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'unit',
        newContainer: { label: 'Document', decorator: '', importLine: '', template: (name) => `# ${name}\n` },
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: 'doc', fullName: 'Doc Diagrams', sourceMimeType: 'text/plain' },
        statusSource: {
            label: 'Coverage',
            showCommand: 'doc.coverage.show',
            clearCommand: 'doc.coverage.clear',
            collect: async (_file, cli) => {
                seen.push(await cli([FAKE_STATUS_CLI, 'report']));
                return [];
            }
        }
    };
}

describe('every start of the CLI for one file agrees on the folder', () => {
    it('starts the chat’s graph, the status reports and runCli where the plan starts: the workspace folder', async () => {
        const { folder, file, starts } = homeWithProject();
        const seen: Array<{ cwd?: string }> = [];
        const p = createSidecarDiagramProfile(profileInput(seen));

        // The chat's get_graph, from the plan (exportGraphFromCli).
        const answer = JSON.parse(await p.chat!.tools![0].handler(file, {}));
        expect(answer.status).toBe('ok');
        // The model source's plan.
        await p.modelSource!().getGraph(Uri.file(file).toString(), { requestOptions: {} });
        expect(starts()).toEqual([folder, folder]);

        // The status source's report.
        await p.statusSource!.collect(file, { output: { appendLine: () => undefined } });
        expect(seen.map(answer => answer.cwd)).toEqual([folder]);

        // runCli, which says where it started.
        const ran = await p.runCli!(Uri.file(file) as any, [FAKE_CLI, 'plan', file]);
        expect(ran).toMatchObject({ exitCode: 0, cwd: folder });
        expect(starts()).toEqual([folder, folder, folder]);
    });

    it('starts each of them in the file’s own folder when the file is outside every workspace folder', async () => {
        const { loose, starts } = homeWithProject();
        const seen: Array<{ cwd?: string }> = [];
        const p = createSidecarDiagramProfile(profileInput(seen));
        const own = path.dirname(loose);

        expect(JSON.parse(await p.chat!.tools![0].handler(loose, {})).status).toBe('ok');
        await p.modelSource!().getGraph(Uri.file(loose).toString(), { requestOptions: {} });
        await p.statusSource!.collect(loose, { output: { appendLine: () => undefined } });
        expect(await p.runCli!(Uri.file(loose) as any, [FAKE_CLI, 'plan', loose])).toMatchObject({ exitCode: 0, cwd: own });

        expect(starts()).toEqual([own, own, own]);
        expect(seen.map(answer => answer.cwd)).toEqual([own]);
    });
});
