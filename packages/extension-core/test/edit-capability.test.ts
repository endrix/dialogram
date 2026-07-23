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
        mcpServers: vi.fn(() => [
            { name: 'wf', command: 'node', args: ['srv.cjs'], env: { OP_PREFIX: 'workflow' } }
        ]),
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
        chat: { name: 'wf', fullName: 'Workflow Chat', operationPrefix: 'workflow' }
    } as any;
}

function makeCapability(backend = makeBackend()) {
    const refresh = vi.fn();
    const editorProvider = {
        refreshModelFromDisk: refresh,
        getRefreshContext: vi.fn(() => ({ networkName: 'net1' }))
    };
    const capability = createEditChatCapability({
        profile: makeProfile(),
        editBackend: backend,
        getEditorProvider: () => editorProvider as any,
        getAssetsPath: () => '/assets',
        log: () => undefined
    });
    return { capability, backend, refresh };
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
    it('contributes default node commands, edit commands and /layout', () => {
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

    it('create command builds the exact createNode payload with scope args', async () => {
        const { capability, backend } = makeCapability();
        const create = findCmd(capability, 'create-task');
        const result = await create.handler({ _positional: ['reader'] }, CTX);
        expect(result.success).toBe(true);
        expect(backend.applyNamedEdit).toHaveBeenCalledWith(
            'file:///ws/wf.py',
            'createNode',
            { workflow: 'net1', type: 'task', name: 'reader', params: {} },
            { expectedRevision: undefined }
        );
    });

    it('create without a name fails with the usage message', async () => {
        const { capability } = makeCapability();
        const create = findCmd(capability, 'create-task');
        const result = await create.handler({}, CTX);
        expect(result).toEqual({
            success: false,
            error: 'Please provide a name for the task. Usage: /create-task <name>'
        });
    });

    it('connect maps positionals to source/target', async () => {
        const { capability, backend } = makeCapability();
        const connect = findCmd(capability, 'connect');
        await connect.handler({ _positional: ['a', 'b'] }, CTX);
        expect(backend.applyNamedEdit).toHaveBeenCalledWith(
            'file:///ws/wf.py',
            'connect',
            { workflow: 'net1', source: 'a', target: 'b' },
            { expectedRevision: undefined }
        );
    });

    it('delete-selected uses the live selection and fails when empty', async () => {
        const { capability, backend } = makeCapability();
        const del = findCmd(capability, 'delete-selected');
        const empty = await del.handler({}, CTX);
        expect(empty.success).toBe(false);
        expect(empty.error).toBe('No nodes selected. Please select nodes to delete.');

        await del.handler({}, { ...CTX, selectedNodeIds: ['n1', 'n2'] });
        const deletes = backend.applyNamedEdit.mock.calls.filter((c: any[]) => c[1] === 'deleteNode');
        expect(deletes.map((c: any[]) => c[2])).toEqual([
            { workflow: 'net1', name: 'n1' },
            { workflow: 'net1', name: 'n2' }
        ]);
    });

    it('update strips name/_positional from params', async () => {
        const { capability, backend } = makeCapability();
        const update = findCmd(capability, 'update');
        await update.handler({ _positional: ['reader'], retries: '3' }, CTX);
        expect(backend.applyNamedEdit).toHaveBeenCalledWith(
            'file:///ws/wf.py',
            'updateNodeParameter',
            { workflow: 'net1', name: 'reader', params: { retries: '3' } },
            { expectedRevision: undefined }
        );
    });

    it('unsupported op is refused via capability gating', async () => {
        const { capability } = makeCapability(makeBackend({ supportsOp: vi.fn(async () => false) }));
        const create = findCmd(capability, 'create-task');
        const result = await create.handler({ _positional: ['x'] }, CTX);
        expect(result.success).toBe(false);
        expect(result.error).toContain("'createNode' isn't supported");
    });

    it('conflict result reloads the diagram and asks for a retry', async () => {
        const backend = makeBackend({
            applyNamedEdit: vi.fn(async () => ({ ok: false, conflict: { actualRevision: 'r9' } }))
        });
        const { capability, refresh } = makeCapability(backend);
        const create = findCmd(capability, 'create-task');
        const result = await create.handler({ _positional: ['x'] }, CTX);
        expect(result.success).toBe(false);
        expect(result.error).toContain('changed since the chat last read it');
        expect(refresh).toHaveBeenCalled();
    });

    it('successful edit refreshes the diagram from disk', async () => {
        const { capability, refresh } = makeCapability();
        const create = findCmd(capability, 'create-task');
        await create.handler({ _positional: ['x'] }, CTX);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('/layout runs the profile layout command', async () => {
        const { capability } = makeCapability();
        const layout = findCmd(capability, 'layout');
        const result = await layout.handler({}, CTX);
        expect(result.success).toBe(true);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workflow.glsp.layoutDiagram');
    });
});

describe('optimistic-concurrency cache (checkSourceRevision enabled)', () => {
    it('threads the source revision across edits: empty→undefined, success caches, conflict updates', async () => {
        // getChatSetting reads the neutral `dialogram.chat` config section; the vscode
        // mock's getConfiguration exposes only `get` (no `inspect`), so getChatSetting
        // returns whatever `get` yields. Stub it to enable the revision check.
        const configSpy = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            get: (key: string, defaultValue?: unknown) =>
                key === 'checkSourceRevision' ? true : defaultValue
        } as any);
        try {
            const applyNamedEdit = vi
                .fn()
                .mockResolvedValueOnce({ ok: true, revision: 'r2' })
                .mockResolvedValueOnce({ ok: false, conflict: { actualRevision: 'r9' } })
                .mockResolvedValue({ ok: true, revision: 'r10' });
            const { capability, backend } = makeCapability(makeBackend({ applyNamedEdit }));
            const create = findCmd(capability, 'create-task');

            // (1) cache empty → expectedRevision undefined; backend returns r2 (cached).
            await create.handler({ _positional: ['a'] }, CTX);
            // (2) cache hit → expectedRevision r2; backend returns a conflict → cache becomes r9.
            await create.handler({ _positional: ['b'] }, CTX);
            // (3) conflict-updated cache → expectedRevision r9.
            await create.handler({ _positional: ['c'] }, CTX);

            const revisions = backend.applyNamedEdit.mock.calls.map((c: any[]) => c[3]);
            expect(revisions).toEqual([
                { expectedRevision: undefined },
                { expectedRevision: 'r2' },
                { expectedRevision: 'r9' }
            ]);
        } finally {
            configSpy.mockRestore();
        }
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

    it('stdioMcpServers adapts env to the ACP name/value shape', () => {
        const { capability } = makeCapability();
        expect(capability.stdioMcpServers('/ws/wf.py')).toEqual([
            { name: 'wf', command: 'node', args: ['srv.cjs'], env: [{ name: 'OP_PREFIX', value: 'workflow' }] }
        ]);
    });
});
