/**
 * Workflow GLSP Diagram Module
 *
 * Diagram-level DI configuration for Workflow network diagrams.
 * Extends GModelDiagramModule to provide Workflow-specific diagram configuration.
 */

import 'reflect-metadata';

import {
    ActionHandlerConstructor,
    BindingTarget,
    CompoundOperationHandler,
    ContextMenuItemProvider,
    DiagramConfiguration,
    GModelDiagramModule,
    InstanceMultiBinding,
    ModelSubmissionHandler,
    OperationHandlerConstructor,
    RequestContextActionsHandler,
    RequestEditValidationHandler,
    RequestMarkersHandler,
    RequestNavigationTargetsActionHandler,
    RequestPopupModelActionHandler,
    RequestTypeHintsActionHandler,
    ResolveNavigationTargetsActionHandler,
    SaveModelActionHandler,
    SourceModelStorage,
    ToolPaletteItemProvider
} from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { WORKFLOW_DIAGRAM_TYPE, type EditStrategy } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from './source-model-storage';
import { ReadOnlySourceModelStorage } from './read-only-source-model-storage';
import { WorkflowDiagramConfiguration } from './diagram-configuration';
import {
    WorkflowModelSubmissionHandler,
    WorkflowRequestModelActionHandler,
    WorkflowComputedBoundsActionHandler,
    WorkflowLayoutOperationHandler
} from './diagram-action-handlers';
import { WorkflowOperationActionHandler } from './operation-action-handler';
import { WorkflowUndoRedoActionHandler } from './undo-redo-action-handler';
import { WorkflowToolPaletteItemProvider } from './tool-palette-provider';
import { WorkflowContextMenuItemProvider } from './context-menu-item-provider';
import { WorkflowLabelEditValidator } from './label-edit-validator';
import { WorkflowRequestCheckEdgeActionHandler } from './request-check-edge-action-handler';
import { WorkflowRequestClipboardDataActionHandler } from './request-clipboard-data-action-handler';
import { WorkflowChangeBoundsOperationHandler } from '../operations/change-bounds-handler';
import { WorkflowRequestAgentSkillsOperationHandler } from '../operations/request-agent-skills-handler';
import { WorkflowRequestClaudeAgentsOperationHandler } from '../operations/request-claude-agents-handler';
import { WorkflowResetEdgeRoutesOperationHandler } from '../operations/reset-edge-routes-handler';
import { WorkflowRerouteEdgesAvoidOverlapsOperationHandler } from '../operations/reroute-edges-avoid-overlaps-handler';
import { WorkflowLayoutBoundaryFlowOperationHandler } from '../operations/layout-boundary-flow-handler';
import { WorkflowLayoutSerpentineMeshOperationHandler } from '../operations/layout-serpentine-mesh-handler';
import { WorkflowChangeRoutingPointsOperationHandler } from '../operations/change-routing-points-handler';
import { isDiagramOperationModule } from './operation-modules';

/**
 * Workflow Diagram Module
 * 
 * Extends GModelDiagramModule to configure Workflow-specific bindings for:
 * - Diagram configuration
 * - Operation handlers
 * - Tool palette
 * - Edge creation checking
 */
@injectable()
export class WorkflowDiagramModule extends GModelDiagramModule {

    /**
     * @param options `edits: 'read-only'` applies two guards for the session: (1) it skips
     * operation-handler configuration entirely (no write operations are ever registered -- see
     * {@link configureOperationHandlers}), and (2) it binds {@link ReadOnlySourceModelStorage}
     * instead of {@link WorkflowSourceModelStorage}, whose `saveSourceModel` is a no-op so
     * `SaveModelAction` never writes the document back to disk (see {@link bindSourceModelStorage}).
     * Omitted/undefined keeps today's default (editable) behavior, byte-identical to before this
     * option existed.
     */
    constructor(
        private readonly options?: {
            edits?: EditStrategy;
        }
    ) {
        super();
    }

    /**
     * The diagram type this module handles
     */
    get diagramType(): string {
        return WORKFLOW_DIAGRAM_TYPE;
    }

    /**
     * Bind the source model storage. Read-only sessions bind {@link ReadOnlySourceModelStorage}
     * so `saveSourceModel` is a no-op -- see the constructor doc comment.
     */
    protected bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
        return this.options?.edits === 'read-only' ? ReadOnlySourceModelStorage : WorkflowSourceModelStorage;
    }

    /**
     * Bind the Workflow diagram configuration
     */
    protected bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
        return WorkflowDiagramConfiguration;
    }

    /**
     * Configure operation handlers for Workflow diagram operations.
     * We do NOT call super.configureOperationHandlers() because it registers
     * default handlers (GModelDeleteOperationHandler, etc.) that conflict with
     * our custom handlers. We register all needed handlers ourselves.
     */
    protected override configureOperationHandlers(
        binding: InstanceMultiBinding<OperationHandlerConstructor>
    ): void {
        // Read-only sessions never register a write operation handler.
        if (this.options?.edits === 'read-only') {
            return;
        }

        // DO NOT call super - it registers default delete/reconnect handlers
        // that would conflict with ours and cause "Key is already registered" warnings
        // super.configureOperationHandlers(binding);

        // Essential handlers from DiagramModule that we must include:
        binding.add(CompoundOperationHandler);
        // Use our custom layout handler instead of default (which only works in MANUAL mode)
        binding.add(WorkflowLayoutOperationHandler);

        // Persist node moves (ChangeBoundsOperation)
        binding.add(WorkflowChangeBoundsOperationHandler);

        // Manual bendpoints / edge routing edits
        binding.add(WorkflowChangeRoutingPointsOperationHandler);

        // Discovery handlers (no source edits)
        binding.add(WorkflowRequestAgentSkillsOperationHandler);
        binding.add(WorkflowRequestClaudeAgentsOperationHandler);

        // Routing utilities
        binding.add(WorkflowLayoutBoundaryFlowOperationHandler);
        binding.add(WorkflowLayoutSerpentineMeshOperationHandler);
        binding.add(WorkflowResetEdgeRoutesOperationHandler);
        binding.add(WorkflowRerouteEdgesAvoidOverlapsOperationHandler);

        // Consumer-supplied operation modules (e.g. the toolkit's source-editing handlers, which
        // live outside core). Each module registers its handlers after the neutral in-core set
        // above; order is irrelevant (every handler responds to a distinct operation kind). Modules
        // arrive as opaque handles on `EditStrategy.operationModules` -- narrow each to the concrete
        // contract before invoking it.
        // `read-only` already returned above, so any `edits` here carries operation modules.
        const edits = this.options?.edits;
        if (edits) {
            for (const module of edits.operationModules) {
                if (isDiagramOperationModule(module)) {
                    module.configure(binding);
                }
            }
        }
    }

    /**
     * Configure action handlers for Workflow diagram.
     * 
     * We do NOT call super.configureActionHandlers() because it registers
     * the default ComputedBoundsActionHandler which throws "Invalid Route!"
     * when an edge route has fewer than 2 points. This can happen during
     * live updates when the diagram is being refreshed while the user is typing.
     * 
     * Instead, we manually register all handlers from the parent classes,
     * replacing ComputedBoundsActionHandler with our custom WorkflowComputedBoundsActionHandler.
     */
    protected override configureActionHandlers(
        binding: InstanceMultiBinding<ActionHandlerConstructor>
    ): void {
        // DO NOT call super - it registers ComputedBoundsActionHandler which throws on invalid routes
        // super.configureActionHandlers(binding);
        
        // Handlers from DiagramModule (except ComputedBoundsActionHandler)
        // Use our custom handler that suppresses notifications for polling refreshes
        binding.add(WorkflowRequestModelActionHandler);
        binding.add(RequestContextActionsHandler);
        binding.add(RequestTypeHintsActionHandler);
        binding.add(WorkflowOperationActionHandler);
        binding.add(WorkflowRequestCheckEdgeActionHandler);
        binding.add(RequestMarkersHandler);
        binding.add(RequestPopupModelActionHandler);
        binding.add(RequestEditValidationHandler);
        binding.add(RequestNavigationTargetsActionHandler);
        binding.add(ResolveNavigationTargetsActionHandler);
        binding.add(SaveModelActionHandler);
        // Graceful undo/redo: the host document stack owns durable undo, so a glspUndo that
        // arrives after a source reload reset the in-memory stack must not error the client.
        binding.add(WorkflowUndoRedoActionHandler);
        
        // Our custom handler instead of ComputedBoundsActionHandler
        binding.add(WorkflowComputedBoundsActionHandler);

        // Clipboard handler: provide Workflow-specific clipboard payload
        binding.add(WorkflowRequestClipboardDataActionHandler);
    }

    /**
     * Bind the tool palette item provider for Workflow diagram
     */
    protected override bindToolPaletteItemProvider(): BindingTarget<ToolPaletteItemProvider> | undefined {
        return WorkflowToolPaletteItemProvider;
    }

    protected override bindLabelEditValidator() {
        return WorkflowLabelEditValidator;
    }

    /**
     * Bind the context menu item provider (server-driven context actions).
     */
    protected override bindContextMenuItemProvider(): BindingTarget<ContextMenuItemProvider> | undefined {
        return WorkflowContextMenuItemProvider;
    }

    /**
     * Bind the custom model submission handler with debug logging
     */
    protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
        return WorkflowModelSubmissionHandler;
    }
}
