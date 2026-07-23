/**
 * `createSidecarEditBackend` maps the neutral {@link DiagramEditBackend} seam
 * onto the toolkit's sidecar building blocks (invokeSidecarOp /
 * exportWorkflowGraph / getSidecarCapabilities / sidecarSupportsOp) 1:1, with
 * the right options and MCP env. The underlying sidecar functions are mocked so
 * the delegation is asserted without spawning a process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const graphExport = vi.hoisted(() => ({
    invokeSidecarOp: vi.fn(),
    exportWorkflowGraph: vi.fn()
}));
const capabilities = vi.hoisted(() => ({
    getSidecarCapabilities: vi.fn(),
    sidecarSupportsOp: vi.fn()
}));

vi.mock('../src/sidecar-graph-export.js', () => graphExport);
vi.mock('../src/sidecar-capabilities.js', () => capabilities);

import { createSidecarEditBackend, type SidecarEditBackendConfig } from '../src/chat-edit-backend.js';

const CFG: SidecarEditBackendConfig = {
    settingsNamespace: 'wfLang',
    sidecarCommandSettingKey: 'wfpySidecarCommand',
    sidecarCommandDefault: 'wfpy-sidecar',
    sidecarOperationPrefix: 'wfpy',
    exportOp: 'exportWorkflowGraph',
    mcpServerName: 'wfpy',
    mcpServerModulePath: (assetsPath: string) => `${assetsPath}/dist/sidecar-mcp-server.cjs`,
    mcpEnabledSetting: { section: 'workflow.chat', key: 'enableMcpTools', default: true },
    scopeArgKey: 'workflow'
};

const FILE_URI = 'file:///ws/pipeline.py';
const FILE_PATH = '/ws/pipeline.py';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('createSidecarEditBackend', () => {
    it('exportGraph delegates to exportWorkflowGraph and stringifies the graph', async () => {
        graphExport.exportWorkflowGraph.mockResolvedValue({ nodes: [{ id: 'a' }] });
        const backend = createSidecarEditBackend(CFG);

        const result = await backend.exportGraph(FILE_URI);

        expect(graphExport.exportWorkflowGraph).toHaveBeenCalledWith(FILE_PATH, {
            sidecarCommand: 'wfpy-sidecar',
            sidecarOperationPrefix: 'wfpy',
            exportOp: 'exportWorkflowGraph',
            networkName: undefined
        });
        expect(result).toBe(JSON.stringify({ nodes: [{ id: 'a' }] }));
    });

    it('exportGraph returns undefined when the sidecar yields no graph', async () => {
        graphExport.exportWorkflowGraph.mockResolvedValue(undefined);
        const backend = createSidecarEditBackend(CFG);
        await expect(backend.exportGraph(FILE_URI)).resolves.toBeUndefined();
    });

    it('exportGraph forwards a networkName', async () => {
        graphExport.exportWorkflowGraph.mockResolvedValue({ nodes: [] });
        const backend = createSidecarEditBackend(CFG);
        await backend.exportGraph(FILE_URI, { networkName: 'sub' });
        expect(graphExport.exportWorkflowGraph).toHaveBeenCalledWith(
            FILE_PATH,
            expect.objectContaining({ networkName: 'sub' })
        );
    });

    it('listCapabilities delegates and re-shapes into the neutral BackendCapabilities', async () => {
        capabilities.getSidecarCapabilities.mockResolvedValue({
            protocolVersion: 2,
            supportedOps: new Set(['exportGraph', 'createNode']),
            features: { sourceTruthEdits: true, stableIds: false }
        });
        const backend = createSidecarEditBackend(CFG);

        const caps = await backend.listCapabilities(FILE_URI);

        expect(capabilities.getSidecarCapabilities).toHaveBeenCalledWith(FILE_PATH, {
            sidecarCommand: 'wfpy-sidecar',
            sidecarOperationPrefix: 'wfpy'
        });
        expect(caps).toEqual({
            protocolVersion: '2',
            ops: ['exportGraph', 'createNode'],
            features: ['sourceTruthEdits']
        });
    });

    it('listCapabilities returns undefined when the sidecar has none', async () => {
        capabilities.getSidecarCapabilities.mockResolvedValue(undefined);
        const backend = createSidecarEditBackend(CFG);
        await expect(backend.listCapabilities(FILE_URI)).resolves.toBeUndefined();
    });

    it('supportsOp delegates to sidecarSupportsOp with the canonical kind', async () => {
        capabilities.sidecarSupportsOp.mockResolvedValue(false);
        const backend = createSidecarEditBackend(CFG);

        const supported = await backend.supportsOp(FILE_URI, 'createNode');

        expect(capabilities.sidecarSupportsOp).toHaveBeenCalledWith(
            FILE_PATH,
            { sidecarCommand: 'wfpy-sidecar', sidecarOperationPrefix: 'wfpy' },
            'createNode'
        );
        expect(supported).toBe(false);
    });

    it('applyNamedEdit delegates to invokeSidecarOp and returns a success EditResult', async () => {
        graphExport.invokeSidecarOp.mockResolvedValue({ ok: true, response: { revision: 'rev9' } });
        const backend = createSidecarEditBackend(CFG);

        const result = await backend.applyNamedEdit(FILE_URI, 'createNode', { name: 'A' });

        expect(graphExport.invokeSidecarOp).toHaveBeenCalledWith(
            FILE_PATH,
            { sidecarCommand: 'wfpy-sidecar', sidecarOperationPrefix: 'wfpy' },
            'createNode',
            { name: 'A' }
        );
        expect(result.ok).toBe(true);
        expect(result.revision).toBe('rev9');
    });

    it('applyNamedEdit threads expectedRevision into the sidecar args', async () => {
        graphExport.invokeSidecarOp.mockResolvedValue({ ok: true, response: {} });
        const backend = createSidecarEditBackend(CFG);

        await backend.applyNamedEdit(FILE_URI, 'connect', { source: 's' }, { expectedRevision: 'rev1' });

        expect(graphExport.invokeSidecarOp).toHaveBeenCalledWith(
            FILE_PATH,
            expect.anything(),
            'connect',
            { source: 's', expectedRevision: 'rev1' }
        );
    });

    it('applyNamedEdit maps concurrent_source_modification into conflict.actualRevision', async () => {
        graphExport.invokeSidecarOp.mockResolvedValue({
            ok: false,
            message: 'stale',
            response: { diagnostic: { code: 'concurrent_source_modification', actualRevision: 'rev2' } }
        });
        const backend = createSidecarEditBackend(CFG);

        const result = await backend.applyNamedEdit(FILE_URI, 'deleteNode', { name: 'A' });

        expect(result.ok).toBe(false);
        expect(result.conflict).toEqual({ actualRevision: 'rev2' });
        expect(result.message).toBe('stale');
    });

    it('applyNamedEdit surfaces a non-conflict failure without a conflict field', async () => {
        graphExport.invokeSidecarOp.mockResolvedValue({ ok: false, message: 'nope', response: {} });
        const backend = createSidecarEditBackend(CFG);

        const result = await backend.applyNamedEdit(FILE_URI, 'connect', {});

        expect(result.ok).toBe(false);
        expect(result.conflict).toBeUndefined();
        expect(result.message).toBe('nope');
    });

    it('scopeArgs uses the configured scope key when a network is given', () => {
        const backend = createSidecarEditBackend(CFG);
        expect(backend.scopeArgs(FILE_URI, 'top')).toEqual({ workflow: 'top' });
        expect(backend.scopeArgs(FILE_URI, undefined)).toEqual({});
    });

    it('mcpServers builds one descriptor with the sidecar env (kill-switch on)', () => {
        const backend = createSidecarEditBackend(CFG);
        const descriptors = backend.mcpServers(FILE_URI, { networkName: 'top', assetsPath: '/assets' });

        expect(descriptors).toHaveLength(1);
        const [d] = descriptors;
        expect(d.name).toBe('wfpy');
        expect(d.command).toBe('node');
        expect(d.args).toEqual(['/assets/dist/sidecar-mcp-server.cjs']);
        expect(d.env).toEqual({
            MCP_WORKFLOW_FILE: FILE_PATH,
            MCP_SIDECAR_CMD: 'wfpy-sidecar',
            MCP_OP_PREFIX: 'wfpy',
            MCP_NETWORK: 'top',
            MCP_SERVER_NAME: 'wfpy',
            MCP_EXPORT_OP: 'exportWorkflowGraph'
        });
    });

    it('mcpServers returns [] when the kill-switch is disabled', () => {
        const backend = createSidecarEditBackend({
            ...CFG,
            mcpEnabledSetting: { section: 'workflow.chat', key: 'enableMcpTools', default: false }
        });
        expect(backend.mcpServers(FILE_URI, { assetsPath: '/assets' })).toEqual([]);
    });
});
