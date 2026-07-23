// Pins the `EditStrategy` seam on `WorkflowDiagramModule`: an editable module (default, no
// options) registers the full set of operation handlers; a module constructed with
// `{ edits: 'read-only' }` registers none. `configureOperationHandlers` is a `protected` method
// GLSP's `DiagramModule` calls with an `InstanceMultiBinding<OperationHandlerConstructor>` -- we
// invoke it directly through an `as any` cast (matching this test suite's existing pattern for
// exercising protected members) with a recording fake that captures every `.add(...)` call
// instead of registering it with a real inversify container.
//
// Also pins the F2 final-review finding: `edits: 'read-only'` must make `saveSourceModel` a
// no-op too (per the spec: "read-only binds no operation handlers and a no-op saveSourceModel").
// `WorkflowDiagramModule.bindSourceModelStorage()` binds `ReadOnlySourceModelStorage` --
// overriding `saveSourceModel` to a no-op -- when constructed with `{ edits: 'read-only' }`, and
// `WorkflowSourceModelStorage` (the default, editable path) otherwise.
import { afterEach, describe, expect, it } from 'vitest';
import * as vscodeMock from './vscode-mock';
import { WorkflowDiagramModule } from '../src/server/diagram-module';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { ReadOnlySourceModelStorage } from '../src/server/read-only-source-model-storage';

describe('EditStrategy read-only', () => {
    it('a read-only module binds no operation handlers, while an editable module binds several', () => {
        const editable = new WorkflowDiagramModule();
        const readOnly = new WorkflowDiagramModule({ edits: 'read-only' });

        const collect = (module: WorkflowDiagramModule): unknown[] => {
            const registered: unknown[] = [];
            const recordingBinding = { add: (handler: unknown) => registered.push(handler) };
            (module as any).configureOperationHandlers(recordingBinding);
            return registered;
        };

        expect(collect(editable).length).toBeGreaterThan(0);
        expect(collect(readOnly)).toEqual([]);
    });

    it('defaults to editable when no options are passed (byte-identical to pre-EditStrategy behavior)', () => {
        const defaultModule = new WorkflowDiagramModule();
        const explicitlyEditableModule = new WorkflowDiagramModule({});

        const collect = (module: WorkflowDiagramModule): unknown[] => {
            const registered: unknown[] = [];
            const recordingBinding = { add: (handler: unknown) => registered.push(handler) };
            (module as any).configureOperationHandlers(recordingBinding);
            return registered;
        };

        expect(collect(defaultModule)).toEqual(collect(explicitlyEditableModule));
    });
});

describe('EditStrategy read-only: saveSourceModel is a no-op', () => {
    const originalOpenTextDocument = vscodeMock.workspace.openTextDocument;

    afterEach(() => {
        (vscodeMock.workspace as any).openTextDocument = originalOpenTextDocument;
    });

    /** Stub `vscode.workspace.openTextDocument` to hand back a fake document that counts `.save()` calls. */
    function stubTextDocument(): { saveCalls: number } {
        const counter = { saveCalls: 0 };
        (vscodeMock.workspace as any).openTextDocument = async () => ({
            save: async () => {
                counter.saveCalls++;
            }
        });
        return counter;
    }

    it('a read-only-bound storage does not call textDoc.save()', async () => {
        const counter = stubTextDocument();
        const storage = new (ReadOnlySourceModelStorage as any)();
        storage.modelState = { sourceUri: 'file:///tmp/read-only-fixture.py' };

        await storage.saveSourceModel({} as any);

        expect(counter.saveCalls).toBe(0);
    });

    it('the default (editable) storage still calls textDoc.save() with the same stub', async () => {
        const counter = stubTextDocument();
        const storage = new (WorkflowSourceModelStorage as any)();
        storage.modelState = { sourceUri: 'file:///tmp/read-only-fixture.py' };

        await storage.saveSourceModel({} as any);

        expect(counter.saveCalls).toBe(1);
    });
});
