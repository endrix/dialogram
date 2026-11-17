import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createEditChatCapability } from '../src/extension/chat/edit-capability';

const CTX = { file: '/ws/wf.py', uri: 'file:///ws/wf.py', sessionId: 's1', selectedNodeIds: [] as string[] };

function makeBackend(overrides: Record<string, any> = {}) {
    return {
        supportsOp: vi.fn(async () => true),
        scopeArgs: vi.fn(() => ({ workflow: 'net1' })),
        applyNamedEdit: vi.fn(async () => ({ ok: true, revision: 'r2' })),
        exportGraph: vi.fn(async () => 'graph-text'),
        listCapabilities: vi.fn(async () => undefined),
        ...overrides
    } as any;
}

function makeProfile() {
    return {
        key: 'wfpy',
        displayName: 'Workflow',
        commands: {
            layoutDiagram: 'workflow.glsp.layoutDiagram',
            layoutDiagramIfNeeded: 'workflow.glsp.layoutDiagramIfNeeded',
            center: 'workflow.glsp.center',
            fitToScreen: 'workflow.glsp.fitToScreen'
        },
        storageOptions: {
            entityPaletteItems: [
                { elementTypeId: 'node:actor', label: 'Task' },
                { elementTypeId: 'node:external-actor', label: 'Tool' },
                { elementTypeId: 'node:external-actor', label: 'Agent', args: { agentTask: true } },
                { elementTypeId: 'node:viewer-task', label: 'Viewer', args: { viewerTask: true } },
                { elementTypeId: 'node:network', label: 'Workflow' }
            ]
        },
        chat: {
            fullName: 'Workflow Chat',
            nodeCommands: [
                { command: 'create-task', nodeType: 'task', description: 'Create a new task node' },
                { command: 'create-agent', nodeType: 'agent', description: 'Create a new agent node' },
                { command: 'create-viewer', nodeType: 'viewer', description: 'Create a new viewer node' },
                { command: 'create-workflow', nodeType: 'workflow', description: 'Create a new workflow node' }
            ]
        }
    } as any;
}

/**
 * A stand-in for the diagram's GLSP-MCP tools: `session-info` lists the sessions given; every
 * other call takes the next scripted answer, or a plain success.
 */
function makeTools(answers: Array<{ ok: boolean; text: string }> = [], sessions = [{ sessionId: 'glsp_1', sourceUri: 'file:///ws/wf.py', readOnly: false }]) {
    const calls: Array<{ tool: string; args: any }> = [];
    return {
        calls,
        callTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
            calls.push({ tool, args });
            if (tool === 'session-info') {
                return { ok: true, text: '', structured: { sessions } };
            }
            return answers.shift() ?? { ok: true, text: 'created reader' };
        })
    };
}

function makeCapability(
    backend = makeBackend(),
    profile = makeProfile(),
    answers: Array<{ ok: boolean; text: string }> = [],
    sessions?: Array<{ sessionId: string; sourceUri: string; readOnly: boolean }>
) {
    const refresh = vi.fn();
    const editorProvider = {
        refreshModelFromDisk: refresh,
        getRefreshContext: vi.fn(() => ({ networkName: 'net1' })),
        getClientIdForDocumentUri: vi.fn(() => undefined)
    };
    const tools = makeTools(answers, sessions);
    const capability = createEditChatCapability({
        profile,
        editBackend: backend,
        getEditorProvider: () => editorProvider as any,
        log: () => undefined,
        mcpServerUrl: 'http://127.0.0.1:1/mcp',
        mcpClient: tools
    });
    return { capability, backend, refresh, tools };
}

function findCmd(capability: any, name: string) {
    const cmd = capability.slashCommands.find((c: any) => c.command === name);
    expect(cmd, `command ${name}`).toBeDefined();
    return cmd;
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
});

describe('slash contributions', () => {
    it('offers no node-creation command when the profile names none', () => {
        const profile = makeProfile();
        profile.chat = { fullName: 'Workflow Chat' };
        const { capability } = makeCapability(makeBackend(), profile);
        const names = capability.slashCommands.map(c => c.command);
        expect(names.filter(n => n.startsWith('create-'))).toEqual([]);
        expect(names).toEqual(expect.arrayContaining(['connect', 'delete', 'rename', 'layout']));
    });

    it('contributes the profile\'s node commands, edit commands and /layout', () => {
        const { capability } = makeCapability();
        const names = capability.slashCommands.map(c => c.command);
        expect(names).toEqual(
            expect.arrayContaining([
                'create-task', 'create-agent', 'create-viewer', 'create-workflow',
                'connect', 'delete', 'delete-selected', 'rename', 'update', 'layout'
            ])
        );
        // Stub-backed placebo commands are gone.
        expect(names).not.toContain('validate');
        expect(names).not.toContain('analyze');
    });

    it('create calls create-nodes on the diagram showing the file, with the palette row of its kind', async () => {
        const { capability, tools } = makeCapability();
        const result = await findCmd(capability, 'create-task').handler({ _positional: ['Reader', 'reader'] }, CTX);
        expect(result).toEqual({ success: true, info: 'created reader' });
        expect(tools.calls.map(call => call.tool)).toEqual(['session-info', 'create-nodes']);
        expect(tools.calls[1].args).toEqual({
            sessionId: 'glsp_1',
            nodes: [{ elementTypeId: 'node:actor', position: { x: 0, y: 0 }, args: { type: 'Reader', name: 'reader', createType: true } }]
        });
    });

    it('create carries the args that pick its palette row (an agent is an external actor)', async () => {
        const { capability, tools } = makeCapability();
        await findCmd(capability, 'create-agent').handler({ _positional: ['Summarize'] }, CTX);
        expect(tools.calls[1].args.nodes[0]).toEqual({
            elementTypeId: 'node:external-actor', position: { x: 0, y: 0 }, args: { agentTask: true, type: 'Summarize', createType: true }
        });
    });

    it('create of a type the file lacks is one call: the diagram makes the type first, the way its palette does', async () => {
        // It used to try, scaffold on any failure with the command's word as the kind, and try
        // again: a failure for any other reason (a type imported from elsewhere) wrote a class
        // shadowing it, and `/create-network` asked for a task kind called "network".
        const { capability, tools } = makeCapability(makeBackend(), makeProfile(), [{ ok: true, text: "- Created the task type 'Reader'.\n- Reader 'reader'" }]);
        const result = await findCmd(capability, 'create-task').handler({ _positional: ['Reader', 'reader'] }, CTX);
        expect(tools.calls.filter(call => call.tool !== 'session-info').map(call => call.tool)).toEqual(['create-nodes']);
        expect(result).toEqual({ success: true, info: "- Created the task type 'Reader'.\n- Reader 'reader'" });
    });

    it("a refused create is the command's error, and nothing else is tried", async () => {
        const { capability, tools } = makeCapability(makeBackend(), makeProfile(), [{ ok: false, text: "a node named 'reader' already exists" }]);
        const result = await findCmd(capability, 'create-task').handler({ _positional: ['Reader', 'reader'] }, CTX);
        expect(result).toEqual({ success: false, error: "a node named 'reader' already exists" });
        expect(tools.calls.filter(call => call.tool !== 'session-info')).toHaveLength(1);
    });

    it("a row that fixes its type takes only the node's name (a clause of one kind)", async () => {
        const profile = makeProfile();
        profile.storageOptions.entityPaletteItems.push({ elementTypeId: 'node:actor', label: 'Requirement', args: { type: 'requirement' } });
        profile.chat.nodeCommands.push({ command: 'new-requirement', nodeType: 'requirement', description: 'Add a requirement clause' });
        const { capability, tools } = makeCapability(makeBackend(), profile);
        const command = findCmd(capability, 'new-requirement');
        expect(command.usage).toBe('<name>');
        await command.handler({ _positional: ['Latency', 'budget'] }, CTX);
        expect(tools.calls[1].args.nodes[0]).toEqual({
            elementTypeId: 'node:actor', position: { x: 0, y: 0 }, args: { type: 'requirement', name: 'Latency budget' }
        });
    });

    it('create without a type fails with the usage message', async () => {
        const { capability } = makeCapability();
        const result = await findCmd(capability, 'create-task').handler({}, CTX);
        expect(result).toEqual({ success: false, error: 'Please name the task type. Usage: /create-task <Type> [name]' });
    });

    it('connect makes an edge between the two named ends', async () => {
        const { capability, tools } = makeCapability();
        await findCmd(capability, 'connect').handler({ _positional: ['splitter.Out', 'Report'] }, CTX);
        expect(tools.calls[1]).toEqual({
            tool: 'create-edges',
            args: { sessionId: 'glsp_1', edges: [{ elementTypeId: 'edge:connection', args: { source: 'splitter.Out', target: 'Report' } }] }
        });
    });

    it('delete takes several names; delete-selected the live selection, and fails when empty', async () => {
        const { capability, tools } = makeCapability();
        await findCmd(capability, 'delete').handler({ _positional: ['a', 'b'] }, CTX);
        expect(tools.calls[1]).toEqual({ tool: 'delete-elements', args: { sessionId: 'glsp_1', elementIds: ['a', 'b'] } });

        const del = findCmd(capability, 'delete-selected');
        const empty = await del.handler({}, CTX);
        expect(empty).toEqual({ success: false, error: 'No nodes selected. Please select nodes to delete.' });
        await del.handler({}, { ...CTX, selectedNodeIds: ['n1', 'n2'] });
        expect(tools.calls.at(-1)).toEqual({ tool: 'delete-elements', args: { sessionId: 'glsp_1', elementIds: ['n1', 'n2'] } });
    });

    it('rename sets the node label, which renames it', async () => {
        const { capability, tools } = makeCapability();
        await findCmd(capability, 'rename').handler({ _positional: ['splitter', 'words'] }, CTX);
        expect(tools.calls[1]).toEqual({ tool: 'modify-nodes', args: { sessionId: 'glsp_1', nodes: [{ elementId: 'splitter', text: 'words' }] } });
    });

    it('update sets each key=value as a parameter of the node, the value as typed', async () => {
        const { capability, tools } = makeCapability();
        // The shared parser would strip the quotes and cut File(path="x") at its `=`.
        const raw = 'top_words top_n=5 path="in put.txt" src=File(path="x y")';
        await findCmd(capability, 'update').handler({ _raw: raw, _positional: ['top_words'] }, CTX);
        expect(tools.calls[1]).toEqual({
            tool: 'set-node-parameters',
            args: { sessionId: 'glsp_1', node: 'top_words', parameters: { top_n: '5', path: '"in put.txt"', src: 'File(path="x y")' } }
        });
    });

    it('says so when the diagram tools are turned off for this user', async () => {
        const original = vscode.workspace.getConfiguration;
        (vscode.workspace as any).getConfiguration = () => ({ get: (key: string, fallback: unknown) => (key === 'useGlspMcp' ? false : fallback) });
        try {
            const { capability, tools } = makeCapability();
            const result = await findCmd(capability, 'delete').handler({ _positional: ['a'] }, CTX);
            expect(result).toEqual({ success: false, error: expect.stringContaining('dialogram.chat.useGlspMcp') });
            expect(tools.calls).toEqual([]);
        } finally {
            (vscode.workspace as any).getConfiguration = original;
        }
    });

    it("a refusal is the command's error, in the tool's words", async () => {
        const { capability } = makeCapability(makeBackend(), makeProfile(), [{ ok: false, text: "No node named 'nope' in the diagram." }]);
        const result = await findCmd(capability, 'rename').handler({ _positional: ['nope', 'x'] }, CTX);
        expect(result).toEqual({ success: false, error: "No node named 'nope' in the diagram." });
    });

    it("says the diagram's tools did not answer, rather than asking to open a diagram that is open", async () => {
        const { capability, tools } = makeCapability();
        tools.callTool.mockImplementationOnce(async () => ({ ok: false, text: "The diagram's tools did not answer: ECONNREFUSED" }));
        const result = await findCmd(capability, 'delete').handler({ _positional: ['a'] }, CTX);
        expect(result).toEqual({ success: false, error: "The diagram's tools did not answer: ECONNREFUSED" });
    });

    it('says so when no diagram shows the file', async () => {
        const { capability } = makeCapability(makeBackend(), makeProfile(), [], []);
        const result = await findCmd(capability, 'delete').handler({ _positional: ['a'] }, CTX);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Open the diagram of this file');
    });

    it('says so when the diagram tools are off', async () => {
        const capability = createEditChatCapability({
            profile: makeProfile(),
            editBackend: makeBackend(),
            getEditorProvider: () => undefined,
            log: () => undefined
        });
        const result = await findCmd(capability, 'delete').handler({ _positional: ['a'] }, CTX);
        expect(result.success).toBe(false);
        expect(result.error).toContain("diagram's tools");
    });

    it('/layout runs the profile layout command', async () => {
        const { capability } = makeCapability();
        const layout = findCmd(capability, 'layout');
        const result = await layout.handler({}, CTX);
        expect(result.success).toBe(true);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workflow.glsp.layoutDiagram');
    });
});

describe('postTurnHook (keyword view-ops)', () => {
    it('runs matched ops in stable order after the settle delay', async () => {
        vi.useFakeTimers();
        const { capability } = makeCapability();
        const p = capability.postTurnHook('/ws/wf.py', 'please fit to screen and re-layout');
        await vi.advanceTimersByTimeAsync(500);
        await p;
        const calls = (vscode.commands.executeCommand as any).mock.calls.map((c: any[]) => c[0]);
        expect(calls).toEqual(['workflow.glsp.layoutDiagram', 'workflow.glsp.fitToScreen']);
        vi.useRealTimers();
    });

    it('does nothing when no keyword matches', async () => {
        const { capability } = makeCapability();
        await capability.postTurnHook('/ws/wf.py', 'explain this node');
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});

describe('providers', () => {
    it('graphContextProvider returns the exported graph', async () => {
        const { capability } = makeCapability();
        await expect(capability.graphContextProvider('/ws/wf.py')).resolves.toBe('graph-text');
    });
});
