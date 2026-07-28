// Review fix (MEDIUM): a mutation-capable platform chat tool (one that WRITES source via the
// sidecar, e.g. `create_task_type`) must NOT be bridged onto the read-only GLSP-MCP surface.
// The platform adapter's handlers inherit `readOnlyHint = true`, so an auto-approving MCP
// client could otherwise call such a tool and mutate files unconfirmed. Locked design
// (approach B): mutation-capable tools ride the GLSP-MCP BUILT-IN operation tools only and are
// never bridged. The bridge filters on an explicit `mutates: true` marker — not a name match.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    DiagramMcpModule,
    bridgeableChatTools
} from '../src/server/mcp-diagram-module';
import type { PlatformMcpTool } from '../src/server/mcp-platform-tool-adapter';

function tool(name: string, mutates?: boolean): PlatformMcpTool {
    return {
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: (file) => `handled ${file}`,
        ...(mutates === undefined ? {} : { mutates })
    };
}

describe('bridgeableChatTools (read-only GLSP-MCP bridge filter)', () => {
    it('drops mutation-marked tools and keeps read tools', () => {
        const bridged = bridgeableChatTools([
            tool('list_task_types'),
            tool('validate_workflow', false),
            tool('create_task_type', true)
        ]).map((t) => t.name);

        expect(bridged).toContain('list_task_types');
        expect(bridged).toContain('validate_workflow');
        // The mutation-capable tool is excluded from the read-only bridge.
        expect(bridged).not.toContain('create_task_type');
    });

    it('returns all tools when none are mutation-marked', () => {
        const bridged = bridgeableChatTools([tool('a'), tool('b')]).map((t) => t.name);
        expect(bridged).toEqual(['a', 'b']);
    });
});

describe('DiagramMcpModule.configureToolHandlers', () => {
    /** The stock `super.configureToolHandlers` only calls `binding.add(Ctor)`, so a recording
     * fake binding suffices; the platform-tool handler classes are all named
     * `PlatformMcpToolHandler` and instantiate without DI (property injection only). */
    function bridgedPlatformToolNames(module: DiagramMcpModule): string[] {
        const added: Array<new () => { name?: string }> = [];
        (module as unknown as {
            configureToolHandlers(b: { add(c: new () => unknown): void }): void;
        }).configureToolHandlers({ add: (c) => added.push(c as new () => { name?: string }) });
        return added
            .filter((c) => c.name === 'PlatformMcpToolHandler')
            .map((c) => new c().name as string);
    }

    it('bridges read tools but NOT mutation-marked tools', () => {
        const module = new DiagramMcpModule({
            tools: [tool('list_task_types'), tool('create_task_type', true)]
        });

        const names = bridgedPlatformToolNames(module);

        expect(names).toContain('list_task_types');
        expect(names).not.toContain('create_task_type');
    });
});
