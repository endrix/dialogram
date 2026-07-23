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
    ConsoleLogger,
    LogLevel,
    DefaultTypes,
    GRoutingHandle,
    GRoutingHandleView,
    SetModelCommand
} from '@eclipse-glsp/client';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { PostEditSelectionService } from './post-edit-selection-service';
import { WorkflowCopyPasteHandler } from './copy-paste-handler';
import { WorkflowGridStartup } from './grid-startup';
import { InitialViewportService } from './initial-viewport-service';
import { ViewportPreservingSetModelCommand } from './viewport-preserving-set-model-command';
import { RunningAgentsBar } from './running-agents-bar';
import { ExecutionOverlayMessageBridge } from './execution-overlay-message-bridge';
import { RunAgentStreamActionHandler } from './editing-action-handlers';

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

    // Set up logging
    rebind(TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
    rebind(TYPES.LogLevel).toConstantValue(LogLevel.warn);

    // Preserve viewport across model refreshes (prevents viewport jump on save-triggered reload).
    rebind(SetModelCommand).to(ViewportPreservingSetModelCommand);

    // Center viewport on initial model load (once per workflow).
    bind(InitialViewportService).toSelf().inSingletonScope();

    // Post-edit selection polish (paste/duplicate selects newly created elements).
    bind(PostEditSelectionService).toSelf().inSingletonScope();

    // Enable the diagram grid by default.
    bindAsService(context, TYPES.IDiagramStartup, WorkflowGridStartup);

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
});
