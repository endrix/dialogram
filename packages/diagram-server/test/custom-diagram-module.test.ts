// SP4 Task 1: `createWorkflowServerModules({ diagramModuleFactory })` is the
// build-time library seam that lets a consumer (mlir-viewer) replace the stock
// `WorkflowDiagramModule` with its OWN GLSP DiagramModule, constructed in the
// consumer's bundle/realm. These tests pin:
//  (1) a custom read-only DiagramModule boots the GLSP server in ONE realm --
//      `initializeContainer(...serverModules)` + `container.get(GLSPServer)`
//      (the SP2c production-topology pattern) does not throw;
//  (2) the custom module replaces the stock one (its diagramType is the only
//      registered diagram type -- stock `WorkflowDiagramModule` is gone);
//  (3) neutral model-source binding coexistence BOTH directions: the stock path
//      keeps the neutral `DIAGRAM_MODEL_SOURCE` binding, while a custom module
//      binding its OWN model source wins (the neutral binding is `isBound`-guarded
//      and never clobbers the consumer's).
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { GLSPClientProxy, GLSPServer } from '@eclipse-glsp/server';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import { createWorkflowServerModules } from '../src/server/server-module';
import { WorkflowDiagramModule } from '../src/server/diagram-module';
import { DIAGRAM_MODEL_SOURCE } from '../src/server/model-source-token';
import type { DiagramModelSource } from '@dialogram/shared';

const NEUTRAL_SOURCE: DiagramModelSource = { getGraph: async () => undefined };

/**
 * A minimal read-only custom DiagramModule with a DISTINCT diagram type, standing
 * in for a library consumer's server module. When handed an `ownSource` it binds
 * its OWN `DIAGRAM_MODEL_SOURCE` (loaded first, so the neutral binding must yield).
 */
class CustomDiagramModule extends WorkflowDiagramModule {
    constructor(private readonly ownSource?: DiagramModelSource) {
        super({ edits: 'read-only' });
    }

    override get diagramType(): string {
        return 'custom-diagram';
    }

    override configure(bind: any, unbind: any, isBound: any, rebind: any): void {
        super.configure(bind, unbind, isBound, rebind);
        if (this.ownSource && !isBound(DIAGRAM_MODEL_SOURCE)) {
            bind(DIAGRAM_MODEL_SOURCE).toConstantValue(this.ownSource);
        }
    }
}

/** Rebuild the EXACT server-start container topology (SP2c pattern). */
function buildServerContainer(serverModules: unknown[]): Container {
    const container = new Container();
    const proxyModule = new ContainerModule((bind) =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as any)
    );
    initializeContainer(container, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    return container;
}

/**
 * Load the assembled diagram-session module array (`[diagramModule, ...additional]`)
 * into a fresh container so a single token can be resolved without booting the
 * whole server. Mirrors the load order GLSP's client-session factory uses.
 */
function loadSessionContainer(serverModules: unknown[]): Container {
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const modules = [...serverModule.diagramModules.values()][0];
    const container = new Container();
    container.load(...(modules as ContainerModule[]));
    return container;
}

describe('createWorkflowServerModules — custom diagramModuleFactory', () => {
    it('boots the GLSP server with a custom read-only DiagramModule (one realm, get(GLSPServer))', () => {
        const serverModules = createWorkflowServerModules({
            diagramModuleFactory: () => new CustomDiagramModule(),
            edits: 'read-only',
            modelSourceFactory: () => NEUTRAL_SOURCE
        });
        const container = buildServerContainer(serverModules);
        expect(() => container.get(GLSPServer)).not.toThrow();
    });

    it('registers the custom module under its own diagramType (stock WorkflowDiagramModule replaced)', () => {
        const serverModules = createWorkflowServerModules({
            diagramModuleFactory: () => new CustomDiagramModule()
        });
        const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, unknown[]> };
        expect([...serverModule.diagramModules.keys()]).toEqual(['custom-diagram']);
    });

    it('keeps the stock WorkflowDiagramModule when no factory is supplied', () => {
        const serverModules = createWorkflowServerModules({ edits: 'read-only' });
        const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, unknown[]> };
        expect([...serverModule.diagramModules.keys()]).toEqual(['cal-network-diagram']);
    });
});

describe('neutral model-source binding coexistence', () => {
    it('stock path keeps the neutral model source (no custom module)', () => {
        const serverModules = createWorkflowServerModules({
            edits: 'read-only',
            modelSourceFactory: () => NEUTRAL_SOURCE
        });
        const container = loadSessionContainer(serverModules);
        expect(container.get(DIAGRAM_MODEL_SOURCE)).toBe(NEUTRAL_SOURCE);
    });

    it('a custom module binding its own model source wins over the neutral binding', () => {
        const ownSource: DiagramModelSource = { getGraph: async () => undefined };
        const serverModules = createWorkflowServerModules({
            diagramModuleFactory: () => new CustomDiagramModule(ownSource),
            edits: 'read-only',
            modelSourceFactory: () => NEUTRAL_SOURCE
        });
        const container = loadSessionContainer(serverModules);
        // Single unambiguous binding (isBound-guarded) resolving to the consumer's own source.
        expect(container.get(DIAGRAM_MODEL_SOURCE)).toBe(ownSource);
        expect(container.get(DIAGRAM_MODEL_SOURCE)).not.toBe(NEUTRAL_SOURCE);
    });
});
