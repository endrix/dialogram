import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Action } from '@eclipse-glsp/server';
import { CreateTaskTypeOperation } from '@dialogram/shared';
import { DiagramMcpModule } from '@dialogram/diagram-server/server/mcp-diagram-module';
import { CreateTaskTypeMcpToolHandler } from '../src/server/operations/create-task-type-mcp-tool-handler';
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
});
