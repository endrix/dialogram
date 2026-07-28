/**
 * `createSidecarDiagramProfile` assembles a sidecar-backed diagram profile from
 * one flat product literal. These tests pin the wiring the deleted extension-core
 * adapter used to own: live edits, storage options, chat operation prefix, watch
 * globs, and the openability check being present iff the input requests it.
 */
import { describe, expect, it } from 'vitest';
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
    });

    it('threads the sidecar operation prefix onto the chat carry-over', () => {
        const p = createSidecarDiagramProfile(baseInput({ sidecarOperationPrefix: 'calpy' }));
        expect(p.chat?.operationPrefix).toBe('calpy');
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
            useAlternateEntityPalette: true,
            openability: { probeOp: 'exportNetworkGraph', decoratorName: 'network' }
        }));
        expect(typeof p.canOpenSource).toBe('function');
        expect(p.storageOptions?.useAlternateEntityPalette).toBe(true);
    });

    it('exposes model source, server modules, edit backend, navigation and factories', () => {
        const p = createSidecarDiagramProfile(baseInput());
        expect(typeof p.modelSource).toBe('function');
        expect(Array.isArray(p.serverModules)).toBe(true);
        expect(p.editBackend).toBeDefined();
        expect(p.navigation).toBeDefined();
        expect(typeof p.runDriver).toBe('function');
        expect(typeof p.newSourceFile).toBe('function');
    });

    // --- T7 (GLSP-MCP): registry-tool relocation + profile.mcp default ---

    it('bridges the 5 sidecar-registry READ tools into chat.tools (mutation tools excluded)', () => {
        const p = createSidecarDiagramProfile(baseInput());
        const names = (p.chat?.tools ?? []).map((t) => t.name).sort();
        expect(names).toEqual(
            ['create_task_type', 'list_nodes', 'list_task_types', 'list_workflow_types', 'validate_workflow'].sort()
        );
        // create_node/connect moved to GLSP-MCP built-ins; they must NOT be in chat.tools.
        expect(names).not.toContain('create_node');
        expect(names).not.toContain('connect');
    });

    it('defaults profile.mcp ON (GLSP-MCP opt-in) and honors an explicit override', () => {
        expect(createSidecarDiagramProfile(baseInput()).mcp).toEqual({ enabled: true });
        expect(createSidecarDiagramProfile(baseInput({ mcp: { enabled: false } })).mcp).toEqual({ enabled: false });
    });
});
