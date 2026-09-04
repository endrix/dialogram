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
import { ChangeBoundsTool, TYPES, bindAsService, configureActionHandler } from '@eclipse-glsp/client';
import { MoveAction } from '@eclipse-glsp/sprotty';
import { PropertyPanel } from './property-panel';
import { ChatPanel } from './chat-panel-integrated';
import { clientBehavior } from './profile';
import { WorkflowNavigationUi } from './navigation-ui';
import { WorkflowNetworkNavigationMouseListener } from './network-navigation-mouse-listener';
import { ViewerMouseListener } from './viewer-mouse-listener';
import { EdgeOpenMouseListener } from './edge-open-mouse-listener';
import { WhitespaceRootPropertiesMouseListener } from './whitespace-root-properties-mouse-listener';
import { WorkflowElkLiveDragRouter } from './elk-live-drag-router';
import { WorkflowChangeBoundsTool } from './change-bounds-drag-threshold';
import { LibavoidEdgeRouter } from './libavoid-edge-router';
import { preloadLibavoid } from './libavoid-loader';
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
    //
    // Only when the host has a chat backend to answer it. That eager startup is
    // what made the difference visible: with no backend the panel opened, sent
    // its first message to a host with no handler for it, logged an
    // unknown-method error, and gave up five seconds later — leaving a chat
    // button that could never answer.
    //
    // This module is the stock product's feature set, and a consumer composing
    // it without configuring chat is a normal thing to be: the header above
    // says as much. So the absence of a backend has to read as "no panel"
    // rather than as a panel that fails. The flag is derived by the platform
    // from the profile, so the two halves cannot disagree.
    if (clientBehavior().chatBackend !== false) {
        bind(ChatPanel).toSelf().inSingletonScope();
        bind(TYPES.IDiagramStartup).toService(ChatPanel);
        // Track the live diagram selection and mirror it into the chat runtime.
        bind(TYPES.ISelectionListener).toService(ChatPanel);
    }

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

    // Ignore the pixel or two of pointer travel a double-click carries, so
    // navigating into a nested network no longer nudges the node and triggers a
    // reroute. `changeBoundsToolModule` (a DEFAULT_MODULE, loaded before this
    // one) binds `bind(ChangeBoundsTool).toSelf()` + `IDefaultTool` as a
    // `toService` alias, so rebinding the class alone redirects the alias too.
    rebind(ChangeBoundsTool).to(WorkflowChangeBoundsTool).inSingletonScope();

    // Drag-time rerouting: client streams MoveAction updates; server recomputes routes (ELK fixed).
    configureActionHandler(context, MoveAction.KIND, WorkflowElkLiveDragRouter);

    // The live tier: edges routed in the webview during a drag, with the same
    // router and the same anchors the server uses on commit, so the committed
    // route replaces the live one without a visible jump.
    //
    // Loading is kicked off here and never awaited: `IEdgeRouter.route()` is
    // synchronous, so the router simply routes straight lines until the WASM is
    // ready rather than blocking the first frames.
    bindAsService(context, TYPES.IEdgeRouter, LibavoidEdgeRouter);
    void preloadLibavoid();
});
