// Assembly-level pin for the `EditStrategy.operationModules` seam: a consumer-supplied
// operation module handed to the PUBLIC `createWorkflowServerModules({ edits })` entry must reach
// `WorkflowDiagramModule.configureOperationHandlers` and have its `configure(binding)` invoked
// through the genuine GLSP DI path -- not via an `as any` call on the protected method (that
// narrower unit is already covered by read-only-edit-strategy.test.ts).
//
// `createWorkflowServerModules` returns `[loggerModule, serverModule]`; the assembled
// `WorkflowDiagramModule` lives inside the ServerModule's `diagramModules` map. Loading that module
// into a fresh inversify container runs its real `configure`, which drives the operation-handler
// multibinding through `configureOperationHandlers`, which iterates `edits.operationModules` and
// calls each module's `configure`.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container, type ContainerModule } from 'inversify';
import { createWorkflowServerModules } from '../src/server/server-module';
import type { DiagramOperationModule } from '../src/server/operation-modules';
import type { EditStrategy } from '@dialogram/shared';

/** A stub handler class; identity only, never instantiated by this test. */
class StubOperationHandler {}

/** Build a neutral operation-module handle that records whether (and how) it was configured. */
function makeRecordingModule(): { module: DiagramOperationModule; configureCalls: number; addedHandlers: unknown[] } {
    const record = { configureCalls: 0, addedHandlers: [] as unknown[] };
    const module: DiagramOperationModule = {
        __diagramOperationModule: true,
        configure(binding) {
            record.configureCalls++;
            binding.add(StubOperationHandler as never);
            record.addedHandlers.push(StubOperationHandler);
        }
    };
    return { module, get configureCalls() { return record.configureCalls; }, get addedHandlers() { return record.addedHandlers; } };
}

/** Load the WorkflowDiagramModule assembled by `createWorkflowServerModules` into a fresh container. */
function loadAssembledDiagramModule(edits: EditStrategy): void {
    const modules = createWorkflowServerModules({ edits });
    // `[loggerModule, serverModule]`; the diagram module is nested in the ServerModule.
    const serverModule = modules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const diagramModule = [...serverModule.diagramModules.values()][0][0];
    // `container.load` runs the module's `configure` synchronously (binding phase only, no
    // resolution), which drives `configureOperationHandlers`.
    new Container().load(diagramModule);
}

describe('createWorkflowServerModules threads edits.operationModules to configureOperationHandlers', () => {
    it('invokes each operation module\'s configure with the real operation-handler binding', () => {
        const recording = makeRecordingModule();

        loadAssembledDiagramModule({ operationModules: [recording.module] });

        expect(recording.configureCalls).toBe(1);
        expect(recording.addedHandlers).toEqual([StubOperationHandler]);
    });

    it('iterates and configures every operation module in the strategy', () => {
        const first = makeRecordingModule();
        const second = makeRecordingModule();

        loadAssembledDiagramModule({ operationModules: [first.module, second.module] });

        expect(first.configureCalls).toBe(1);
        expect(second.configureCalls).toBe(1);
    });

    it('configures no operation modules for a read-only edit strategy', () => {
        // `read-only` short-circuits before the operationModules loop; the assembled module must
        // still load cleanly through the public entry.
        expect(() => loadAssembledDiagramModule('read-only')).not.toThrow();
    });
});
