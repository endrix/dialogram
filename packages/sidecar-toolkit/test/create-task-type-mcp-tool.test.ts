import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Action } from '@eclipse-glsp/server';
import { CreateTaskTypeOperation, WorkflowDiagramMetadata } from '@dialogram/shared';
import { DiagramMcpModule } from '@dialogram/diagram-server/server/mcp-diagram-module';
import { CreateTaskTypeMcpToolHandler } from '../src/server/operations/create-task-type-mcp-tool-handler';
import { SetNodeParametersMcpToolHandler } from '../src/server/operations/set-node-parameters-mcp-tool-handler';
import { AgentEditOutcomeSink } from '@dialogram/diagram-server/server/agent-edit-outcome';
import { createSidecarOperationModules } from '../src/server/operation-modules';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

/**
 * Collect the tool-handler constructors `DiagramMcpModule.configureToolHandlers` registers,
 * mirroring `InstanceMultiBinding`'s add/remove-by-reference semantics (see mcp-diagram-module.test).
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
    (module as unknown as { configureToolHandlers(b: typeof binding): void }).configureToolHandlers(binding);
    return ctors;
}

describe('create-task-type GLSP-MCP operation tool', () => {
    const names = (module: DiagramMcpModule) => resolveToolHandlerCtors(module).map((c) => (new (c as new () => { name?: string })()).name);
    const sidecarEdits = {
        operationModules: createSidecarOperationModules({
            settingsNamespace: 'x', sidecarOperationPrefix: 'x', sidecarCommandSettingKey: 'sidecarCommand', sidecarCommandDefault: 'x-sidecar',
            cliCommandSettingKey: 'cliCommand', cliCommandDefault: 'x', operationKinds: { createEntityPort: 'x.c', deleteEntityPort: 'x.d' },
            acceptedOperationPrefixes: ['x'], graphAcquisition: 'cli-plan', ...NEUTRAL_CREATE_NODE_CONFIG
        })
    };

    it('is offered by the sidecar operation module that handles it, not by the platform', () => {
        expect(names(new DiagramMcpModule())).not.toContain(CreateTaskTypeMcpToolHandler.NAME);
        expect(names(new DiagramMcpModule({ edits: sidecarEdits }))).toContain(CreateTaskTypeMcpToolHandler.NAME);
        expect(CreateTaskTypeMcpToolHandler.NAME).toBe('create-task-type');
    });

    it('is not offered, nor any mutating platform tool, on a read-only diagram', () => {
        const offered = names(new DiagramMcpModule({ edits: 'read-only' }));
        expect(offered).not.toContain(CreateTaskTypeMcpToolHandler.NAME);
        for (const mutating of ['create-nodes', 'create-edges', 'modify-nodes', 'modify-edges', 'delete-elements', 'save-model']) {
            expect(offered, mutating).not.toContain(mutating);
        }
        expect(offered).toContain('query-elements');
    });

    it('is a write tool: readOnlyHint is false (inherits the operation-tool base annotations)', () => {
        const handler = new CreateTaskTypeMcpToolHandler();
        expect(handler.readOnlyHint).toBe(false);
    });

    it('dispatches a dialogram.createTaskType operation on a writable model', async () => {
        const handler = new CreateTaskTypeMcpToolHandler();
        const dispatched: Action[] = [];
        (handler as any).modelState = { isReadonly: false };
        (handler as any).actionDispatcher = {
            dispatch: async (action: Action) => {
                dispatched.push(action);
            }
        };

        const result = await handler.handle({ sessionId: 's', name: 'Foo' } as any);

        expect(result.isError).toBeFalsy();
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toEqual(CreateTaskTypeOperation.create({ name: 'Foo' }));
        expect((dispatched[0] as any).kind).toBe('dialogram.createTaskType');
    });

    it('refuses on a read-only model (inherited McpReadOnlyError gate) without dispatching', async () => {
        const handler = new CreateTaskTypeMcpToolHandler();
        const dispatched: Action[] = [];
        (handler as any).modelState = { isReadonly: true };
        (handler as any).actionDispatcher = {
            dispatch: async (action: Action) => {
                dispatched.push(action);
            }
        };

        const result = await handler.handle({ sessionId: 's', name: 'Foo' } as any);

        expect(result.isError).toBe(true);
        expect(dispatched).toHaveLength(0);
    });

    it('asks for the kind it is given, and answers what the source said', async () => {
        const handler = new CreateTaskTypeMcpToolHandler();
        const sink = new AgentEditOutcomeSink();
        const dispatched: Action[] = [];
        (handler as any).modelState = { isReadonly: false };
        (handler as any).editOutcomes = sink;
        (handler as any).actionDispatcher = {
            dispatch: async (action: Action) => {
                dispatched.push(action);
                sink.record({ op: 'wfpy.createTaskType', ok: (action as any).name !== 'Taken', message: "'Taken' already exists" });
            }
        };

        const made = await handler.handle({ sessionId: 's', name: 'Summarize', kind: 'agent' } as any);
        expect(dispatched[0]).toEqual(CreateTaskTypeOperation.create({ name: 'Summarize', typeKind: 'agent' }));
        expect(made.isError).toBeFalsy();
        expect((made.content as any)[0].text).toContain("Created the agent type 'Summarize'");

        const refused = await handler.handle({ sessionId: 's', name: 'Taken' } as any);
        expect(refused.isError).toBe(true);
        expect((refused.content as any)[0].text).toContain("'Taken' already exists");
    });
});

describe('set-node-parameters GLSP-MCP operation tool', () => {
    const root = {
        id: 'root', type: 'graph', args: {},
        children: [{ id: 'n7', type: 'node:actor', args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'top_words' }, children: [] }]
    };
    function makeHandler(refuse: Record<string, string> = {}) {
        const handler = new SetNodeParametersMcpToolHandler();
        const sink = new AgentEditOutcomeSink();
        const dispatched: any[] = [];
        (handler as any).modelState = { isReadonly: false, root, index: { find: (id: string) => (id === 'n7' ? root.children[0] : undefined) } };
        (handler as any).aliasService = { lookup: (id: string) => id };
        (handler as any).editOutcomes = sink;
        (handler as any).actionDispatcher = {
            dispatch: async (action: any) => {
                dispatched.push(action);
                const reason = refuse[action.parameterName];
                sink.record({ op: 'wfpy.updateNodeParameter', ok: !reason, ...(reason ? { message: reason } : {}) });
            }
        };
        return { handler, dispatched };
    }

    it('is offered beside create-task-type, by the sidecar operation module', () => {
        expect(SetNodeParametersMcpToolHandler.NAME).toBe('set-node-parameters');
        expect(new SetNodeParametersMcpToolHandler().readOnlyHint).toBe(false);
    });

    it('sets each parameter of the node named, through the panel operation', async () => {
        const { handler, dispatched } = makeHandler();
        const result = await handler.handle({ sessionId: 's', node: 'top_words', parameters: { top_n: '5', label: '"x"' } } as any);
        expect(result.isError).toBeFalsy();
        expect(dispatched).toEqual([
            { kind: 'dialogram.updateEntityParameter', elementId: 'n7', parameterName: 'top_n', newValue: '5' },
            { kind: 'dialogram.updateEntityParameter', elementId: 'n7', parameterName: 'label', newValue: '"x"' }
        ]);
        expect((result.content as any)[0].text).toContain('- top_n = 5');
    });

    it("is an error saying the source's reason for each parameter refused", async () => {
        const { handler } = makeHandler({ nope: "'TopWords' takes no parameter 'nope'" });
        const result = await handler.handle({ sessionId: 's', node: 'n7', parameters: { top_n: '5', nope: '1' } } as any);
        expect(result.isError).toBe(true);
        const text = (result.content as any)[0].text;
        expect(text).toContain('- top_n = 5');
        expect(text).toContain("- nope: 'TopWords' takes no parameter 'nope'");
    });

    it('names a node it cannot find', async () => {
        const { handler, dispatched } = makeHandler();
        const result = await handler.handle({ sessionId: 's', node: 'ghost', parameters: { a: '1' } } as any);
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain("No node 'ghost'");
        expect(dispatched).toEqual([]);
    });
});
