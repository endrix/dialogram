// Review fix (MEDIUM): a mutation-capable platform chat tool (one that WRITES source via the
// sidecar) must NOT be bridged onto the read-only GLSP-MCP surface. The platform adapter's
// handlers inherit `readOnlyHint = true`, so an auto-approving MCP client could otherwise call
// such a tool and mutate files unconfirmed. Locked design (approach B): mutation-capable tools
// ride the GLSP-MCP BUILT-IN operation tools only and are never bridged. The bridge filters on
// an explicit `mutates: true` marker — not a name match.
//
// Post-0.6.0 NO shipped chat tool sets `mutates` (the former `create_task_type` chat tool became
// a reversible GLSP operation tool). The marker + filter are KEPT as a DEFENSIVE guardrail; these
// tests pin it with a synthetic `mutating_scaffold` tool so any future source-writing chat tool is
// still excluded from the read-only bridge.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    CreateEdgesMcpToolHandler,
    CreateNodesMcpToolHandler,
    RedoMcpToolHandler,
    UndoMcpToolHandler
} from '@eclipse-glsp/server-mcp';
import {
    DiagramMcpModule,
    bridgeableChatTools
} from '../src/server/mcp-diagram-module';
import { AgentDispatchCreateNodesMcpToolHandler } from '../src/server/create-nodes-mcp-tool-handler';
import { AgentDispatchCreateEdgesMcpToolHandler } from '../src/server/create-edges-mcp-tool-handler';
import type { PlatformMcpTool } from '../src/server/mcp-platform-tool-adapter';
import { GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

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
            tool('mutating_scaffold', true)
        ]).map((t) => t.name);

        expect(bridged).toContain('list_task_types');
        expect(bridged).toContain('validate_workflow');
        // The mutation-capable tool is excluded from the read-only bridge.
        expect(bridged).not.toContain('mutating_scaffold');
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
            tools: [tool('list_task_types'), tool('mutating_scaffold', true)]
        });

        const names = bridgedPlatformToolNames(module);

        expect(names).toContain('list_task_types');
        expect(names).not.toContain('mutating_scaffold');
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

    it('replaces the built-in create-nodes with the non-interactive agent-dispatch override', () => {
        // The stock create-nodes tool reaches the operation handler's interactive quick-input,
        // blocking an agent call on a dialog. The override marks dispatches `headless` so creation
        // runs without any prompt — so the built-in must be gone and the override present.
        const ctors = resolveToolHandlerCtors(new DiagramMcpModule());
        expect(ctors).not.toContain(CreateNodesMcpToolHandler);
        expect(ctors).toContain(AgentDispatchCreateNodesMcpToolHandler);
    });

    it('replaces the built-in create-edges with the auto-layout agent-dispatch override', () => {
        // The override raises the auto-layout signal after an agent-connected edge so the diagram
        // relayouts on the next reload; the built-in must be gone and the override present.
        const ctors = resolveToolHandlerCtors(new DiagramMcpModule());
        expect(ctors).not.toContain(CreateEdgesMcpToolHandler);
        expect(ctors).toContain(AgentDispatchCreateEdgesMcpToolHandler);
    });
});

describe('agent-dispatch tool handlers raise the auto-layout signal', () => {
    function stubSuperCreateResult<T extends { prototype: any }>(ctor: T): () => void {
        const proto = ctor.prototype as { createResult: (input: unknown) => Promise<unknown> };
        const original = proto.createResult;
        proto.createResult = async () => ({ content: [] });
        return () => { proto.createResult = original; };
    }

    it('create-nodes override marks pending only when a create actually landed', async () => {
        const restore = stubSuperCreateResult(CreateNodesMcpToolHandler);
        try {
            const handler = new AgentDispatchCreateNodesMcpToolHandler();
            let marked = 0;
            (handler as any).agentSignal = { markPending: () => { marked += 1; } };
            // The operation handler recorded one successful create on the shared sink.
            (handler as any).outcomeSink = {
                reset: () => {},
                take: () => [{ kind: 'created', name: 'mytask', type: 'MyTask' }]
            };
            await (handler as any).createResult({ sessionId: 's', nodes: [{ elementTypeId: 'node:task', position: { x: 0, y: 0 } }] });
            expect(marked).toBe(1);
        } finally {
            restore();
        }
    });

    it('create-edges override marks pending for a real create but NOT for a dry-run', async () => {
        const restore = stubSuperCreateResult(CreateEdgesMcpToolHandler);
        try {
            const handler = new AgentDispatchCreateEdgesMcpToolHandler();
            let marked = 0;
            (handler as any).agentSignal = { markPending: () => { marked += 1; } };

            await (handler as any).createResult({ sessionId: 's', edges: [], dryRun: true });
            expect(marked).toBe(0);

            await (handler as any).createResult({ sessionId: 's', edges: [] });
            expect(marked).toBe(1);
        } finally {
            restore();
        }
    });
});

describe('AgentDispatchCreateNodesMcpToolHandler (honest agent-facing result)', () => {
    /** Stub the inherited built-in create loop so no real dispatch is needed; the sink stands in
     * for what the operation handler would have recorded during that dispatch. */
    function stubSuper(): () => void {
        const proto = CreateNodesMcpToolHandler.prototype as unknown as {
            createResult: (input: unknown) => Promise<unknown>;
        };
        const original = proto.createResult;
        proto.createResult = async () => ({ isError: false, content: [{ type: 'text', text: 'Successfully created 0 node(s)' }] });
        return () => { proto.createResult = original; };
    }

    function fakeSink(outcomes: unknown[]) {
        return { reset: () => {}, take: () => outcomes };
    }

    function makeHandler(outcomes: unknown[]) {
        const handler = new AgentDispatchCreateNodesMcpToolHandler();
        let marked = 0;
        (handler as any).agentSignal = { markPending: () => { marked += 1; } };
        (handler as any).outcomeSink = fakeSink(outcomes);
        return { handler, marks: () => marked };
    }

    const input = { sessionId: 's', nodes: [{ elementTypeId: 'node:task', position: { x: 0, y: 0 }, args: { type: 'MyTask' } }] };

    it('drops the output schema so a text-only success result is valid at the SDK boundary', () => {
        // With CreateNodesOutputSchema still declared, a success result with no structuredContent
        // throws in the SDK. The override returns authoritative text, so the schema must be absent.
        expect(new AgentDispatchCreateNodesMcpToolHandler().outputSchema).toBeUndefined();
    });

    it('returns a readable confirmation (id + name) on a successful headless create', async () => {
        const restore = stubSuper();
        try {
            const { handler, marks } = makeHandler([{ kind: 'created', name: 'bottlenecks_report', type: 'BottlenecksReport' }]);
            const result = await (handler as any).createResult(input);
            expect(result.isError).toBeFalsy();
            const text = result.content.map((c: any) => c.text).join('\n');
            expect(text).toContain('bottlenecks_report');
            expect(text).toContain('BottlenecksReport');
            expect(marks()).toBe(1);
        } finally {
            restore();
        }
    });

    it('lists the created node\'s ports so the next create-edges needs no query', async () => {
        const restore = stubSuper();
        try {
            const { handler } = makeHandler([
                { kind: 'created', name: 'producer', type: 'Producer', ports: [
                    { name: 'out', direction: 'out' },
                    { name: 'aux', direction: 'in' }
                ] }
            ]);
            const result = await (handler as any).createResult(input);
            expect(result.isError).toBeFalsy();
            const text = result.content.map((c: any) => c.text).join('\n');
            // Port names are surfaced with directions...
            expect(text).toContain('out (out)');
            expect(text).toContain('aux (in)');
            // ...and the name-addressable connect hint points at create-edges.
            expect(text).toContain('producer.<port>');
            expect(text).toContain('create-edges');
        } finally {
            restore();
        }
    });

    it('returns an MCP tool error carrying the actionable message on a headless rejection', async () => {
        const restore = stubSuper();
        try {
            const { handler, marks } = makeHandler([
                { kind: 'rejected', message: "Workflow sidecar: cannot create task node without a required value — pass args.type with an existing task name. Available task types: Foo, Bar." }
            ]);
            const result = await (handler as any).createResult(input);
            // The failure marker the agent needs — NOT a success-shaped "0 created".
            expect(result.isError).toBe(true);
            const text = result.content.map((c: any) => c.text).join('\n');
            expect(text).toContain('args.type');
            expect(text).toContain('Available task types: Foo, Bar');
            // A pure rejection changed nothing on disk — no auto-layout owed.
            expect(marks()).toBe(0);
        } finally {
            restore();
        }
    });

    it('falls back to the built-in result when the sink recorded nothing', async () => {
        const restore = stubSuper();
        try {
            const { handler, marks } = makeHandler([]);
            const result = await (handler as any).createResult(input);
            expect(result.isError).toBeFalsy();
            expect(marks()).toBe(0);
        } finally {
            restore();
        }
    });
});

describe('AgentDispatchCreateNodesMcpToolHandler (headless marker injection)', () => {
    it('stamps `headless` on every dispatched node before delegating to the built-in flow', async () => {
        const handler = new AgentDispatchCreateNodesMcpToolHandler();
        // Intercept the inherited built-in create loop: capture what the override forwards to super,
        // then restore so the shared built-in prototype is left untouched for other tests.
        const builtinProto = CreateNodesMcpToolHandler.prototype as unknown as {
            createResult: (input: unknown) => Promise<unknown>;
        };
        const originalCreateResult = builtinProto.createResult;
        let seen: unknown;
        builtinProto.createResult = async function (input: unknown) {
            seen = input;
            return { content: [] };
        };

        try {
            await (handler as unknown as {
                createResult(input: unknown): Promise<unknown>;
            }).createResult({
                sessionId: 's1',
                nodes: [
                    { elementTypeId: 'node:task', position: { x: 0, y: 0 }, args: { type: 'MyTask' } },
                    { elementTypeId: 'node:task', position: { x: 1, y: 1 } }
                ]
            });
        } finally {
            builtinProto.createResult = originalCreateResult;
        }

        const forwarded = seen as { nodes: Array<{ args?: Record<string, unknown> }> };
        expect(forwarded.nodes[0].args).toEqual({ type: 'MyTask', headless: true });
        expect(forwarded.nodes[1].args).toEqual({ headless: true });
    });
});

describe('AgentDispatchCreateEdgesMcpToolHandler (name-addressable endpoints)', () => {
    // producer.out (output) and consumer.in (input) on two named nodes.
    function buildRoot() {
        const out = GPort.builder().id('producer.out').type(WorkflowDiagramTypes.PORT_OUTPUT)
            .addArg(WorkflowDiagramMetadata.PORT_NAME, 'out').build();
        const producer = GNode.builder().id('n_producer').type(WorkflowDiagramTypes.NODE_ACTOR)
            .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'producer').addChildren(out).build();
        const inp = GPort.builder().id('consumer.in').type(WorkflowDiagramTypes.PORT_INPUT)
            .addArg(WorkflowDiagramMetadata.PORT_NAME, 'in').build();
        const consumer = GNode.builder().id('n_consumer').type(WorkflowDiagramTypes.NODE_ACTOR)
            .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'consumer').addChildren(inp).build();
        return GGraph.builder().id('root').addChildren(producer, consumer).build();
    }

    function makeHandler() {
        const handler = new AgentDispatchCreateEdgesMcpToolHandler();
        (handler as any).agentSignal = { markPending: () => {} };
        (handler as any).modelState = { root: buildRoot() };
        (handler as any).encodeIds = (ids: string[]) => ids; // Null alias passthrough
        return handler;
    }

    /** Capture what the override forwards to the built-in create loop. */
    function captureSuper(): { restore: () => void; forwarded: () => any } {
        const proto = CreateEdgesMcpToolHandler.prototype as any;
        const original = proto.createResult;
        let seen: any;
        proto.createResult = async function (input: any) { seen = input; return { content: [], isError: false }; };
        return { restore: () => { proto.createResult = original; }, forwarded: () => seen };
    }

    it('resolves args.source/args.target "nodeName.portName" to element ids before dispatch', async () => {
        const cap = captureSuper();
        try {
            const handler = makeHandler();
            const result = await (handler as any).createResult({
                sessionId: 's',
                edges: [{ elementTypeId: 'edge:connection', args: { source: 'producer.out', target: 'consumer.in' } }]
            });
            expect(result.isError).toBeFalsy();
            const fwd = cap.forwarded();
            expect(fwd.edges[0].sourceElementId).toBe('producer.out');
            expect(fwd.edges[0].targetElementId).toBe('consumer.in');
            // The name specs are addressing, not model metadata — stripped from args.
            expect(fwd.edges[0].args).toBeUndefined();
        } finally {
            cap.restore();
        }
    });

    it('keeps raw element-id addressing working (pass-through)', async () => {
        const cap = captureSuper();
        try {
            const handler = makeHandler();
            await (handler as any).createResult({
                sessionId: 's',
                edges: [{ elementTypeId: 'edge:connection', sourceElementId: 'producer.out', targetElementId: 'consumer.in' }]
            });
            const fwd = cap.forwarded();
            expect(fwd.edges[0].sourceElementId).toBe('producer.out');
            expect(fwd.edges[0].targetElementId).toBe('consumer.in');
        } finally {
            cap.restore();
        }
    });

    it('fails the whole call with an actionable message when a port name is unknown', async () => {
        const cap = captureSuper();
        try {
            const handler = makeHandler();
            const result = await (handler as any).createResult({
                sessionId: 's',
                edges: [{ elementTypeId: 'edge:connection', args: { source: 'producer.out', target: 'consumer.missing' } }]
            });
            expect(result.isError).toBe(true);
            const text = result.content.map((c: any) => c.text).join('\n');
            expect(text).toMatch(/No port named 'missing'/);
            // No dispatch happened — the built-in create loop was never reached.
            expect(cap.forwarded()).toBeUndefined();
        } finally {
            cap.restore();
        }
    });
});
