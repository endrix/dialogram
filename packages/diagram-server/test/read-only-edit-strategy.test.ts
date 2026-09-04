// Pins the `EditStrategy` seam on `WorkflowDiagramModule`.
//
// The rule was once "read-only registers no operation handlers". That has been
// narrowed to "read-only registers no handler that edits the SOURCE", because
// the original was too blunt to be right: laying a diagram out and moving a
// node are operations, and neither touches the document the diagram came from.
// They write to the separate layout file, which is presentation state.
//
// Under the old rule a read-only diagram could not be laid out at all. The
// context menu offers its layout entries unconditionally, so each appeared and
// each did nothing, since a GLSP operation with no bound handler fails
// silently — and a generated diagram, which is the kind most likely to be
// read-only, is also the kind that most needs laying out, because nobody
// placed its nodes by hand.
//
// What has not changed is the guarantee that matters: a read-only session
// cannot write to the source. That is enforced by `saveSourceModel` being a
// no-op, asserted below, and by none of the consumer's source-editing modules
// being configured.
//
// `configureOperationHandlers` is a `protected` method
// GLSP's `DiagramModule` calls with an `InstanceMultiBinding<OperationHandlerConstructor>` -- we
// invoke it directly through an `as any` cast (matching this test suite's existing pattern for
// exercising protected members) with a recording fake that captures every `.add(...)` call
// instead of registering it with a real inversify container.
//
// Also pins the F2 final-review finding: `edits: 'read-only'` must make `saveSourceModel` a
// no-op too. That half of the original spec stands unchanged and is now the load-bearing half.
// `WorkflowDiagramModule.bindSourceModelStorage()` binds `ReadOnlySourceModelStorage` --
// overriding `saveSourceModel` to a no-op -- when constructed with `{ edits: 'read-only' }`, and
// `WorkflowSourceModelStorage` (the default, editable path) otherwise.
import { afterEach, describe, expect, it } from 'vitest';
import * as vscodeMock from './vscode-mock';
import { WorkflowDiagramModule } from '../src/server/diagram-module';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { ReadOnlySourceModelStorage } from '../src/server/read-only-source-model-storage';

describe('EditStrategy read-only', () => {
    it('a read-only module binds the presentation handlers, and so does an editable one', () => {
        const editable = new WorkflowDiagramModule();
        const readOnly = new WorkflowDiagramModule({ edits: 'read-only' });

        const collect = (module: WorkflowDiagramModule): string[] => {
            const registered: string[] = [];
            const recordingBinding = { add: (handler: { name: string }) => registered.push(handler.name) };
            (module as any).configureOperationHandlers(recordingBinding);
            return registered;
        };

        const editableNames = collect(editable);
        const readOnlyNames = collect(readOnly);

        expect(editableNames.length).toBeGreaterThan(0);
        // Named one by one rather than counted, because the regression this
        // guards against is a single layout going quiet, not all of them.
        for (const handler of [
            'WorkflowLayoutOperationHandler',
            'WorkflowLayoutBoundaryFlowOperationHandler',
            'WorkflowLayoutSerpentineMeshOperationHandler',
            'WorkflowChangeBoundsOperationHandler',
            'WorkflowChangeRoutingPointsOperationHandler'
        ]) {
            expect(readOnlyNames, `${handler} is missing from a read-only session`).toContain(handler);
            expect(editableNames, `${handler} is missing from an editable session`).toContain(handler);
        }

        // The two differ only by what the consumer injects, which is where
        // source editing lives.
        expect(readOnlyNames).toEqual(editableNames);
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
