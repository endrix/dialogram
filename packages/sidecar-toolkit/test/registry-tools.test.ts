/**
 * T7 (GLSP-MCP Phase B): the sidecar-registry READ tools, relocated out of the
 * (now-deleted) legacy stdio MCP server into in-process chat
 * tools so the platform adapter can bridge them over GLSP-MCP.
 *
 * `createRegistryChatTools` builds the 5 read-shaped tools
 * (`list_task_types`, `list_workflow_types`, `list_nodes`, `validate_workflow`,
 * `get_graph`). Each tool's `handler(file, args)` invokes a sidecar op
 * through the injected `invoke` seam, maps the exposed `network` arg onto the
 * runtime's `scopeArgKey`, and renders the result as text. The graph-mutation
 * tools (`create_node`, `connect`, ...) are NOT here — they became GLSP-MCP
 * built-ins; `create_task_type` likewise became a reversible GLSP operation tool
 * (0.6.0), so it is no longer assembled as an in-process chat tool.
 */
import { describe, expect, it } from 'vitest';
import { createRegistryChatTools } from '../src/registry-tools';
import type { SidecarOpResult } from '../src/sidecar-graph-export';

function stubInvoke(response: unknown, ok = true) {
    const calls: Array<{ file: string; op: string; args: Record<string, unknown> }> = [];
    const invoke = async (file: string, op: string, args: Record<string, unknown>): Promise<SidecarOpResult> => {
        calls.push({ file, op, args });
        return ok ? { ok: true, response } : { ok: false, message: String(response), response };
    };
    return { invoke, calls };
}

function toolNamed(name: string, invoke: ReturnType<typeof stubInvoke>['invoke']) {
    const tools = createRegistryChatTools({ invoke, exportOp: 'exportGraph', scopeArgKey: 'workflow' });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not assembled`);
    return tool;
}

describe('createRegistryChatTools (T7)', () => {
    it('assembles exactly the 5 read tools and NONE of the mutation tools', () => {
        const { invoke } = stubInvoke({});
        const names = createRegistryChatTools({ invoke, scopeArgKey: 'workflow' }).map((t) => t.name).sort();
        expect(names).toEqual(
            ['get_graph', 'list_nodes', 'list_task_types', 'list_workflow_types', 'validate_workflow'].sort()
        );
        // The graph-mutation tools moved to GLSP-MCP built-ins — they must NOT be bridged here.
        // `create_task_type` is now a reversible GLSP operation tool (0.6.0), no longer a chat tool.
        for (const gone of ['create_node', 'connect', 'rename_node', 'delete_node', 'update_node_parameter', 'create_task_type']) {
            expect(names).not.toContain(gone);
        }
    });

    it('leaves every assembled registry tool read-only (none mutation-marked)', () => {
        // Post-0.6.0 there is no mutation-capable chat tool: the only former one (`create_task_type`)
        // became a GLSP-MCP operation tool. The `mutates` marker + `bridgeableChatTools` filter are
        // KEPT as a defensive guardrail (pinned in mcp-diagram-module.test.ts) so any future
        // source-writing chat tool is still excluded from the read-only bridge — but no current tool
        // sets it.
        const { invoke } = stubInvoke({});
        const tools = createRegistryChatTools({ invoke, scopeArgKey: 'workflow' });
        for (const t of tools) {
            expect(t.mutates).not.toBe(true);
        }
    });

    it('list_task_types invokes the sidecar op and maps `network` onto scopeArgKey', async () => {
        const { invoke, calls } = stubInvoke({ status: 'ok', taskTypes: ['Splitter'] });
        const text = await toolNamed('list_task_types', invoke).handler('/abs/net.py', { network: 'main' });
        expect(calls).toHaveLength(1);
        expect(calls[0].op).toBe('listTaskTypes');
        expect(calls[0].file).toBe('/abs/net.py');
        // Exposed `network` becomes the runtime's scope arg key (here 'workflow').
        expect(calls[0].args).toEqual({ workflow: 'main' });
        expect(text).toContain('Splitter');
    });

    it('omits the scope arg when no network is supplied', async () => {
        const { invoke, calls } = stubInvoke({ status: 'ok' });
        await toolNamed('list_nodes', invoke).handler('/abs/net.py', {});
        expect(calls[0].op).toBe('listInstanceNames');
        expect(calls[0].args).toEqual({});
    });

    it('get_graph exports the resolved graph JSON via the runtime export op', async () => {
        const { invoke, calls } = stubInvoke({ status: 'ok', graph: { nodes: ['Splitter'], edges: [] } });
        const text = await toolNamed('get_graph', invoke).handler('/abs/net.py', { network: 'main' });
        // Ported from the deleted legacy stdio server: mirrors validate_workflow's transport but
        // returns the RAW export payload (not the summarized verdict).
        expect(calls[0].op).toBe('exportGraph');
        expect(calls[0].args).toEqual({ workflow: 'main' });
        expect(text).toContain('Splitter');
    });

    it('validate_workflow summarizes the export into a verdict', async () => {
        const { invoke } = stubInvoke({
            status: 'ok',
            diagnostic: { graph: { partial: false, nodes: [], edges: [], errors: [] } }
        });
        const text = await toolNamed('validate_workflow', invoke).handler('/abs/net.py', {});
        const verdict = JSON.parse(text);
        expect(verdict.ok).toBe(true);
        expect(verdict).toHaveProperty('problems', 0);
    });

    it('renders a sidecar error as `Error: <message>` text', async () => {
        const { invoke } = stubInvoke('boom', false);
        const text = await toolNamed('list_workflow_types', invoke).handler('/abs/net.py', {});
        expect(text).toContain('Error: boom');
    });
});
