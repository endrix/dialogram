// What a session is given of the host's say over its loads: the product's
// words for the platform's steps, the name its diagnostics carry, and the
// cancellation of a load whose reader has gone. Each per session, and absent
// (as before) where the host gives nothing.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import { ClientActionKinds, ClientId, GLSPClientProxy, SourceModelStorage } from '@eclipse-glsp/server';
import type { DiagramModelSource, LoadPhaseWords } from '@dialogram/shared';
import { createWorkflowServerModules } from '../src/server/server-module';
import { WorkflowDiagramModule } from '../src/server/diagram-module';
import { DIAGNOSTIC_SOURCE } from '../src/server/graph-diagnostics';
import { LOAD_PHASE_WORDS, LoadProgressReporter } from '../src/server/load-progress';
import { LoadCancellation } from '../src/server/load-cancellation';
import { LoadCancellingActionDispatcher } from '../src/server/load-cancelling-dispatcher';

const SOURCE: DiagramModelSource = { getGraph: async () => undefined };

/**
 * A diagram session's container as GLSP makes it: a child of the server's
 * container, loaded with the session modules, given the client's id and
 * action kinds (see custom-diagram-module.test.ts for the server half).
 */
function session(serverModules: unknown[]): Container {
    const server = new Container();
    const proxyModule = new ContainerModule((bind) =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as any)
    );
    initializeContainer(server, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const modules = [...serverModule.diagramModules.values()][0];
    const container = server.createChild();
    container.load(...(modules as ContainerModule[]));
    for (const [token, value] of [[ClientId, 'client-1'], [ClientActionKinds, []]] as const) {
        if (container.isBound(token)) {
            container.rebind(token).toConstantValue(value);
        } else {
            container.bind(token).toConstantValue(value);
        }
    }
    return container;
}

describe('a session\'s say over its loads', () => {
    const words: LoadPhaseWords = () => false;

    it('has the product\'s words, its name, and a cancellation of its own', () => {
        const modules = createWorkflowServerModules({ modelSourceFactory: () => SOURCE, loadPhaseWords: words, diagnosticSource: 'Fixture Viewer' });
        const one = session(modules);
        const two = session(modules);

        expect(one.get(LOAD_PHASE_WORDS)).toBe(words);
        expect(one.get(DIAGNOSTIC_SOURCE)).toBe('Fixture Viewer');
        expect(one.get(LoadCancellation)).toBe(one.get(LoadCancellation));
        expect(one.get(LoadCancellation)).not.toBe(two.get(LoadCancellation));
        expect((one.get(LoadProgressReporter) as any).phaseWords).toBe(words);
    });

    it('hands them to the storage that loads the model', () => {
        const container = session(createWorkflowServerModules({ modelSourceFactory: () => SOURCE, diagnosticSource: 'Fixture Viewer' }));
        const storage = container.get<any>(SourceModelStorage);

        expect(storage.diagnosticSource).toBe('Fixture Viewer');
        expect(storage.loadCancellation).toBe(container.get(LoadCancellation));
    });

    it('has neither words nor a name where the host gives none', () => {
        const container = session(createWorkflowServerModules({ modelSourceFactory: () => SOURCE, diagnosticSource: '  ' }));

        expect(container.isBound(LOAD_PHASE_WORDS)).toBe(false);
        expect(container.isBound(DIAGNOSTIC_SOURCE)).toBe(false);
    });

    it('dispatches its actions through the dispatcher that cancels', () => {
        expect((new WorkflowDiagramModule() as any).bindActionDispatcher()).toBe(LoadCancellingActionDispatcher);
    });
});
