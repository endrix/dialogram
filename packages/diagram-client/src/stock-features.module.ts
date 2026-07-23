/**
 * Stock workflow feature-UI module.
 *
 * The workflow feature half of the former `workflowDiagramModule`: the property
 * panel, the integrated chat panel, the navigation UI, the diagram mouse
 * listeners, the client-side action handlers for server-driven context-menu
 * actions, and the drag-time ELK live-drag router. None of this is neutral — a
 * custom-view consumer (mlir) brings its own feature set — so it ships as a
 * separate optional module, exported as `workflowFeaturesModule`, composed AFTER
 * the neutral base and (optionally) the stock views by `createDiagramContainer`.
 */
import { ContainerModule } from 'inversify';
import { TYPES, bindAsService, configureActionHandler } from '@eclipse-glsp/client';
import { MoveAction } from '@eclipse-glsp/sprotty';
import { PropertyPanel } from './property-panel';
import { ChatPanel } from './chat-panel-integrated';
import { WorkflowNavigationUi } from './navigation-ui';
import { WorkflowNetworkNavigationMouseListener } from './network-navigation-mouse-listener';
import { ViewerMouseListener } from './viewer-mouse-listener';
import { EdgeOpenMouseListener } from './edge-open-mouse-listener';
import { WhitespaceRootPropertiesMouseListener } from './whitespace-root-properties-mouse-listener';
import { WorkflowElkLiveDragRouter } from './elk-live-drag-router';
import {
    WorkflowPromptLabelEditAction,
    WorkflowPromptLabelEditActionHandler,
    WorkflowToggleGridAction,
    WorkflowToggleGridActionHandler,
    WorkflowPromptRenameEntityAction,
    WorkflowPromptRenameEntityActionHandler,
    WorkflowEditParametersAction,
    WorkflowEditParametersActionHandler,
    WorkflowEditAnnotationsAction,
    WorkflowEditAnnotationsActionHandler,
    WorkflowShowWorkspaceEntitiesAction,
    WorkflowShowWorkspaceEntitiesActionHandler,
    WorkflowShowAgentSkillsAction,
    WorkflowShowAgentSkillsActionHandler,
    WorkflowShowClaudeAgentsAction,
    WorkflowShowClaudeAgentsActionHandler
} from './editing-action-handlers';

/**
 * Stock workflow feature UI: property panel, chat, navigation, mouse listeners,
 * action handlers, and the live-drag router.
 */
export const workflowFeaturesModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };

    // Workflow navigation UI (breadcrumbs + workflow/root picker).
    bind(WorkflowNavigationUi).toSelf().inSingletonScope();

    // Register property panel as both selection listener and model-root listener.
    // IGModelRootListener fires on every SetModelAction, enabling the panel to
    // update agent context in real time even when the selection hasn't changed.
    bind(PropertyPanel).toSelf().inSingletonScope();
    bind(TYPES.ISelectionListener).toService(PropertyPanel);
    bind(TYPES.IGModelRootListener).toService(PropertyPanel);

    // Register integrated chat panel (slides up from bottom of diagram).
    // Bound as an IDiagramStartup so GLSP eagerly instantiates it on diagram
    // startup — a plain singleton binding is never resolved, so the panel and
    // its floating toggle button would never be created.
    bind(ChatPanel).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(ChatPanel);

    // Double-click navigation into nested networks.
    bindAsService(context, TYPES.MouseListener, WorkflowNetworkNavigationMouseListener);

    // Double-click on @viewer external tasks to open/diff the last token files.
    bindAsService(context, TYPES.MouseListener, ViewerMouseListener);

    // Double-click on diagram whitespace to show root/workflow properties.
    bindAsService(context, TYPES.MouseListener, WhitespaceRootPropertiesMouseListener);

    // Hover-edge open button to open the last-token file from an edge.
    bindAsService(context, TYPES.MouseListener, EdgeOpenMouseListener);

    // Client-side handlers for server-driven context menu actions.
    configureActionHandler(context, WorkflowPromptLabelEditAction.KIND, WorkflowPromptLabelEditActionHandler);
    configureActionHandler(context, WorkflowToggleGridAction.KIND, WorkflowToggleGridActionHandler);
    configureActionHandler(context, WorkflowPromptRenameEntityAction.KIND, WorkflowPromptRenameEntityActionHandler);
    configureActionHandler(context, WorkflowEditParametersAction.KIND, WorkflowEditParametersActionHandler);
    configureActionHandler(context, WorkflowEditAnnotationsAction.KIND, WorkflowEditAnnotationsActionHandler);
    configureActionHandler(context, WorkflowShowWorkspaceEntitiesAction.KIND, WorkflowShowWorkspaceEntitiesActionHandler);
    configureActionHandler(context, WorkflowShowAgentSkillsAction.KIND, WorkflowShowAgentSkillsActionHandler);
    configureActionHandler(context, WorkflowShowClaudeAgentsAction.KIND, WorkflowShowClaudeAgentsActionHandler);

    // Drag-time rerouting: client streams MoveAction updates; server recomputes routes (ELK fixed).
    configureActionHandler(context, MoveAction.KIND, WorkflowElkLiveDragRouter);
});
