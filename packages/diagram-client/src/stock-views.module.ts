/**
 * Stock workflow model/view registration module.
 *
 * The workflow-specific half of the former `workflowDiagramModule`: every
 * `configureModelElement` tuple keyed on `WorkflowDiagramTypes.*` — the 14 node
 * types, 2 ports, 3 edges, labels, compartments — plus the validation issue-marker
 * view. This is the module SP3 §3 requires to be OPTIONAL: it is NOT part of the
 * neutral base and loads only when a consumer passes it (the stock entry does; a
 * custom-view consumer such as mlir supplies its own instead).
 *
 * Exported as `workflowViewsModule`; `createDiagramContainer({ withStockViews:true })`
 * prepends it as a convenience.
 *
 * Note: GLSP 2.5.x uses G-prefixed aliases (GGraph, GLabel, GCompartmentView, etc.)
 */
import { ContainerModule } from 'inversify';
import {
    configureModelElement,
    DefaultTypes,
    GIssueMarker,
    GGraph,
    GGraphView,
    GCompartment,
    GCompartmentView,
    GLabelView
} from '@eclipse-glsp/client';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import {
    ActorNode,
    ExternalActorNode,
    NetworkNode,
    CollapsedConditionalNode,
    CollapsedArrayNode,
    ProxyNode,
    StructureIfNode,
    StructureForeachNode,
    InlineIfNode,
    StructureIfBranchNode,
    StructureIfJoinNode,
    StructureForeachJoinNode,
    BoundaryInputNode,
    BoundaryOutputNode,
    WorkflowInputPort,
    WorkflowOutputPort,
    WorkflowEdge,
    WorkflowLabel,
    BoundaryEditableLabel,
    BoundaryLabel,
    HeaderCompartment,
    PortsCompartment
} from './model';
import {
    ActorNodeView,
    ExternalActorNodeView,
    NetworkNodeView,
    CollapsedConditionalNodeView,
    CollapsedArrayNodeView,
    ProxyNodeView,
    StructureIfNodeView,
    StructureForeachNodeView,
    InlineIfNodeView,
    StructureIfBranchNodeView,
    StructureIfJoinNodeView,
    StructureForeachJoinNodeView,
    BoundaryInputNodeView,
    BoundaryOutputNodeView,
    WorkflowInputPortView,
    WorkflowOutputPortView,
    WorkflowEdgeView,
    WorkflowNoArrowEdgeView,
    WorkflowVirtualEdgeView,
    WorkflowLabelView,
    HeaderCompartmentView
} from './views';
import { WorkflowIssueMarkerView } from './issue-marker-view';

/**
 * Stock workflow-specific model elements and views. Registers nothing neutral —
 * the routing-handle configs live in `diagramBaseModule`.
 */
export const workflowViewsModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };

    // Configure graph
    // Use GGraphView (not plain SGraphView) so gridModule can render the grid background.
    configureModelElement(context, WorkflowDiagramTypes.GRAPH, GGraph, GGraphView);

    // Configure node types
    configureModelElement(context, WorkflowDiagramTypes.NODE_ACTOR, ActorNode, ActorNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR, ExternalActorNode, ExternalActorNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_NETWORK, NetworkNode, NetworkNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_PROXY, ProxyNode, ProxyNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_COLLAPSED_CONDITIONAL, CollapsedConditionalNode, CollapsedConditionalNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_COLLAPSED_ARRAY, CollapsedArrayNode, CollapsedArrayNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_IF, StructureIfNode, StructureIfNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH, StructureForeachNode, StructureForeachNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_IF_INLINE, InlineIfNode, InlineIfNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH, StructureIfBranchNode, StructureIfBranchNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_IF_JOIN, StructureIfJoinNode, StructureIfJoinNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH_JOIN, StructureForeachJoinNode, StructureForeachJoinNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, BoundaryInputNode, BoundaryInputNodeView);
    configureModelElement(context, WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, BoundaryOutputNode, BoundaryOutputNodeView);

    // Configure port types
    configureModelElement(context, WorkflowDiagramTypes.PORT_INPUT, WorkflowInputPort, WorkflowInputPortView);
    configureModelElement(context, WorkflowDiagramTypes.PORT_OUTPUT, WorkflowOutputPort, WorkflowOutputPortView);

    // Configure edge types
    configureModelElement(context, WorkflowDiagramTypes.EDGE_CONNECTION, WorkflowEdge, WorkflowEdgeView);
    configureModelElement(context, WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW, WorkflowEdge, WorkflowNoArrowEdgeView);
    configureModelElement(context, WorkflowDiagramTypes.EDGE_VIRTUAL, WorkflowEdge, WorkflowVirtualEdgeView);

    // Validation marker view (GLSP uses DefaultTypes.ISSUE_MARKER = 'marker')
    configureModelElement(context, DefaultTypes.ISSUE_MARKER, GIssueMarker, WorkflowIssueMarkerView);

    // Configure label types - use GLabelView (Sprotty default) for testing
    configureModelElement(context, WorkflowDiagramTypes.LABEL_NAME, WorkflowLabel, GLabelView);
    configureModelElement(context, WorkflowDiagramTypes.LABEL_TYPE, WorkflowLabel, GLabelView);
    configureModelElement(context, WorkflowDiagramTypes.LABEL_BADGE, WorkflowLabel, GLabelView);

    // The boundary NAME is directly editable; the type is not.
    //
    // A label edit travels as the protocol `ApplyLabelEditOperation`, and the
    // only handler for that renames the nearest entity — which for a boundary
    // type label is the port itself. Editing the type therefore renamed the port
    // to whatever type was typed. The handler now refuses anything that is not a
    // name label, so the edit is merely inert rather than destructive; an editor
    // that silently discards what you type is still worth not offering.
    //
    // Making the type editable for real needs a sidecar op that addresses a
    // boundary port by `workflow` (the way `createPort` already does) rather
    // than by owning `entity`, which is what `updatePortType` requires today.
    //
    // `BoundaryLabel`, NOT the generic `WorkflowLabel`: boundary labels must
    // carry no layout features, or the node's layout engine positions them
    // instead of the view and the type lands in the top-left corner.
    configureModelElement(context, WorkflowDiagramTypes.LABEL_BOUNDARY_NAME, BoundaryEditableLabel, WorkflowLabelView);
    configureModelElement(context, WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE, BoundaryLabel, WorkflowLabelView);

    // Port labels
    configureModelElement(context, WorkflowDiagramTypes.LABEL_PORT, WorkflowLabel, WorkflowLabelView);

    // Configure compartment types
    configureModelElement(context, WorkflowDiagramTypes.COMPARTMENT_HEADER, HeaderCompartment, HeaderCompartmentView);
    configureModelElement(context, WorkflowDiagramTypes.COMPARTMENT_PORTS, PortsCompartment, GCompartmentView);
    configureModelElement(context, WorkflowDiagramTypes.COMPARTMENT_PORT_ROW, GCompartment, GCompartmentView);
});
