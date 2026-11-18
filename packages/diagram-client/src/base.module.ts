/**
 * Neutral diagram base module.
 *
 * The product-agnostic half of the former `workflowDiagramModule` monolith: the
 * GLSP/Sprotty infrastructure and starter-support services that EVERY consumer of
 * the diagram-client library needs regardless of which node/view set it registers
 * (the stock consumers, or a fully custom consumer such as mlir). It carries NO stock
 * model/view registration — those live in `stock-views.module.ts` — and no
 * workflow feature UI — that lives in `stock-features.module.ts`.
 *
 * What it binds:
 *  - logging (ConsoleLogger @ warn),
 *  - viewport preservation across model refresh (ViewportPreservingSetModelCommand),
 *  - initial-viewport centering + post-edit selection polish,
 *  - the diagram grid startup,
 *  - copy/paste with post-paste selection,
 *  - the neutral GLSP routing-handle element configs (edge bendpoint editing),
 *  - the read-only RunningAgentsBar + the execution-overlay message bridge.
 *
 * The RunningAgentsBar and the overlay bridge bind here by design (SP3): they are
 * fed only by the neutral execution-overlay channel, and when that channel is
 * never fed (a consumer that ships no run stream) the bar stays dark and no-ops —
 * see `test/features-empty-container.test.ts`.
 *
 * @see createDiagramContainer in `container.ts` for the DOM-anchor contract and
 *      how this module is composed with consumer feature modules.
 */
import { ContainerModule } from 'inversify';
import {
    TYPES,
    bindAsService,
    configureModelElement,
    configureActionHandler,
    configureCommand,
    ConsoleLogger,
    LogLevel,
    DefaultTypes,
    GRoutingHandle,
    GRoutingHandleView,
    FitToScreenCommand,
    CenterCommand,
    CenterKeyboardListener,
    SetModelCommand,
    ComputedBoundsApplicator,
    ToolPalette
} from '@eclipse-glsp/client';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { PostEditSelectionService } from './post-edit-selection-service';
import { WorkflowCopyPasteHandler } from './copy-paste-handler';
import { WorkflowGridStartup } from './grid-startup';
import { WorkflowPaletteIconStartup } from './palette-icons';
import { InitialViewportService } from './initial-viewport-service';
import { ViewportPreservingSetModelCommand } from './viewport-preserving-set-model-command';
import { FitClearOfOverlaysCommand } from './fit-clear-of-overlays';
import { RunningAgentsBar } from './running-agents-bar';
import { ExecutionOverlayMessageBridge } from './execution-overlay-message-bridge';
import { RunAgentStreamActionHandler } from './editing-action-handlers';
import { ContainedMovementRestrictor } from './contained-movement-restrictor';
import { NodeSizePreservingBoundsApplicator } from './node-size-preserving-bounds-applicator';
import { ExecutionStatesFeedbackCommand } from './execution-states';
import { SelectionTraceFeedbackCommand, SelectionTraceListener } from './selection-trace';
import { SelectionFocusPostprocessor } from './selection-focus';
import { ViewToolPalette } from './view-tool-palette';
import { ViewOptionsService } from './view-options';
import { ViewOptionsChangedAction } from '@dialogram/shared';
import { DiagramSurfaceHost, SurfaceClickListener } from './diagram-surface-host';
import { HiddenRenderRecord, SurfaceAwareCenterCommand, ZoomKeepingCenterKeyboardListener } from './viewport-content';

/**
 * The neutral base bindings shared by all diagram-client consumers. Loaded first
 * by `createDiagramContainer`, before any consumer feature module.
 */
export const diagramBaseModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };

    // Routing handle types (required for edge editing / bendpoints). Neutral GLSP
    // element configs — every diagram needs edge bendpoint editing.
    configureModelElement(context, DefaultTypes.ROUTING_POINT, GRoutingHandle, GRoutingHandleView);
    configureModelElement(context, DefaultTypes.VOLATILE_ROUTING_POINT, GRoutingHandle, GRoutingHandleView);

    // A dragged node stays inside the node that holds it (a group, a branch):
    // see `contained-movement-restrictor.ts`.
    if (isBound(TYPES.IMovementRestrictor)) {
        rebind(TYPES.IMovementRestrictor).to(ContainedMovementRestrictor).inSingletonScope();
    } else {
        bind(TYPES.IMovementRestrictor).to(ContainedMovementRestrictor).inSingletonScope();
    }

    // A node's size comes from the server: measured bounds move it but never
    // resize it (see `node-size-preserving-bounds-applicator.ts`).
    if (isBound(ComputedBoundsApplicator)) {
        rebind(ComputedBoundsApplicator).to(NodeSizePreservingBoundsApplicator).inSingletonScope();
    } else {
        bind(ComputedBoundsApplicator).to(NodeSizePreservingBoundsApplicator).inSingletonScope();
    }

    // Set up logging
    rebind(TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
    rebind(TYPES.LogLevel).toConstantValue(LogLevel.warn);

    // Preserve viewport across model refreshes (prevents viewport jump on save-triggered reload).
    rebind(SetModelCommand).to(ViewportPreservingSetModelCommand);

    // Fit draws the diagram where the palette and the canvas's buttons leave it free.
    rebind(FitToScreenCommand).to(FitClearOfOverlaysCommand);

    // Center, like Fit, frames the content as it is drawn: a surface's with
    // the graph's, labels no view draws left out (viewport-content.ts).
    if (isBound(CenterCommand)) {
        rebind(CenterCommand).to(SurfaceAwareCenterCommand);
    } else {
        bind(CenterCommand).to(SurfaceAwareCenterCommand);
    }
    // Its key too: Center keeps the zoom, whichever way it is asked for.
    if (isBound(CenterKeyboardListener)) {
        rebind(CenterKeyboardListener).to(ZoomKeepingCenterKeyboardListener).inSingletonScope();
    }
    // What the last hidden render drew, for the two above.
    bind(HiddenRenderRecord).toSelf().inSingletonScope();
    bind(TYPES.HiddenVNodePostprocessor).toService(HiddenRenderRecord);

    // A product's diagram surface (diagram-surface.ts): mounted under the SVG,
    // told every viewport, its clicks and selection carried. Without one bound
    // it only hears the renders, for the first view below.
    bind(DiagramSurfaceHost).toSelf().inSingletonScope();
    bind(TYPES.IVNodePostprocessor).toService(DiagramSurfaceHost);
    bind(TYPES.ISelectionListener).toService(DiagramSurfaceHost);
    bind(SurfaceClickListener).toSelf().inSingletonScope();
    bind(TYPES.MouseListener).toService(SurfaceClickListener);

    // The first view of a view never shown here (once per workflow).
    bind(InitialViewportService).toSelf().inSingletonScope();

    // Post-edit selection polish (paste/duplicate selects newly created elements).
    bind(PostEditSelectionService).toSelf().inSingletonScope();

    // Enable the diagram grid by default.
    bindAsService(context, TYPES.IDiagramStartup, WorkflowGridStartup);
    // Draws the icons a product contributed. Without it their palette entries
    // render an empty slot, since a palette icon is only ever a class name.
    bindAsService(context, TYPES.IDiagramStartup, WorkflowPaletteIconStartup);

    // The palette offers what the view shown allows: asked again with each model.
    if (isBound(ToolPalette)) {
        rebind(ToolPalette).to(ViewToolPalette).inSingletonScope();
    }

    // The view options of the diagram shown (view-options.ts): the palette
    // draws them, a product's client module hears them change. The service
    // reads each model's, and handles its own action, so that the action is
    // known to the diagram whether or not a product handles it too.
    bind(ViewOptionsService).toSelf().inSingletonScope();
    bind(TYPES.IGModelRootListener).toService(ViewOptionsService);
    configureActionHandler(context, ViewOptionsChangedAction.KIND, ViewOptionsService);

    // Override copy/paste handler so we can prepare post-paste selection.
    if (isBound(TYPES.ICopyPasteHandler)) {
        rebind(TYPES.ICopyPasteHandler).to(WorkflowCopyPasteHandler).inSingletonScope();
    } else {
        bind(TYPES.ICopyPasteHandler).to(WorkflowCopyPasteHandler).inSingletonScope();
    }

    // Read-only live "running agents" bar (streamed from the run over SSE). Bound
    // as an IDiagramStartup so GLSP eagerly instantiates it; it no-ops until the
    // execution-overlay channel feeds it events.
    bind(RunningAgentsBar).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(RunningAgentsBar);

    // Routes host-initiated client-only `actionMessage` notifications (execution
    // overlay, grid toggle) into the action dispatcher — the stock messenger path
    // drops them ("unknown method: actionMessage"), which kept the bar dark.
    bind(ExecutionOverlayMessageBridge).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(ExecutionOverlayMessageBridge);

    // Fold streamed run events into the RunningAgentsBar (the neutral overlay
    // glow path). No-ops until the execution-overlay channel feeds it.
    configureActionHandler(context, EXECUTION_OVERLAY_ACTION_KIND, RunAgentStreamActionHandler);

    // Draws the published node states, as feedback the dispatcher re-applies
    // to every model (see execution-states.ts).
    configureCommand(context, ExecutionStatesFeedbackCommand);

    // The selection's path (`clientBehavior.selectionTrace`), drawn as feedback
    // re-applied to every model (see selection-trace.ts). The listener reads the
    // flag on each selection, so a product that leaves it off sees nothing.
    bind(SelectionTraceListener).toSelf().inSingletonScope();
    bind(TYPES.ISelectionListener).toService(SelectionTraceListener);
    configureCommand(context, SelectionTraceFeedbackCommand);

    // While the selection's links are shown, the rest all but disappears
    // (see selection-focus.ts).
    bind(SelectionFocusPostprocessor).toSelf().inSingletonScope();
    bind(TYPES.IVNodePostprocessor).toService(SelectionFocusPostprocessor);
});
