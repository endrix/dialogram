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
    DeleteElementsMcpToolHandler,
    ModifyNodesMcpToolHandler,
    RedoMcpToolHandler,
    UndoMcpToolHandler
} from '@eclipse-glsp/server-mcp';
import {
    DiagramMcpModule,
    bridgeableChatTools
} from '../src/server/mcp-diagram-module';
import { AgentDispatchCreateNodesMcpToolHandler } from '../src/server/create-nodes-mcp-tool-handler';
import { AgentDispatchCreateEdgesMcpToolHandler } from '../src/server/create-edges-mcp-tool-handler';
import { AgentEditOutcomeSink } from '../src/server/agent-edit-outcome';
import {
    AgentDispatchDeleteElementsMcpToolHandler,
    AgentDispatchModifyNodesMcpToolHandler,
    NamedNodeMcpLabelProvider,
    PaletteElementTypesProvider
} from '../src/server/mcp-named-elements';
import type { PlatformMcpTool } from '../src/server/mcp-platform-tool-adapter';
import { GGraph, GLabel, GNode, GPort } from '@eclipse-glsp/server';
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

    it('the module puts the named-element tools in place of the stock ones', () => {
        const ctors = resolveToolHandlerCtors(new DiagramMcpModule());
        expect(ctors).not.toContain(DeleteElementsMcpToolHandler);
        expect(ctors).not.toContain(ModifyNodesMcpToolHandler);
        expect(ctors).toContain(AgentDispatchDeleteElementsMcpToolHandler);
        expect(ctors).toContain(AgentDispatchModifyNodesMcpToolHandler);
    });
});

describe('DiagramMcpModule: the chat\'s untangle in every diagram', () => {
    it('offers the untangle tools in a read-only session as in an editable one', () => {
        const namesOf = (module: DiagramMcpModule): string[] => {
            const ctors: Array<new () => { name?: string }> = [];
            (module as unknown as {
                configureToolHandlers(b: { add(c: new () => unknown): void; remove(c: new () => unknown): void }): void;
            }).configureToolHandlers({
                add: (c) => ctors.push(c as new () => { name?: string }),
                remove: (c) => {
                    const i = ctors.indexOf(c as new () => { name?: string });
                    if (i >= 0) {
                        ctors.splice(i, 1);
                    }
                }
            });
            return ctors.map((c) => new c().name as string);
        };
        const untangle = ['untangle-start', 'untangle-try', 'untangle-propose', 'untangle-end'];
        // A read-only diagram may be laid out and its layout saved: so may an untangle applied.
        const readOnly = namesOf(new DiagramMcpModule({ edits: 'read-only' }));
        expect(readOnly).toEqual(expect.arrayContaining(untangle));
        expect(readOnly).not.toContain('create-nodes');
        expect(namesOf(new DiagramMcpModule({ edits: { operationModules: [] } }))).toEqual(expect.arrayContaining(untangle));
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
            // The name specs are addressing, not model metadata — stripped from args; an agent's
            // edge is made headless, so no question reaches the person mid tool call.
            expect(fwd.edges[0].args).toEqual({ headless: true });
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

describe('agent edits say what the producer answered', () => {
    function stubSuper<T extends { prototype: any }>(ctor: T, onCall: (input: any) => void = () => {}): () => void {
        const proto = ctor.prototype as { createResult: (input: unknown) => Promise<unknown> };
        const original = proto.createResult;
        proto.createResult = async (input: unknown) => {
            onCall(input);
            return { content: [{ type: 'text', text: 'stock' }] };
        };
        return () => { proto.createResult = original; };
    }

    /** The real sink, which the stubbed dispatch fills with one batch of answers per call. */
    function scriptedSink(batches: Array<Array<{ op: string; ok: boolean; message?: string }>>) {
        const sink = new AgentEditOutcomeSink();
        return Object.assign(sink, {
            next: () => { for (const outcome of batches.shift() ?? []) sink.record(outcome); }
        });
    }

    it('create-edges reports each edge: made, or refused with the reason', async () => {
        const sink = scriptedSink([
            [{ op: 'wfpy.connect', ok: true }],
            [{ op: 'wfpy.connect', ok: false, message: 'Port In of b is already connected.' }]
        ]);
        const restore = stubSuper(CreateEdgesMcpToolHandler, () => sink.next());
        try {
            const handler = new AgentDispatchCreateEdgesMcpToolHandler();
            let marked = 0;
            (handler as any).agentSignal = { markPending: () => { marked += 1; } };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({
                sessionId: 's',
                edges: [
                    { elementTypeId: 'edge', sourceElementId: 'a1', targetElementId: 'b1' },
                    { elementTypeId: 'edge', sourceElementId: 'a2', targetElementId: 'b2' }
                ]
            });
            const text = result.content.map((part: any) => part.text).join('\n');
            // Some made: not an error, which would have the call repeated whole.
            expect(result.isError).toBeFalsy();
            expect(text).toMatch(/^Partly done: 1 of 2 edges made\. Do not repeat those/);
            expect(text).toContain('Connected 1 edge(s):\n- a1 → b1');
            expect(text).toContain('a2 → b2: Port In of b is already connected.');
            expect(marked).toBe(1);
        } finally {
            restore();
        }
    });

    it('create-edges counts a transition between states, made by an op of its own', async () => {
        const sink = scriptedSink([[{ op: 'calpy.addTransition', ok: true }]]);
        const restore = stubSuper(CreateEdgesMcpToolHandler, () => sink.next());
        try {
            const handler = new AgentDispatchCreateEdgesMcpToolHandler();
            (handler as any).agentSignal = { markPending: () => {} };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({
                sessionId: 's',
                edges: [{ elementTypeId: 'edge', sourceElementId: 's0', targetElementId: 's1' }]
            });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toContain('Connected 1 edge(s):\n- s0 → s1');
        } finally {
            restore();
        }
    });

    it('create-edges says an edge that never reached the producer was not made', async () => {
        const restore = stubSuper(CreateEdgesMcpToolHandler);
        try {
            const handler = new AgentDispatchCreateEdgesMcpToolHandler();
            (handler as any).agentSignal = { markPending: () => {} };
            (handler as any).editOutcomes = scriptedSink([]);
            const result = await (handler as any).createResult({
                sessionId: 's',
                edges: [{ elementTypeId: 'edge', sourceElementId: 'a1', targetElementId: 'b1' }]
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('a1 → b1: not connected. stock');
        } finally {
            restore();
        }
    });

    it('delete-elements takes a node by its name and counts what the producer deleted', async () => {
        let given: any;
        const sink = scriptedSink([[{ op: 'wfpy.deleteNode', ok: true }]]);
        const restore = stubSuper(DeleteElementsMcpToolHandler, input => { given = input; sink.next(); });
        try {
            const handler = new AgentDispatchDeleteElementsMcpToolHandler();
            const splitter = GNode.builder().id('n_splitter').type(WorkflowDiagramTypes.NODE_ACTOR)
                .addArg(WorkflowDiagramMetadata.ENTITY_NAME, 'splitter').build();
            const root = GGraph.builder().id('root').addChildren(splitter).build();
            (handler as any).modelState = { root, index: { find: (id: string) => (id === 'n_splitter' ? splitter : undefined) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).encodeIds = (ids: string[]) => ids.map(id => `alias:${id}`);
            (handler as any).agentSignal = { markPending: () => {} };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({ sessionId: 's', elementIds: ['splitter'] });
            expect(given.elementIds).toEqual(['alias:n_splitter']);
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toContain('Deleted splitter (1 edit(s) to the source).');
        } finally {
            restore();
        }
    });

    it('delete-elements takes a delete the model shows done, with no answer needed (held states)', async () => {
        const proto = DeleteElementsMcpToolHandler.prototype as any;
        const original = proto.createResult;
        proto.createResult = async () => ({ content: [{ type: 'text', text: 'Successfully deleted 1 element(s)' }], structuredContent: { deletedCount: 1 } });
        try {
            const handler = new AgentDispatchDeleteElementsMcpToolHandler();
            (handler as any).modelState = { root: GGraph.builder().id('root').build(), index: { find: () => ({}) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).agentSignal = { markPending: () => {} };
            (handler as any).editOutcomes = scriptedSink([]);
            const result = await (handler as any).createResult({ sessionId: 's', elementIds: ['held_s3'] });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toBe('Deleted held_s3.');
        } finally {
            proto.createResult = original;
        }
    });

    it('delete-elements counts every answer of the delete, a transition or view element too', async () => {
        const sink = scriptedSink([[{ op: 'calpy.removeTransition', ok: true }]]);
        const restore = stubSuper(DeleteElementsMcpToolHandler, () => sink.next());
        try {
            const handler = new AgentDispatchDeleteElementsMcpToolHandler();
            (handler as any).modelState = { root: GGraph.builder().id('root').build(), index: { find: () => ({}) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).agentSignal = { markPending: () => {} };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({ sessionId: 's', elementIds: ['t1'] });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toContain('Deleted t1 (1 edit(s) to the source).');
        } finally {
            restore();
        }
    });

    it('modify-nodes says a rename the source was never asked for did not happen', async () => {
        const restore = stubSuper(ModifyNodesMcpToolHandler);
        try {
            const handler = new AgentDispatchModifyNodesMcpToolHandler();
            (handler as any).modelState = { root: GGraph.builder().id('root').build(), index: { find: () => ({}) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).editOutcomes = scriptedSink([]);
            const result = await (handler as any).createResult({ sessionId: 's', nodes: [{ elementId: 'n1', text: 'counter' }] });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Not renamed: the source was not asked to rename 'n1'.");
        } finally {
            restore();
        }
    });

    it('modify-nodes says what it renamed, not the label of a model not yet re-read', async () => {
        const sink = scriptedSink([[{ op: 'wfpy.renameNode', ok: true }]]);
        const restore = stubSuper(ModifyNodesMcpToolHandler, () => sink.next());
        try {
            const handler = new AgentDispatchModifyNodesMcpToolHandler();
            (handler as any).modelState = { root: GGraph.builder().id('root').build(), index: { find: () => ({}) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({ sessionId: 's', nodes: [{ elementId: 'n1', text: 'counter' }] });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toBe("Renamed 'n1' to 'counter'; its uses in the source follow.");
        } finally {
            restore();
        }
    });

    it('modify-nodes text that the producer refuses comes back as an error with its reason', async () => {
        const sink = scriptedSink([[{ op: 'wfpy.renameNode', ok: false, message: "'counter' is already a node of this workflow" }]]);
        const restore = stubSuper(ModifyNodesMcpToolHandler, () => sink.next());
        try {
            const handler = new AgentDispatchModifyNodesMcpToolHandler();
            (handler as any).modelState = { root: GGraph.builder().id('root').build(), index: { find: () => ({}) } };
            (handler as any).aliasService = { lookup: (id: string) => id };
            (handler as any).editOutcomes = sink;
            const result = await (handler as any).createResult({ sessionId: 's', nodes: [{ elementId: 'n1', text: 'counter' }] });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("'counter' is already a node of this workflow");
        } finally {
            restore();
        }
    });

    it("a node's label is the name in its header, not a direct child", () => {
        const name = new GLabel();
        name.id = 'n1_name';
        name.type = WorkflowDiagramTypes.LABEL_NAME;
        const header = GNode.builder().id('n1_header').type('comp:header').build();
        header.children.push(name);
        name.parent = header;
        const node = GNode.builder().id('n1').type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(header).build();
        expect(new NamedNodeMcpLabelProvider().getLabel(node)?.id).toBe('n1_name');
    });

    it('element types are labelled with the palette rows that share them, and the args that pick each', () => {
        const provider = new PaletteElementTypesProvider();
        (provider as any).operationHandlerRegistry = { getAll: () => [] };
        const base = { nodeTypes: [{ id: 'node:external-actor', label: 'Create Node' }, { id: 'node:actor', label: 'Create Node' }], edgeTypes: [] };
        const proto = Object.getPrototypeOf(PaletteElementTypesProvider.prototype);
        const original = proto.get;
        proto.get = () => base;
        try {
            (provider as any).storageOptions = {
                entityPaletteItems: [
                    { elementTypeId: 'node:actor', label: 'Task', description: 'Create a Task instance' },
                    { elementTypeId: 'node:external-actor', label: 'Tool', description: 'An external tool' },
                    { elementTypeId: 'node:external-actor', label: 'Agent', description: 'An agent', args: { agentTask: true } }
                ]
            };
            const types = provider.get();
            const external = types.nodeTypes.find(entry => entry.id === 'node:external-actor')!;
            expect(external.label).toBe('Tool / Agent');
            expect(external.description).toBe('Tool: An external tool; Agent (args {"agentTask":true}): An agent');
            expect(types.nodeTypes.find(entry => entry.id === 'node:actor')!.label).toBe('Task');
        } finally {
            proto.get = original;
        }
    });

});
