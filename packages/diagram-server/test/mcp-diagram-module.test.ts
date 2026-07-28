// Review fix (MEDIUM): a mutation-capable platform chat tool (one that WRITES source via the
// sidecar, e.g. `create_task_type`) must NOT be bridged onto the read-only GLSP-MCP surface.
// The platform adapter's handlers inherit `readOnlyHint = true`, so an auto-approving MCP
// client could otherwise call such a tool and mutate files unconfirmed. Locked design
// (approach B): mutation-capable tools ride the GLSP-MCP BUILT-IN operation tools only and are
// never bridged. The bridge filters on an explicit `mutates: true` marker — not a name match.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    CreateNodesMcpToolHandler,
    RedoMcpToolHandler,
    UndoMcpToolHandler
} from '@eclipse-glsp/server-mcp';
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
            configureToolHandlers(b: {
                add(c: new () => unknown): void;
                remove(c: new () => unknown): void;
            }): void;
        }).configureToolHandlers({
            add: (c) => added.push(c as new () => { name?: string }),
            remove: (c) => {
                const i = added.indexOf(c as new () => { name?: string });
                if (i >= 0) {
                    added.splice(i, 1);
                }
            }
        });
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

describe('DiagramMcpModule undo/redo tool exclusion (host owns undo)', () => {
    /**
     * A recording fake mirroring `InstanceMultiBinding`'s add/remove-by-reference semantics.
     * The stock `super.configureToolHandlers` calls `binding.add(Ctor)` for the 16 built-ins,
     * including {@link UndoMcpToolHandler} / {@link RedoMcpToolHandler}; our override then
     * `binding.remove(...)`s the two so they are absent from the final constructor set.
     */
    function resolveToolHandlerCtors(module: DiagramMcpModule): Array<new () => unknown> {
        const ctors: Array<new () => unknown> = [];
        const binding = {
            add(c: new () => unknown): void {
                ctors.push(c);
            },
            remove(c: new () => unknown): void {
                const i = ctors.indexOf(c);
                if (i >= 0) {
                    ctors.splice(i, 1);
                }
            }
        };
        (module as unknown as {
            configureToolHandlers(b: typeof binding): void;
        }).configureToolHandlers(binding);
        return ctors;
    }

    it('excludes the built-in undo and redo tool handlers', () => {
        const ctors = resolveToolHandlerCtors(new DiagramMcpModule());

        // Dialogram's durable undo is the VS Code document stack (fed by reversible workspace
        // edits, survives source-model reloads), not the per-session GLSP command stack the
        // built-in undo/redo tools read. Those tools would only ever report "nothing to undo",
        // so they must never be advertised to agents.
        expect(ctors).not.toContain(UndoMcpToolHandler);
        expect(ctors).not.toContain(RedoMcpToolHandler);
    });

    it('keeps the other built-in mutation tools (only undo/redo are dropped)', () => {
        const ctors = resolveToolHandlerCtors(new DiagramMcpModule());
        expect(ctors).toContain(CreateNodesMcpToolHandler);
    });
});
