// What a read-only session is allowed to do.
//
// "Read-only" has to mean "cannot change the SOURCE", not "cannot do anything".
// The distinction matters because the operations that lay a diagram out and the
// ones that move a node do not touch the document the diagram was generated
// from: they write to the separate layout file, which is presentation state.
//
// Registering no operation handlers at all made a read-only diagram one that
// could not be laid out. The context menu offers its three layout entries
// unconditionally, so all three appeared and all three did nothing when
// clicked, because a GLSP operation with no bound handler fails silently. A
// node dragged by hand did not persist either, so the arrangement someone made
// to compensate was gone by the next open.
//
// That hit generated diagrams hardest, which are exactly the ones that most
// need laying out: nobody placed their nodes by hand to begin with.
//
// These tests pin both halves — the presentation operations are bound, and the
// consumer's source-editing modules still are not.

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramModule } from '../src/server/diagram-module';

/** Collects what a module registers, without booting a container. */
function registeredHandlers(edits: 'read-only' | { operationModules: unknown[] }): string[] {
    const names: string[] = [];
    const binding = { add: (ctor: { name: string }) => names.push(ctor.name) };
    const module = new WorkflowDiagramModule({ edits } as never);
    (module as never as { configureOperationHandlers(b: unknown): void }).configureOperationHandlers(
        binding
    );
    return names;
}

/** Operations that only ever change presentation, never the source document. */
const PRESENTATION_HANDLERS = [
    'WorkflowLayoutOperationHandler',
    'WorkflowLayoutBoundaryFlowOperationHandler',
    'WorkflowLayoutSerpentineMeshOperationHandler',
    'WorkflowChangeBoundsOperationHandler',
    'WorkflowChangeRoutingPointsOperationHandler',
    'WorkflowResetEdgeRoutesOperationHandler',
    'WorkflowRerouteEdgesAvoidOverlapsOperationHandler'
];

describe('a read-only diagram session', () => {
    it('binds a handler for every layout the context menu offers', () => {
        const bound = registeredHandlers('read-only');
        // Named individually rather than counted, because the failure this
        // guards against is one menu entry going quiet, not all of them.
        for (const handler of [
            'WorkflowLayoutOperationHandler',
            'WorkflowLayoutBoundaryFlowOperationHandler',
            'WorkflowLayoutSerpentineMeshOperationHandler'
        ]) {
            expect(bound, `${handler} is not bound, so its menu entry does nothing`).toContain(
                handler
            );
        }
    });

    it('lets a reader move a node and keep the result', () => {
        const bound = registeredHandlers('read-only');
        expect(bound).toContain('WorkflowChangeBoundsOperationHandler');
        expect(bound).toContain('WorkflowChangeRoutingPointsOperationHandler');
    });

    it('binds every presentation operation, and the same set an editable one does', () => {
        const readOnly = registeredHandlers('read-only');
        const editable = registeredHandlers({ operationModules: [] });
        for (const handler of PRESENTATION_HANDLERS) {
            expect(readOnly).toContain(handler);
            expect(editable).toContain(handler);
        }
    });

    it('still refuses the consumer modules that edit the source', () => {
        // The one thing read-only must keep out. A module handed here would be
        // the toolkit's source-editing handlers, and a read-only session must
        // never invoke them.
        let configured = false;
        // Carries the brand the platform's own type guard looks for; a plain
        // object with a `configure` is ignored, which would make this test pass
        // for the wrong reason.
        const sourceEditing = {
            __diagramOperationModule: true,
            configure: () => {
                configured = true;
            }
        };
        registeredHandlers({ operationModules: [sourceEditing] } as never);
        expect(configured, 'an editable session configures its operation modules').toBe(true);

        configured = false;
        const module = new WorkflowDiagramModule({
            edits: 'read-only',
            operationModules: [sourceEditing]
        } as never);
        (module as never as { configureOperationHandlers(b: unknown): void }).configureOperationHandlers({
            add: () => undefined
        });
        expect(configured, 'a read-only session must not configure them').toBe(false);
    });
});
