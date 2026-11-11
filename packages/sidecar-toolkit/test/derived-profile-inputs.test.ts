/**
 * A product names what is its own; the toolkit derives the rest the way every
 * product spelled it by hand: command ids from the GLSP client name, operation
 * kinds and the raw sidecar commands from the operation prefix, the setting
 * keys and the undo suffix from their one shared spelling.
 */
import { describe, expect, it } from 'vitest';
import {
    createSidecarDiagramProfile,
    resolveSidecarCommandIds,
    resolveSidecarProfileInput,
    type SidecarProfileInput
} from '../src/sidecar-diagram-profile';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config.js';

/** What a Verilog product has to say, and nothing more. */
function minimalInput(overrides: Partial<SidecarProfileInput> = {}): SidecarProfileInput {
    return {
        key: 'sv',
        displayName: 'SystemVerilog IDE',
        settingsNamespace: 'sv',
        customEditorViewType: 'sv.moduleDiagram',
        sidecarOperationPrefix: 'sv',
        sidecarCommandDefault: 'sv-sidecar',
        cliCommandDefault: 'hdl',
        graphAcquisition: 'cli-plan',
        cliGraphArgs: file => ['plan', file],
        sourceExtension: '.sv',
        newContainer: { label: 'Module', decorator: 'module', importLine: '' },
        chat: { fullName: 'SystemVerilog' },
        createNodeStrings: NEUTRAL_CREATE_NODE_CONFIG.createNodeStrings,
        createNodeBehavior: NEUTRAL_CREATE_NODE_CONFIG.createNodeBehavior,
        ...overrides
    };
}

describe('resolveSidecarCommandIds', () => {
    it('derives every id as the products spelled them', () => {
        expect(resolveSidecarCommandIds({ key: 'sv', sidecarOperationPrefix: 'sv' })).toEqual({
            openDiagram: 'sv.glsp.openDiagram',
            openDiagramSplit: 'sv.glsp.openDiagramSplit',
            layoutDiagram: 'sv.glsp.layoutDiagram',
            refreshDiagramModel: 'sv.glsp.refreshDiagramModel',
            renameEntityByName: 'sv.glsp.renameEntityByName',
            undo: 'sv.glsp.undo',
            redo: 'sv.glsp.redo',
            fitToScreen: 'sv.glsp.fitToScreen',
            center: 'sv.glsp.center',
            exportSvg: 'sv.glsp.exportSvg',
            toggleGrid: 'sv.glsp.toggleGrid',
            setQueueTraceVisible: 'sv.glsp.setQueueTraceVisible',
            stopWorkflow: 'sv.glsp.stopWorkflow',
            runWorkflow: 'sv.glsp.runWorkflow',
            layoutDiagramIfNeeded: 'sv.glsp.layoutDiagramIfNeeded',
            setAgentToolConfig: 'sv.glsp.setAgentToolConfig',
            getAgentToolConfig: 'sv.glsp.getAgentToolConfig',
            sidecarEdit: 'sv.sidecar.edit',
            sidecarSend: 'sv.sidecar.send',
            createNewContainer: 'sv.glsp.createNewContainer',
            launch: 'sv.glsp.launch'
        });
    });

    it('takes the GLSP client name for the diagram commands and the operation prefix for the sidecar ones', () => {
        const ids = resolveSidecarCommandIds({ key: 'wfpy', glspClientName: 'workflow', sidecarOperationPrefix: 'wfpy' });
        expect(ids.openDiagram).toBe('workflow.glsp.openDiagram');
        expect(ids.sidecarEdit).toBe('wfpy.sidecar.edit');
    });

    it('keeps the ids the product names and ignores blank ones', () => {
        const ids = resolveSidecarCommandIds({
            key: 'sv',
            sidecarOperationPrefix: 'sv',
            commands: { createNewContainer: 'sv.glsp.createNewModule', undo: ' ' }
        });
        expect(ids.createNewContainer).toBe('sv.glsp.createNewModule');
        expect(ids.undo).toBe('sv.glsp.undo');
    });

    it('leaves a deprecated id a product still spells out of the profile', () => {
        const ids = resolveSidecarCommandIds({
            key: 'sv',
            sidecarOperationPrefix: 'sv',
            commands: { createAgentToolPolicyFile: 'sv.glsp.createAgentToolPolicyFile', chatAddViewerEditor: 'x', chatAddViewerTask: 'y' }
        });
        expect(ids).not.toHaveProperty('createAgentToolPolicyFile');
        expect(ids).not.toHaveProperty('chatAddViewerEditor');
        expect(ids).not.toHaveProperty('chatAddViewerTask');
    });

    it('derives from the key when the GLSP client name is blank', () => {
        const ids = resolveSidecarCommandIds({ key: 'sv', glspClientName: '  ', sidecarOperationPrefix: 'sv' });
        expect(ids.openDiagram).toBe('sv.glsp.openDiagram');
        expect(resolveSidecarProfileInput(minimalInput({ glspClientName: '', glspClientId: ' ' })).glspClientId).toBe('glsp.sv');
    });
});

describe('resolveSidecarProfileInput', () => {
    it('fills the derivable fields from the key and the operation prefix', () => {
        const resolved = resolveSidecarProfileInput(minimalInput());
        expect(resolved.glspClientName).toBe('sv');
        expect(resolved.glspClientId).toBe('glsp.sv');
        expect(resolved.operationKinds).toEqual({ createEntityPort: 'sv.createEntityPort', deleteEntityPort: 'sv.deleteEntityPort' });
        expect(resolved.acceptedOperationPrefixes).toEqual(['sv']);
        expect(resolved.sidecarCommandSettingKey).toBe('sidecarCommand');
        expect(resolved.cliCommandSettingKey).toBe('cliCommand');
        expect(resolved.undoLabelSuffix).toBe(' (sv)');
        expect(resolved.scopeArgKey).toBe('workflow');
        expect(resolved.runOutputDirSettingKey).toBe('runOutputDir');
        expect(resolved.liveExecutionGlowSettingKey).toBe('liveExecutionGlow');
        expect(resolved.agentToolsSettingKey).toBe('agentTools');
        expect(resolved.agentToolAuthSettingKey).toBe('agentToolAuth');
        expect(resolved.agentToolPolicySettingKey).toBe('agentToolPolicy');
        expect(resolved.agentToolTimeoutMsSettingKey).toBe('agentToolTimeoutMs');
        expect(resolved.agentToolRegistrySettingKey).toBe('agentToolRegistry');
        expect(resolved.agentMcpBridgeCmdSettingKey).toBe('agentMcpBridgeCmd');
    });

    it('leaves the sidecar setting key out when there is no sidecar to name', () => {
        const resolved = resolveSidecarProfileInput(minimalInput({ readOnly: true, sidecarCommandDefault: undefined }));
        expect(resolved.sidecarCommandSettingKey).toBeUndefined();
    });

    it('lets every given value win', () => {
        const resolved = resolveSidecarProfileInput(minimalInput({
            glspClientName: 'workflow',
            glspClientId: 'glsp.custom',
            operationKinds: { createEntityPort: 'x.create', deleteEntityPort: 'x.delete' },
            acceptedOperationPrefixes: ['wfpy', 'calpy'],
            undoLabelSuffix: ' (custom)',
            cliCommandSettingKey: 'cli',
            runOutputDirSettingKey: 'outDir'
        }));
        expect(resolved.glspClientId).toBe('glsp.custom');
        expect(resolved.commands.openDiagram).toBe('workflow.glsp.openDiagram');
        expect(resolved.operationKinds.createEntityPort).toBe('x.create');
        expect(resolved.acceptedOperationPrefixes).toEqual(['wfpy', 'calpy']);
        expect(resolved.undoLabelSuffix).toBe(' (custom)');
        expect(resolved.cliCommandSettingKey).toBe('cli');
        expect(resolved.runOutputDirSettingKey).toBe('outDir');
    });
});

describe('createSidecarDiagramProfile from a minimal input', () => {
    it('assembles a profile whose ids are the derived ones', () => {
        const profile = createSidecarDiagramProfile(minimalInput());
        expect(profile.commands.openDiagram).toBe('sv.glsp.openDiagram');
        expect(profile.commands.createNewContainer).toBe('sv.glsp.createNewContainer');
        expect(profile.glspClientId).toBe('glsp.sv');
        expect(profile.glspClientName).toBe('sv');
        expect(profile.operationKinds).toEqual({ createEntityPort: 'sv.createEntityPort', deleteEntityPort: 'sv.deleteEntityPort' });
    });

    it('passes the chat on without the fields nothing reads', () => {
        const profile = createSidecarDiagramProfile(minimalInput({ chat: { name: 'legacy', fullName: 'SystemVerilog' } }));
        expect(profile.chat?.fullName).toBe('SystemVerilog');
        expect((profile.chat as any).name).toBeUndefined();
        expect((profile.chat as any).operationPrefix).toBeUndefined();
    });
});
