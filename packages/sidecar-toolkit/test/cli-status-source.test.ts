/**
 * A status source fed by the product's CLI: what the toolkit does with the
 * commands so the product only has to map their JSON.
 *
 * Pinned here, against a real child process (`fixtures/fake-status-cli.cjs`):
 * which command runs (the configured CLI, the one the diagram is drawn with),
 * where (the run root: the file's workspace folder, the file's own folder
 * outside every folder), that a CLI reporting its own failure in JSON is
 * read rather than thrown away (the product knows what `ok: false` means; a
 * build that has errors may still have written the index a report reads), and
 * that what is not an answer at all -- no such command, no JSON -- rejects
 * with something a person can act on. And that the profile builder hands the
 * platform a status source exactly when the product declares one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkspaceFolders, resetWorkspace } from './vscode-mock';
import type { ExecutionNodeState } from '@dialogram/shared';
import { createCliStatusSource, runCliJson, type SidecarStatusSourceInput } from '../src/cli-status-source';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(here, 'fixtures/fake-status-cli.cjs');

describe('running the CLI for a report', () => {
    it('resolves to what it printed, parsed', async () => {
        const answer = await runCliJson(['report', 'coverage'], { cmd: FAKE_CLI, argsPrefix: [] });

        expect(answer).toMatchObject({ ok: true, args: ['report', 'coverage'] });
    });

    it('puts the configured prefix first, as a module-run CLI needs', async () => {
        const answer = await runCliJson(['report'], { cmd: process.execPath, argsPrefix: [FAKE_CLI] });

        expect(answer).toMatchObject({ args: ['report'] });
    });

    /** `ndf build` exits 1 on a project with errors, says so in JSON, and still writes its index. */
    it('reads a failure the CLI reports in JSON instead of throwing it away', async () => {
        const answer = await runCliJson(['build', '--exit', '1'], { cmd: FAKE_CLI, argsPrefix: [] });

        expect(answer).toMatchObject({ ok: false });
    });

    it('rejects when the command cannot start, saying so', async () => {
        await expect(runCliJson(['report'], { cmd: path.join(os.tmpdir(), 'no-such-report-cli'), argsPrefix: [] }))
            .rejects.toThrow(/failed to start/);
    });

    it('rejects when it prints no JSON, with its stderr when it failed', async () => {
        await expect(runCliJson(['report', '--text'], { cmd: FAKE_CLI, argsPrefix: [] }))
            .rejects.toThrow(/printed no JSON/);
        await expect(runCliJson(['report', '--text', '--exit', '2', '--stderr', 'no index here'], { cmd: FAKE_CLI, argsPrefix: [] }))
            .rejects.toThrow(/no index here/);
    });

    it('logs each command line before it runs', async () => {
        const lines: string[] = [];
        await runCliJson(['report'], { cmd: FAKE_CLI, argsPrefix: [], log: line => lines.push(line) });

        expect(lines).toEqual([`$ ${FAKE_CLI} report`]);
    });
});

/** The runtime config's CLI fields; the test host returns each setting's default. */
const RUNTIME = { settingsNamespace: 'product', cliCommandSettingKey: 'cliCommand', cliCommandDefault: FAKE_CLI } as any;

describe('the status source the platform gets', () => {
    const temps: string[] = [];
    afterEach(() => {
        resetWorkspace();
        for (const dir of temps.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('passes the label and the two commands through, and collect a CLI bound to the file', async () => {
        const seen: unknown[] = [];
        const input: SidecarStatusSourceInput = {
            label: 'Coverage',
            showCommand: 'product.coverage.show',
            clearCommand: 'product.coverage.clear',
            collect: async (file, cli) => {
                seen.push(await cli(['report', file]));
                return [{ nodeId: 'node:a', status: 'succeeded' }];
            }
        };
        const output: string[] = [];
        const source = createCliStatusSource(input, RUNTIME);
        const file = path.join(here, 'fixtures', 'spec.md');

        const states = await source.collect(file, { output: { appendLine: line => output.push(line) } });

        expect(source).toMatchObject({ label: 'Coverage', showCommand: 'product.coverage.show', clearCommand: 'product.coverage.clear' });
        expect(states).toEqual<ExecutionNodeState[]>([{ nodeId: 'node:a', status: 'succeeded' }]);
        // The configured CLI, in the file's folder (it is in no workspace
        // folder), the command line in the output.
        expect(seen).toEqual([{ ok: true, args: ['report', file], cwd: path.join(here, 'fixtures') }]);
        expect(output).toEqual([`$ ${FAKE_CLI} report ${file}`]);
    });

    it('runs the CLI where a run of the file starts: its workspace folder, not its own folder or a `.git` above', async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'status-root-')));
        temps.push(root);
        fs.mkdirSync(path.join(root, '.git'));
        fs.mkdirSync(path.join(root, 'project', 'docs'), { recursive: true });
        const file = path.join(root, 'project', 'docs', 'spec.md');
        fs.writeFileSync(file, '');
        openWorkspaceFolders(path.join(root, 'project'));
        const seen: unknown[] = [];
        const source = createCliStatusSource({
            label: 'Coverage',
            showCommand: 'product.coverage.show',
            clearCommand: 'product.coverage.clear',
            collect: async (f, cli) => {
                seen.push(await cli(['report', f]));
                return [];
            }
        }, RUNTIME);

        await source.collect(file, { output: { appendLine: () => undefined } });

        expect(seen).toEqual([{ ok: true, args: ['report', file], cwd: path.join(root, 'project') }]);
    });

    it('is on the profile exactly when the product declares one', () => {
        const declared = createSidecarDiagramProfile(profileInput({
            statusSource: {
                label: 'Coverage',
                showCommand: 'product.coverage.show',
                clearCommand: 'product.coverage.clear',
                collect: async () => []
            }
        }));
        expect(declared.statusSource).toMatchObject({
            label: 'Coverage',
            showCommand: 'product.coverage.show',
            clearCommand: 'product.coverage.clear'
        });
        expect(typeof declared.statusSource?.collect).toBe('function');

        expect(createSidecarDiagramProfile(profileInput()).statusSource).toBeUndefined();
    });
});

function profileInput(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
    const commandIds = [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel', 'renameEntityByName', 'undo',
        'redo', 'fitToScreen', 'center', 'exportSvg', 'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow',
        'runWorkflow', 'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask', 'sidecarEdit', 'sidecarSend',
        'createNewContainer'
    ];
    return {
        key: 'product',
        displayName: 'Product',
        settingsNamespace: 'product',
        customEditorViewType: 'product.diagram',
        glspClientId: 'product.client',
        glspClientName: 'product',
        commands: Object.fromEntries(commandIds.map(id => [id, `product.${id}`])) as SidecarProfileInput['commands'],
        operationKinds: { createEntityPort: 'product.createEntityPort', deleteEntityPort: 'product.deleteEntityPort' },
        sidecarOperationPrefix: 'product',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: 'product-sidecar',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'product-cli',
        acceptedOperationPrefixes: ['product'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: file => ['plan', file],
        undoLabelSuffix: ' (product)',
        createNodeStrings: {
            newTypeNamePrompt: () => 'Name',
            typeLabel: () => 'type',
            classNamePlaceholder: () => 'Name',
            sidecarDisplayName: 'Product sidecar',
            invalidCapabilitiesResponse: 'invalid',
            missingCapabilities: () => 'missing',
            invalidListResponse: () => 'invalid'
        },
        createNodeBehavior: { capabilityProbeBeforeCreate: false, mergeProjectDiscoveredTypes: false, surfaceSidecarListErrors: true },
        sourceExtension: '.spec',
        mcpEnabledSetting: { section: 'product.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'workflow',
        newContainer: { label: 'Spec', decorator: 'spec', importLine: '' },
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: 'product', fullName: 'Product' },
        ...overrides
    };
}
