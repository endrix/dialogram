/**
 * T7 (GLSP-MCP Phase B): the sidecar-registry READ tools, relocated out of the
 * standalone stdio MCP server (`sidecar-mcp-server.ts`) into in-process chat
 * tools so the platform adapter can bridge them over GLSP-MCP.
 *
 * `createRegistryChatTools` builds the 5 read-shaped tools
 * (`list_task_types`, `list_workflow_types`, `list_nodes`, `validate_workflow`,
 * `create_task_type`). Each tool's `handler(file, args)` invokes a sidecar op
 * through the injected `invoke` seam, maps the exposed `network` arg onto the
 * runtime's `scopeArgKey`, and renders the result as text. The 5 graph-mutation
 * tools (`create_node`, `connect`, ...) are NOT here — they became GLSP-MCP
 * built-ins.
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
            ['create_task_type', 'list_nodes', 'list_task_types', 'list_workflow_types', 'validate_workflow'].sort()
        );
        // The graph-mutation tools moved to GLSP-MCP built-ins — they must NOT be bridged here.
        for (const gone of ['create_node', 'connect', 'rename_node', 'delete_node', 'update_node_parameter', 'get_graph']) {
            expect(names).not.toContain(gone);
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

    it('create_task_type forwards name/inputs/outputs (scaffold op)', async () => {
        const { invoke, calls } = stubInvoke({ status: 'ok', created: 'Foo' });
        const text = await toolNamed('create_task_type', invoke).handler('/abs/net.py', {
            name: 'Foo',
            inputs: ['a'],
            outputs: ['b']
        });
        expect(calls[0].op).toBe('createTaskType');
        expect(calls[0].args).toMatchObject({ name: 'Foo', inputs: ['a'], outputs: ['b'] });
        expect(text).toContain('Foo');
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
