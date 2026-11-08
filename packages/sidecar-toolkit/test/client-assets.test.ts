/**
 * A sidecar product can ship its own webview bundle: `clientAssets` on the
 * input is threaded onto the assembled profile unchanged, as data, and its
 * absence leaves the platform serving the stock bundle.
 */
import { describe, expect, it } from 'vitest';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile';

const COMMANDS = Object.fromEntries(
    [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ].map((k) => [k, `pfx.${k}`])
) as SidecarProfileInput['commands'];

function input(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
    return {
        key: 'demo',
        displayName: 'Demo',
        settingsNamespace: 'demo',
        customEditorViewType: 'demo.diagram',
        glspClientId: 'demo.client',
        glspClientName: 'demo',
        commands: COMMANDS,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        sidecarOperationPrefix: 'demo',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: 'demo-sidecar',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'demo',
        acceptedOperationPrefixes: ['demo'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file) => ['plan', file],
        undoLabelSuffix: ' (demo)',
        createNodeStrings: {
            newTypeNamePrompt: () => 'Name',
            typeLabel: () => 'type',
            classNamePlaceholder: () => 'Name',
            sidecarDisplayName: 'Demo sidecar',
            invalidCapabilitiesResponse: 'invalid',
            missingCapabilities: () => 'missing',
            invalidListResponse: () => 'invalid'
        },
        createNodeBehavior: {
            capabilityProbeBeforeCreate: false,
            mergeProjectDiscoveredTypes: false,
            surfaceSidecarListErrors: false
        },
        sourceExtension: '.demo',
        mcpEnabledSetting: { section: 'demo.chat', key: 'enableMcpTools', default: false },
        scopeArgKey: 'unit',
        newContainer: { label: 'Unit', decorator: 'unit', importLine: '' },
        identifierNoun: 'Demo',
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: 'demo', fullName: 'Demo', skill: 'skill' },
        ...overrides
    };
}

describe('a sidecar product’s own webview bundle', () => {
    it('is served when the product names one', () => {
        const clientAssets = {
            scriptPath: '/ext/dist/webview/demo-client.js',
            stylePath: '/ext/dist/webview/demo-client.css',
            localResourceRoots: ['/ext/dist/webview']
        };
        expect(createSidecarDiagramProfile(input({ clientAssets })).clientAssets).toEqual(clientAssets);
    });

    it('leaves the stock bundle in place when the product names none', () => {
        expect(createSidecarDiagramProfile(input()).clientAssets).toBeUndefined();
    });

    it('sits beside the product’s stylesheets, which apply to either bundle', () => {
        const profile = createSidecarDiagramProfile(input({
            clientAssets: { scriptPath: '/ext/demo-client.js' },
            clientStylesheets: ['/ext/demo.css']
        }));
        expect(profile.clientAssets?.scriptPath).toBe('/ext/demo-client.js');
        expect(profile.clientStylesheets).toEqual(['/ext/demo.css']);
    });
});
