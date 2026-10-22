/**
 * A read-only, CLI-only profile (`SidecarProfileInput.readOnly`) and openability
 * decided by the product's own predicate (`openability.predicate`).
 *
 * The pins that matter here are negative: with `readOnly`, no sidecar process
 * is ever spawned -- not by the openability check, not by the model source when
 * the plan fails (where the editable path falls back to the sidecar), not by the
 * node-identity lookup, and not by the chat's graph export. The fake sidecar
 * logs every request it receives to `FAKE_SIDECAR_LOG`; the pin is that the log
 * file never comes to exist, while the fake CLI's log shows the plan ran.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as vscodeMock from './vscode-mock';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile';
import { createPredicateOpenabilityCheck } from '../src/diagram-openability';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config';

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.cjs');
const FAKE_SIDECAR = path.join(FIXTURES, 'fake-sidecar.cjs');

const CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: () => 'unit',
    classNamePlaceholder: () => 'MyUnit',
    sidecarDisplayName: 'Doc sidecar',
    invalidCapabilitiesResponse: 'invalid caps',
    missingCapabilities: () => 'missing',
    invalidListResponse: () => 'invalid list'
};

const CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: true,
    mergeProjectDiscoveredTypes: false,
    surfaceSidecarListErrors: true
};

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

/** An editable profile's input, the sidecar being the fake that logs what it is asked. */
function editableInput(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
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
        sidecarCommandDefault: FAKE_SIDECAR,
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: process.execPath,
        acceptedOperationPrefixes: ['doc'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file) => [FAKE_CLI, 'plan', file, '--format', 'graph'],
        undoLabelSuffix: ' (doc)',
        createNodeStrings: CREATE_NODE_STRINGS,
        createNodeBehavior: CREATE_NODE_BEHAVIOR,
        sourceExtension: '.doc.txt',
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
        ...overrides
    };
}

/** The read-only input: the editable one with `readOnly`, the fake sidecar still named so a spawn would show. */
function readOnlyInput(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
    return editableInput({ readOnly: true, supportsElementCreation: true, ...overrides });
}

// The model source does a bare `require('vscode')` at a couple of call sites, which vitest's
// `vscode` alias (ESM-only) does not cover; see characterization-graph-load.test.ts.
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

const tempPaths: string[] = [];
const envKeys = ['FAKE_CLI_LOG', 'FAKE_CLI_FAIL', 'FAKE_SIDECAR_LOG'] as const;
afterEach(() => {
    for (const key of envKeys) {
        delete process.env[key];
    }
    for (const p of tempPaths.splice(0)) {
        fs.rmSync(p, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-profile-'));
    tempPaths.push(dir);
    return dir;
}

/** Point both fakes at log files in `dir`; the sidecar's must never come to exist. */
function armLogs(dir: string): { cliLog: string; sidecarLog: string } {
    const cliLog = path.join(dir, 'cli.log');
    const sidecarLog = path.join(dir, 'sidecar.log');
    process.env.FAKE_CLI_LOG = cliLog;
    process.env.FAKE_SIDECAR_LOG = sidecarLog;
    return { cliLog, sidecarLog };
}

function logLines(file: string): string[] {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : [];
}

describe('createSidecarDiagramProfile with readOnly', () => {
    it('assembles a read-only profile: no edits, no creation, no edit backend, get_graph alone', () => {
        const p = createSidecarDiagramProfile(readOnlyInput());
        expect(p.edits).toBe('read-only');
        // `false` whatever the input says: a projection creates nothing.
        expect(p.supportsElementCreation).toBe(false);
        expect(p.editBackend).toBeUndefined();
        expect((p.chat?.tools ?? []).map((t) => t.name)).toEqual(['get_graph']);
        // The graph context the edit backend would have provided comes from the profile itself.
        expect(typeof p.chat?.graphContextProvider).toBe('function');
        expect(typeof p.modelSource).toBe('function');
        expect(typeof p.canOpenSource).toBe('undefined');
    });

    it('needs no sidecar command, setting or export op', () => {
        const p = createSidecarDiagramProfile(readOnlyInput({
            sidecarCommandSettingKey: undefined,
            sidecarCommandDefault: undefined,
            exportOp: undefined
        }));
        expect(p.edits).toBe('read-only');
        expect((p.chat?.tools ?? []).map((t) => t.name)).toEqual(['get_graph']);
    });

    it('registers the new-file command but neither raw sidecar command', () => {
        const registered: string[] = [];
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id: string) => {
            registered.push(id);
            return { dispose: () => undefined };
        });
        const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;

        createSidecarDiagramProfile(readOnlyInput()).newSourceFile(context);
        expect(registered).toContain(COMMANDS.createNewContainer);
        expect(registered).not.toContain(COMMANDS.sidecarEdit);
        expect(registered).not.toContain(COMMANDS.sidecarSend);

        // The editable profile registers all three, as before.
        registered.splice(0);
        createSidecarDiagramProfile(editableInput()).newSourceFile(context);
        expect(registered).toEqual(expect.arrayContaining([COMMANDS.createNewContainer, COMMANDS.sidecarEdit, COMMANDS.sidecarSend]));
    });

    it('answers get_graph and the graph context from the CLI plan, never the sidecar', async () => {
        const dir = tempDir();
        const { cliLog, sidecarLog } = armLogs(dir);
        const file = path.join(dir, 'unit.doc.txt');
        fs.writeFileSync(file, 'unit one\n');
        const p = createSidecarDiagramProfile(readOnlyInput());

        const text = await p.chat!.tools![0].handler(file, {});
        const parsed = JSON.parse(text);
        expect(parsed.status).toBe('ok');
        expect(parsed.diagnostic.graph.nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
        expect(logLines(cliLog)).toHaveLength(1);
        // The fake logs its argv after the script, so the plan arguments alone.
        expect(JSON.parse(logLines(cliLog)[0])).toEqual(['plan', file, '--format', 'graph']);

        // The scope arg becomes the plan's `--workflow`.
        await p.chat!.tools![0].handler(file, { network: 'sub' });
        expect(JSON.parse(logLines(cliLog)[1])).toEqual(['plan', file, '--format', 'graph', '--workflow', 'sub']);

        const context = await p.chat!.graphContextProvider!(file);
        expect(typeof context).toBe('string');
        expect(JSON.parse(context as string).nodes).toHaveLength(2);
        expect(logLines(cliLog)).toHaveLength(3);

        expect(fs.existsSync(sidecarLog)).toBe(false);
    });

    it('reports a failed plan as a failure document without falling back to the sidecar', async () => {
        const dir = tempDir();
        const { cliLog, sidecarLog } = armLogs(dir);
        process.env.FAKE_CLI_FAIL = '1';
        const file = path.join(dir, 'broken.doc.txt');
        fs.writeFileSync(file, 'unit broken\n');
        const p = createSidecarDiagramProfile(readOnlyInput());
        const source = p.modelSource!();

        const doc = await source.getGraph(`file://${file}`, { requestOptions: {} });
        expect(doc).toBeDefined();
        expect(JSON.stringify(doc)).toContain('CLI plan failed');
        // The CLI was asked; the sidecar, which the editable path would have asked next, was not.
        expect(logLines(cliLog).length).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(sidecarLog)).toBe(false);

        // Node identities, which the editable path asks the sidecar for first, come from the CLI alone.
        delete process.env.FAKE_CLI_FAIL;
        const identities = await source.getNodeIdentities!(`file://${file}`, { requestOptions: { networkName: 'u' } });
        expect(identities?.map((n) => n.instanceName)).toEqual(['n1', 'n2']);
        expect(fs.existsSync(sidecarLog)).toBe(false);
    });

    it('refuses a read-only profile that would need a sidecar, and an editable one that names none', () => {
        expect(() => createSidecarDiagramProfile(readOnlyInput({ graphAcquisition: 'sidecar-export' })))
            .toThrow(/readOnly requires graphAcquisition 'cli-plan'/);
        expect(() => createSidecarDiagramProfile(readOnlyInput({ cliGraphArgs: undefined })))
            .toThrow(/readOnly requires graphAcquisition 'cli-plan'/);
        expect(() => createSidecarDiagramProfile(readOnlyInput({ openability: { probeOp: 'exportGraph' } })))
            .toThrow(/openability\.probeOp/);
        expect(() => createSidecarDiagramProfile(editableInput({ sidecarCommandDefault: undefined })))
            .toThrow(/sidecarCommandSettingKey and sidecarCommandDefault are required/);
        expect(() => createSidecarDiagramProfile(editableInput({ sidecarCommandSettingKey: undefined })))
            .toThrow(/required unless readOnly/);
    });
});

describe('openability by predicate', () => {
    it('decides from the text and the path, calling no sidecar even where a probe is configured', async () => {
        const dir = tempDir();
        const { sidecarLog } = armLogs(dir);
        const yes = path.join(dir, 'drawn.doc.txt');
        const no = path.join(dir, 'plain.doc.txt');
        fs.writeFileSync(yes, '%% diagram\nunit one\n');
        fs.writeFileSync(no, 'unit one\n');
        const predicate = vi.fn((text: string) => text.startsWith('%% diagram'));
        // An editable profile with a probe and a decorator: the predicate still wins.
        const p = createSidecarDiagramProfile(editableInput({
            openability: { probeOp: 'exportGraph', decoratorName: 'diagram', predicate }
        }));

        await expect(p.canOpenSource!(vscode.Uri.file(yes), {})).resolves.toBe(true);
        await expect(p.canOpenSource!(vscode.Uri.file(no), {})).resolves.toBe(false);
        expect(predicate).toHaveBeenCalledTimes(2);
        expect(predicate).toHaveBeenNthCalledWith(1, '%% diagram\nunit one\n', yes);
        expect(predicate).toHaveBeenNthCalledWith(2, 'unit one\n', no);
        expect(fs.existsSync(sidecarLog)).toBe(false);
    });

    it('is the openability a read-only profile may have', async () => {
        const dir = tempDir();
        const { sidecarLog } = armLogs(dir);
        const file = path.join(dir, 'drawn.doc.txt');
        fs.writeFileSync(file, '%% diagram\n');
        const p = createSidecarDiagramProfile(readOnlyInput({
            openability: { predicate: (text) => text.includes('%% diagram') }
        }));
        await expect(p.canOpenSource!(vscode.Uri.file(file), {})).resolves.toBe(true);
        expect(fs.existsSync(sidecarLog)).toBe(false);
    });

    it('refuses the wrong extension, an unreadable file and a throwing predicate before or without asking', async () => {
        const predicate = vi.fn(() => true);
        const check = createPredicateOpenabilityCheck({
            predicate,
            sourceExtension: '.doc.txt',
            readFile: async (p) => {
                if (p.endsWith('missing.doc.txt')) {
                    throw new Error('ENOENT');
                }
                return 'text';
            }
        });
        await expect(check(vscode.Uri.file('/ws/notes.md'), {})).resolves.toBe(false);
        await expect(check(vscode.Uri.parse('untitled:/ws/a.doc.txt'), {})).resolves.toBe(false);
        expect(predicate).not.toHaveBeenCalled();
        await expect(check(vscode.Uri.file('/ws/missing.doc.txt'), {})).resolves.toBe(false);
        expect(predicate).not.toHaveBeenCalled();

        const throwing = createPredicateOpenabilityCheck({
            predicate: () => { throw new Error('boom'); },
            sourceExtension: '.doc.txt',
            readFile: async () => 'text'
        });
        await expect(throwing(vscode.Uri.file('/ws/a.doc.txt'), {})).resolves.toBe(false);

        // Several extensions, any of them accepted.
        const many = createPredicateOpenabilityCheck({
            predicate: (text, file) => text === 'text' && file.endsWith('.v'),
            sourceExtension: '.sv',
            sourceExtensions: ['.sv', '.v'],
            readFile: async () => 'text'
        });
        await expect(many(vscode.Uri.file('/rtl/top.v'), {})).resolves.toBe(true);
        await expect(many(vscode.Uri.file('/rtl/top.sv'), {})).resolves.toBe(false);
    });
});
