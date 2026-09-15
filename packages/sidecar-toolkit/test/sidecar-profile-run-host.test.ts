// The run driver's host is the platform's, field by field; the human port
// (`askUser`) must be among them, or a running agent's question never reaches
// the chat and the driver prompts through VS Code instead.
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const constructed: Array<{ host: any }> = [];
vi.mock('../src/cli-run-driver.js', () => ({
    CliRunDriver: class {
        constructor(_config: unknown, host: any) {
            constructed.push({ host });
        }
        registerCommands(): void {}
        watchLiveOverlay(): { dispose(): void } { return { dispose: () => {} }; }
        onLiveOverlaySignature(): { dispose(): void } { return { dispose: () => {} }; }
        dispose(): void {}
    }
}));

import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile';

function input(): SidecarProfileInput {
    const commands = Object.fromEntries([
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel', 'renameEntityByName', 'undo', 'redo',
        'fitToScreen', 'center', 'exportSvg', 'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig', 'createAgentToolPolicyFile',
        'chatAddViewerEditor', 'chatAddViewerTask', 'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ].map((k) => [k, `pfx.${k}`])) as SidecarProfileInput['commands'];
    return {
        key: 'p', displayName: 'P', settingsNamespace: 'p', customEditorViewType: 'p.diagram',
        glspClientId: 'p.client', glspClientName: 'p', commands,
        operationKinds: { createEntityPort: 'op.c', deleteEntityPort: 'op.d' },
        sidecarOperationPrefix: 'p', sidecarCommandSettingKey: 'sidecarCommand', sidecarCommandDefault: 'p-sidecar',
        cliCommandSettingKey: 'cliCommand', cliCommandDefault: 'p', acceptedOperationPrefixes: ['p'],
        graphAcquisition: 'cli-plan', cliGraphArgs: (file) => ['plan', file],
        undoLabelSuffix: ' (p)',
        createNodeStrings: {
            newTypeNamePrompt: () => 'n', typeLabel: () => 't', classNamePlaceholder: () => 'c', sidecarDisplayName: 's',
            invalidCapabilitiesResponse: 'i', missingCapabilities: () => 'm', invalidListResponse: () => 'l'
        },
        createNodeBehavior: { capabilityProbeBeforeCreate: false, mergeProjectDiscoveredTypes: true, surfaceSidecarListErrors: false },
        sourceExtension: '.py', exportOp: 'export', mcpEnabledSetting: { section: 'p.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'workflow', newContainer: { label: 'W', decorator: 'workflow', importLine: 'from p import workflow' },
        identifierNoun: 'Python',
        runOutputDirSettingKey: 'runOutputDir', liveExecutionGlowSettingKey: 'glow', agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth', agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs', agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: 'p', fullName: 'P chat' }
    } as SidecarProfileInput;
}

function platformHost(askUser?: (q: unknown, uri: string) => Promise<unknown>) {
    return {
        overlay: { emitEvents: () => {} },
        requestRefresh: () => {},
        output: { appendLine: () => {}, append: () => {}, show: () => {} } as unknown as vscode.OutputChannel,
        useLiveOverlaySignatureSource: () => {},
        askUser
    };
}

describe("the run driver's host", () => {
    const context = { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] } as any;

    it("forwards the platform's askUser, question and diagram alike", async () => {
        constructed.length = 0;
        const asked: Array<[unknown, string]> = [];
        const profile = createSidecarDiagramProfile(input());
        profile.runDriver!(context, platformHost(async (q, uri) => { asked.push([q, uri]); return { answer: 'Allow' }; }) as any);
        const host = constructed[0].host;
        const question = { id: 1, agent: 'ask', question: 'Write /tmp/ask-flow/1-x.txt', choices: ['Allow', 'Reject'] };
        await expect(host.askUser(question, 'file:///w/flow.py')).resolves.toEqual({ answer: 'Allow' });
        expect(asked).toEqual([[question, 'file:///w/flow.py']]);
    });

    it('leaves askUser out when the platform has none, so the driver prompts itself', () => {
        constructed.length = 0;
        createSidecarDiagramProfile(input()).runDriver!(context, platformHost() as any);
        expect(constructed[0].host.askUser).toBeUndefined();
    });
});
