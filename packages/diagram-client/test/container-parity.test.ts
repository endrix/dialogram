/**
 * Container parity — the SP3 Task-2 oracle.
 *
 * The old monolith client module mixed neutral GLSP infrastructure,
 * stock workflow model/view registration, and workflow feature UI. Task 2 splits
 * it into a neutral base module (`diagramBaseModule`) + `workflowViewsModule` +
 * `workflowFeaturesModule`, recomposed by `createDiagramContainer`. The shipped
 * stock bundle MUST behave identically.
 *
 * This test records the DI registrations of the modules the factory composes
 * (`composeDiagramModules`) and asserts their union equals a baseline captured
 * from the pre-refactor monolith (`fixtures/container-parity.baseline.json`,
 * generated from commit 26442ac's monolith module). No binding may be
 * dropped, added, or altered. It also pins the module composition order.
 *
 * The baseline is no longer a pure capture of that commit: features added since
 * the split are appended to it deliberately, and the fixture currently carries
 * these additions — `IEdgeRouter -> LibavoidEdgeRouter` (the client-side live
 * routing tier), `ChangeBoundsTool -> WorkflowChangeBoundsTool` (the mouse-drag
 * threshold) and `IDiagramStartup -> WorkflowPaletteIconStartup` (draws the
 * palette icons a product contributed), the `dialogram.rerunFromHere` action handler
 * (resumes the shown run before a node's last firing) and the `dialogram.openInOwnEditor`
 * one (opens a nested workflow's file as a root of its own), the hierarchy outline panel
 * (bound to itself and as a model-root listener) and the node list panel beside it (bound the
 * same two ways), and "Go to Error" (its action handler and
 * the focus-after-load service, bound the same two ways), and the `dialogram.openView` action
 * handler (shows a view of a unit besides its structure, in place), the group container and its
 * boundary port (`node:group`, `port:group-boundary`), the `IMovementRestrictor` that keeps a
 * dragged node inside the node holding it, and the `ComputedBoundsApplicator` that never resizes a
 * workflow node from a measurement, the status source's context-menu provider with its
 * `dialogram.runStatusCommand` handler ("Show <label>" and "Clear <label>" on the canvas, running
 * the profile's commands), and the `ExecutionStatesFeedbackCommand` that draws published node
 * states, and the read-only view marker (hides the palette's tools while the view shown is
 * read-only, bound to itself and as a model-root listener), and the selection trace (its listener,
 * bound to itself and as a selection listener, and the `SelectionTraceFeedbackCommand` that draws
 * the path), the selection focus (its postprocessor, bound to itself and as a vnode
 * postprocessor, which fades what the selection's links leave out), the bus toggle's mouse listener (opens or closes a port bundle) and the node
 * toggle's (opens a node holding a graph of its own in place), and the toggle anchor (keeps
 * the toggled node where it was on screen once the view is laid out again, bound to itself
 * and as a model-root listener, with GLSP's update command rebound to the
 * `AnchoredUpdateModelCommand` that scrolls in the update's own animation), and an
 * automaton's state and transition (`node:state`, `edge:transition`), and the
 * `FitClearOfOverlaysCommand` that fits the diagram where the canvas's overlays leave it free, and the
 * `dialogram.nodeAction` action handler (carries what a producer offers on a node or the canvas to
 * the product's command, node-actions.ts), and the `dialogram.revealNode` action handler (selects and
 * centres the node the product's command names, once the model that has it loads) — plus two
 * changes: the graph is drawn by `DetailGraphView` (GLSP's `GGraphView`, its svg marked with the
 * level of detail of the zoom, zoom-detail.ts), and `label:boundary:type` is bound to
 * the non-editable `BoundaryLabel`, because editing it renamed the port.
 * The loading indicator's model-root listener is here too (bound to itself and as a listener): it
 * takes the indicator down when the model it was waiting for arrives.
 * So is the view-options service (view-options.ts): bound to itself, as a
 * model-root listener (it reads each model's view options), and as the handler
 * of `dialogram.viewOptionsChanged`, the action it dispatches to a product's
 * client modules, so that the action is known whether or not a product
 * handles it.
 * So is the diagram surface's seam (diagram-surface.ts): its host (bound to itself, as a vnode
 * postprocessor and as a selection listener), its click listener (bound to itself and as a mouse
 * listener), the record of what the hidden render drew (bound to itself and as a hidden vnode
 * postprocessor), and Center bound to the `SurfaceAwareCenterCommand` that frames the content as
 * Fit does (viewport-content.ts).
 * The oracle still does its job: it fails on any binding this composition gains
 * or loses, and updating the fixture is the deliberate act of accepting one.
 * Regenerate it only after confirming the diff contains exactly the bindings the
 * change intends — never to make a red test go green.
 */
import { describe, it, expect } from 'vitest';
import baseline from './fixtures/container-parity.baseline.json';
import {
    recordModuleRegistrations,
    sortEntries,
    type RegistrationEntry
} from './container-registration-recorder';
import { composeDiagramModules } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { workflowViewsModule } from '../src/stock-views.module';
import { workflowFeaturesModule } from '../src/stock-features.module';

const STOCK_FEATURES = [workflowViewsModule, workflowFeaturesModule];

describe('container parity — split modules reproduce the monolith', () => {
    it('the stock composition union equals the monolith baseline', () => {
        const composed = recordModuleRegistrations(
            composeDiagramModules({ clientId: 'workflow_0', features: STOCK_FEATURES })
        );
        expect(composed).toEqual(sortEntries(baseline as RegistrationEntry[]));
    });

    it('composes exactly [base, views, features] in order for the stock entry', () => {
        expect(composeDiagramModules({ clientId: 'workflow_0', features: STOCK_FEATURES })).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule
        ]);
    });

    it('withStockViews prepends workflowViewsModule before consumer features', () => {
        expect(
            composeDiagramModules({ clientId: 'workflow_0', features: [workflowFeaturesModule], withStockViews: true })
        ).toEqual([diagramBaseModule, workflowViewsModule, workflowFeaturesModule]);
    });

    it('no stock model/view registration leaks into the neutral base', () => {
        const baseOnly = recordModuleRegistrations([diagramBaseModule]);
        const stockModelElements = baseOnly.filter(
            entry => entry.op === 'modelElement' && !String(entry.typeId).includes('routing')
        );
        expect(stockModelElements).toEqual([]);
    });
});
