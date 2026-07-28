// T1 (GLSP-MCP Phase B): `createWorkflowServerModules({ mcp })` optionally boots the
// GLSP-MCP loopback server by loading the two MCP DI modules — the server-scope
// `NodeMcpServerModule` (launcher + defaults + server-scope tools) and the per-session
// `DiagramMcpModule` (diagram-scope tool/resource/prompt handler multi-bindings).
//
// The flag is a hard gate: with `mcp.enabled:false` the returned module list and the
// assembled diagram-session module array are byte-parity with the legacy path (no MCP
// bindings leak). With `mcp.enabled:true` the server container aliases the launcher under
// `GLSPServerInitializer`/`GLSPServerListener` (its own module does the alias — we never
// hand-bind it), and the session container resolves the 16 default diagram-scope tool
// constructors.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import {
    GLSPClientProxy,
    GLSPServerInitializer,
    GLSPServerListener
} from '@eclipse-glsp/server';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import {
    AbstractMcpServerLauncher,
    McpDiagramToolHandlerConstructor
} from '@eclipse-glsp/server-mcp';
import { createWorkflowServerModules } from '../src/server/server-module';
import type { DiagramModelSource } from '@dialogram/shared';

const NEUTRAL_SOURCE: DiagramModelSource = { getGraph: async () => undefined };

/** Rebuild the EXACT server-start container topology (SP2c pattern). */
function buildServerContainer(serverModules: unknown[]): Container {
    const container = new Container();
    const proxyModule = new ContainerModule(bind =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as never)
    );
    initializeContainer(container, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    return container;
}

/** Load the assembled diagram-session module array into a fresh container (binding phase only). */
function loadSessionContainer(serverModules: unknown[]): Container {
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const modules = [...serverModule.diagramModules.values()][0];
    const container = new Container();
    container.load(...(modules as ContainerModule[]));
    return container;
}

/** Number of modules in the single assembled diagram-session array. */
function sessionModuleCount(serverModules: unknown[]): number {
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    return [...serverModule.diagramModules.values()][0].length;
}

describe('createWorkflowServerModules — MCP opt-in (T1)', () => {
    it('is byte-parity with the legacy path when mcp is absent or disabled', () => {
        const baseline = createWorkflowServerModules({ modelSourceFactory: () => NEUTRAL_SOURCE });
        const disabled = createWorkflowServerModules({
            modelSourceFactory: () => NEUTRAL_SOURCE,
            mcp: { enabled: false }
        });

        // Top-level module list unchanged (no server-scope NodeMcpServerModule appended).
        expect(disabled.length).toBe(baseline.length);
        expect(disabled.length).toBe(2);

        // Assembled diagram-session module array unchanged (no DiagramMcpModule appended).
        expect(sessionModuleCount(disabled)).toBe(sessionModuleCount(baseline));

        // No diagram-scope MCP tool constructors bound on the disabled path.
        const session = loadSessionContainer(disabled);
        expect(session.isBound(McpDiagramToolHandlerConstructor)).toBe(false);
    });

    it('appends the server-scope MCP module and aliases the launcher lifecycle when enabled', () => {
        const serverModules = createWorkflowServerModules({
            modelSourceFactory: () => NEUTRAL_SOURCE,
            mcp: { enabled: true }
        });

        // One extra top-level module: the server-scope NodeMcpServerModule.
        expect(serverModules.length).toBe(3);

        const container = buildServerContainer(serverModules);
        expect(container.isBound(AbstractMcpServerLauncher)).toBe(true);

        const launcher = container.get(AbstractMcpServerLauncher);
        // The module aliases the launcher under both lifecycle hooks (we never hand-bind them).
        expect(container.getAll(GLSPServerInitializer)).toContain(launcher);
        expect(container.getAll(GLSPServerListener)).toContain(launcher);
    });

    it('binds the 16 default diagram-scope tool constructors in the session container when enabled', () => {
        const serverModules = createWorkflowServerModules({
            modelSourceFactory: () => NEUTRAL_SOURCE,
            mcp: { enabled: true }
        });

        // One extra diagram-session module: the per-session DiagramMcpModule.
        const baseline = createWorkflowServerModules({ modelSourceFactory: () => NEUTRAL_SOURCE });
        expect(sessionModuleCount(serverModules)).toBe(sessionModuleCount(baseline) + 1);

        // `InstanceMultiBinding` binds the constructor list as a single constant array
        // (`toConstantValue(bindings)`), so the registry initializer reads it via `.get`.
        const session = loadSessionContainer(serverModules);
        const toolConstructors = session.get<unknown[]>(McpDiagramToolHandlerConstructor);
        expect(toolConstructors).toHaveLength(16);
    });
});
