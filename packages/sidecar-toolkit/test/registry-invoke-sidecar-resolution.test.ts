/**
 * Regression: the in-process sidecar-registry READ tools (`list_task_types`,
 * `get_graph`, `validate_workflow`, ...) MUST resolve the sidecar command the
 * SAME way the diagram does. The diagram's edit path resolves via the shared
 * `getSidecarCommand(cfg, vscode, uri)` helper (which normalizes an empty /
 * whitespace setting back to the product default); the registry tools' `invoke`
 * seam historically used its OWN inline `getConfiguration().get() ?? default`
 * reimplementation that did NOT normalize. That divergence let the tools spawn a
 * different (often nonexistent, e.g. a bare `.venv` guess) command and fail with
 * `sidecar-unavailable` in a workspace where the diagram loads and edits fine.
 *
 * This test drives the profile's real registry `invoke` seam and pins that the
 * command it hands to the sidecar transport is IDENTICAL to what the diagram's
 * `getSidecarCommand` resolves — no second resolver, no hardcoded path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror chat-edit-backend.test.ts: replace the sidecar transport so we observe
// the resolved command handed to it WITHOUT spawning a process.
const graphExport = vi.hoisted(() => ({
    invokeSidecarOp: vi.fn(),
    exportWorkflowGraph: vi.fn()
}));
vi.mock('../src/sidecar-graph-export.js', () => graphExport);

import * as vscode from 'vscode';
import {
    createSidecarDiagramProfile,
    type SidecarProfileInput
} from '../src/sidecar-diagram-profile.js';
import { getSidecarCommand, type SidecarRuntimeConfig } from '../src/index.js';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config.js';

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

const SIDECAR_COMMAND_SETTING_KEY = 'wfpySidecarCommand';
const SIDECAR_COMMAND_DEFAULT = 'wfpy-sidecar';
const SETTINGS_NAMESPACE = 'wfLang';

function baseInput(): SidecarProfileInput {
    return {
        key: 'wfpy',
        displayName: 'WorkflowPy',
        settingsNamespace: SETTINGS_NAMESPACE,
        customEditorViewType: 'workflow.networkDiagram',
        glspClientId: 'wf.client',
        glspClientName: 'wf',
        commands: COMMANDS,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: SIDECAR_COMMAND_SETTING_KEY,
        sidecarCommandDefault: SIDECAR_COMMAND_DEFAULT,
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
        chat: { name: 'wfpy', fullName: 'WorkflowPy', skill: 'skill' }
    };
}

/** Minimal runtime config the shared `getSidecarCommand` reads (the diagram side). */
const RUNTIME_CONFIG = {
    settingsNamespace: SETTINGS_NAMESPACE,
    sidecarCommandSettingKey: SIDECAR_COMMAND_SETTING_KEY,
    sidecarCommandDefault: SIDECAR_COMMAND_DEFAULT
} as SidecarRuntimeConfig;

const FILE_PATH = '/ws/streamblocks-mlir/pipeline.py';

const originalGetConfiguration = vscode.workspace.getConfiguration;

/** Force the `<ns>.<key>` setting to a given raw value (present-but-blank exposes the divergence). */
function stubSidecarSetting(rawValue: string | undefined): void {
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
        get: <T>(key: string, defaultValue?: T): T | undefined =>
            key === SIDECAR_COMMAND_SETTING_KEY ? (rawValue as unknown as T) : defaultValue
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    graphExport.invokeSidecarOp.mockResolvedValue({ ok: true, response: {} });
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = originalGetConfiguration;
});

/** Resolve what the registry `invoke` seam actually hands the sidecar transport. */
async function registryResolvedCommand(): Promise<string> {
    const profile = createSidecarDiagramProfile(baseInput());
    const tool = (profile.chat?.tools ?? []).find((t) => t.name === 'list_task_types');
    if (!tool) throw new Error('list_task_types registry tool not assembled');
    await tool.handler(FILE_PATH, {});
    expect(graphExport.invokeSidecarOp).toHaveBeenCalledTimes(1);
    const options = graphExport.invokeSidecarOp.mock.calls[0][1] as { sidecarCommand: string };
    return options.sidecarCommand;
}

describe('registry-tool invoke resolves the sidecar exactly like the diagram', () => {
    it('honors the configured sidecar command (same as the diagram) when set to a PATH command', async () => {
        stubSidecarSetting('wfpy-sidecar');
        const diagramCommand = getSidecarCommand(RUNTIME_CONFIG, vscode, vscode.Uri.file(FILE_PATH));
        expect(await registryResolvedCommand()).toBe(diagramCommand);
    });

    it('normalizes a blank/whitespace setting back to the default — identically to the diagram', async () => {
        // A present-but-blank setting is exactly where the two resolvers diverged: the diagram's
        // `getSidecarCommand` (via `toNonEmptyString`) falls back to the default; the registry's old
        // inline `?? default` leaked the blank string, so the tools spawned the wrong command.
        stubSidecarSetting('   ');
        const diagramCommand = getSidecarCommand(RUNTIME_CONFIG, vscode, vscode.Uri.file(FILE_PATH));
        const registryCommand = await registryResolvedCommand();
        expect(registryCommand).toBe(diagramCommand);
        expect(registryCommand).toBe(SIDECAR_COMMAND_DEFAULT);
        expect(registryCommand.trim()).not.toBe('');
    });

    it('falls back to the default when the setting is unset — identically to the diagram', async () => {
        stubSidecarSetting(undefined);
        const diagramCommand = getSidecarCommand(RUNTIME_CONFIG, vscode, vscode.Uri.file(FILE_PATH));
        expect(await registryResolvedCommand()).toBe(diagramCommand);
    });
});
