/**
 * The chat's context by reference: no file attached, a graph summary of one
 * line per node with its file and line, a selected node as where to read it.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSourceReferenceContext, selectionBlocks, summarizeGraph } from '../src/chat-source-reference';
import { createSidecarDiagramProfile } from '../src/sidecar-diagram-profile';

const OWN = '/w/top.sv';
const payload = {
    network: 'top',
    nodes: [
        { id: 'node:wf:input:x', label: 'x', kind: 'wf-input', location: { file: OWN, line: 20 } },
        { id: 'node:scope:root:u_add', label: 'u_add', kind: 'instance', type: 'adder', location: { line: 25 },
            metadata: { referencedEntityName: 'adder', referencedSource: { file: '/w/adder.sv', line: 2 } } },
        { id: 'node:scope:root:u_ip', label: 'u_ip', kind: 'instance', type: 'vendor_ip', location: { file: OWN, line: 30 },
            metadata: { referencedEntityName: 'vendor_ip', external: true } },
        { id: 'node:scope:root:g0', label: 'a + b', kind: 'logic', type: 'expression', location: { file: OWN, line: 31 } }
    ],
    edges: [{}, {}, {}]
};

describe('the graph summary', () => {
    it('is a line per node with what it is and where to read it', () => {
        const text = summarizeGraph(payload, OWN);
        expect(text).toContain('Structure of top: 4 nodes, 3 edges');
        expect(text).toContain('- x: input port, at /w/top.sv:20');
        expect(text).toContain('- u_add: instance of adder, at /w/top.sv:25, defined at /w/adder.sv:2');
        expect(text).toContain('- u_ip: blackbox instance of vendor_ip, at /w/top.sv:30');
        expect(text).toContain('- a + b: logic (expression), at /w/top.sv:31');
        expect(text).not.toContain('"nodes"');
    });

    it('caps the lines and says how many more', () => {
        const many = { network: 'big', nodes: Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, kind: 'instance', type: 't' })), edges: [] };
        const text = summarizeGraph(many, OWN, 60);
        expect(text.split('\n').filter(l => l.startsWith('- n')).length).toBe(60);
        expect(text).toContain('... and 10 more; get_graph lists them all.');
    });
});

describe('the selection', () => {
    it('names each selected node with where to read it, and links the files', () => {
        const blocks: any[] = selectionBlocks(payload, OWN, ['node:scope:root:u_add', 'node:zz:unknown'], 'text/x-systemverilog');
        expect(blocks[0].type).toBe('text');
        expect(blocks[0].text).toContain('2 node(s) selected');
        expect(blocks[0].text).toContain('- u_add: instance of adder, at /w/top.sv:25, defined at /w/adder.sv:2');
        expect(blocks[0].text).toContain('- node:zz:unknown');
        expect(blocks[0].text).toContain('the file is not attached');
        expect(blocks.slice(1)).toEqual([
            { type: 'resource_link', uri: 'file:///w/top.sv', name: 'top.sv', mimeType: 'text/x-systemverilog' },
            { type: 'resource_link', uri: 'file:///w/adder.sv', name: 'adder.sv', mimeType: 'text/x-systemverilog' }
        ]);
    });

    it('is nothing when nothing is selected', () => {
        expect(selectionBlocks(payload, OWN, [], undefined)).toEqual([]);
    });
});

describe('the providers', () => {
    it('export once per file version and share it', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'src-ref-'));
        const file = path.join(dir, 'top.sv');
        await fs.writeFile(file, 'module top; endmodule\n');
        let calls = 0;
        const context = createSourceReferenceContext({
            invoke: async () => { calls += 1; return { ok: true, response: { status: 'ok', diagnostic: { graph: payload } } }; },
            exportOp: 'exportModuleGraph',
            sourceMimeType: 'text/x-systemverilog'
        });
        expect(await context.graphContextProvider(file)).toContain('Structure of top');
        const blocks: any[] = await context.turnContextProvider(file, ['node:scope:root:u_add']);
        expect(blocks[0].text).toContain('u_add');
        expect(calls).toBe(1);
        expect(await context.turnContextProvider(file, [])).toEqual([]);
        await new Promise(r => setTimeout(r, 20));
        await fs.writeFile(file, 'module top; wire w; endmodule\n');
        await context.graphContextProvider(file);
        expect(calls).toBe(2);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('render nothing the export cannot give', async () => {
        const context = createSourceReferenceContext({ invoke: async () => ({ ok: false, message: 'no' }), exportOp: 'x' });
        expect(await context.graphContextProvider('/nowhere/top.sv')).toBeUndefined();
        // The selection is still named, by id, with nothing to link.
        const blocks: any[] = await context.turnContextProvider('/nowhere/top.sv', ['n1']);
        expect(blocks.length).toBe(1);
        expect(blocks[0].text).toContain('- n1');
    });
});

describe("the profile's chat.sourceContext", () => {
    const base = (): any => ({
        key: 'hw', displayName: 'HW', settingsNamespace: 'hw', customEditorViewType: 'hw.diagram',
        glspClientId: 'hw.client', glspClientName: 'hw',
        commands: {
            openDiagram: 'c.openDiagram', openDiagramSplit: 'c.openDiagramSplit', layoutDiagram: 'c.layoutDiagram',
            refreshDiagramModel: 'c.refreshDiagramModel', layoutDiagramIfNeeded: 'c.layoutDiagramIfNeeded',
            fitToScreen: 'c.fitToScreen', runWorkflow: 'c.runWorkflow', stopWorkflow: 'c.stopWorkflow',
            setQueueTraceVisible: 'c.setQueueTraceVisible', setAgentToolConfig: 'c.setAgentToolConfig',
            getAgentToolConfig: 'c.getAgentToolConfig', chatOpen: 'c.chatOpen', chatSend: 'c.chatSend',
            chatAddViewerEditor: 'c.chatAddViewerEditor', chatAddViewerTask: 'c.chatAddViewerTask',
            newSourceFile: 'c.newSourceFile', exportDiagramAsSvg: 'c.exportDiagramAsSvg'
        },
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        sidecarOperationPrefix: 'hw', sidecarCommandSettingKey: 'sidecarCommand', sidecarCommandDefault: 'hw-sidecar',
        cliCommandSettingKey: 'cliCommand', cliCommandDefault: 'hw', acceptedOperationPrefixes: ['hw'],
        graphAcquisition: 'cli-plan', cliGraphArgs: (file: string) => ['plan', file],
        undoLabelSuffix: ' (hw)', createNodeStrings: {}, createNodeBehavior: {},
        sourceExtension: '.sv', mcpEnabledSetting: { section: 'hw.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'workflow', newContainer: { label: 'Module', decorator: 'module', importLine: '' },
        identifierNoun: 'SystemVerilog', runOutputDirSettingKey: 'runOutputDir', liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools', agentToolAuthSettingKey: 'agentToolAuth', agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs', agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd', exportOp: 'exportModuleGraph'
    });

    it('by reference: no file, a summary, a turn block, no default selection text', () => {
        const profile: any = createSidecarDiagramProfile({ ...base(), chat: { name: 'hw', fullName: 'HW', sourceMimeType: 'text/x-systemverilog', sourceContext: 'reference' } });
        expect(profile.chat.sourceMaxBytes).toBe(0);
        expect(profile.chat.selectionContext).toBe(false);
        expect(typeof profile.chat.graphContextProvider).toBe('function');
        expect(typeof profile.chat.turnContextProvider).toBe('function');
    });

    it('embedded, the default: nothing of that is set', () => {
        const profile: any = createSidecarDiagramProfile({ ...base(), chat: { name: 'hw', fullName: 'HW' } });
        expect(profile.chat.sourceMaxBytes).toBeUndefined();
        expect(profile.chat.selectionContext).toBeUndefined();
        expect(profile.chat.graphContextProvider).toBeUndefined();
    });
});
