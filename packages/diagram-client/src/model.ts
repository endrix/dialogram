/**
 * Workflow Diagram Client Model
 * 
 * Client-side model definitions for Workflow network diagrams.
 * These extend Sprotty's base model elements with Workflow-specific properties.
 * 
 * Note: GLSP 2.5.x uses G-prefixed aliases (GLabel, GCompartment, GNode, etc.)
 */

import {
    RectangularNode,
    CircularPort,
    SEdgeImpl,
    GLabel,
    GCompartment,
    moveFeature,
    selectFeature,
    hoverFeedbackFeature,
    deletableFeature,
    boundsFeature,
    connectableFeature,
    layoutContainerFeature,
    editFeature,
    withEditLabelFeature,
    Hoverable,
    Selectable,
    Fadeable
} from '@eclipse-glsp/client';
import { Args } from '@eclipse-glsp/protocol';
import { WorkflowDiagramTypes } from '@dialogram/shared';

/**
 * Base class for Workflow diagram nodes
 * 
 * boundsFeature is required to accept position updates from server-side ELK layout.
 * layoutContainerFeature is NOT included to prevent automatic resizing based on children.
 * 
 * IMPORTANT: We override the `bounds` setter to only update position, NOT size.
 * This prevents Sprotty's hidden bounds updater from overwriting server-calculated sizes
 * when CSS changes (like stroke-width on selection) affect the SVG bounding box.
 */
export class WorkflowNode extends RectangularNode implements Hoverable, Selectable, Fadeable {
    static override readonly DEFAULT_FEATURES = [
        moveFeature,
        selectFeature,
        hoverFeedbackFeature,
        deletableFeature,
        boundsFeature  // Required for server-side layout to update positions
        // NOT layoutContainerFeature - this causes nodes to resize when others move
    ];

    override hoverFeedback: boolean = false;
    override selected: boolean = false;
    override opacity: number = 1;
    
    /** Entity type (Actor or Network qualified name) */
    entityType?: string;
    
    /** Whether this is a network instance (allows drill-down) */
    isNetworkInstance: boolean = false;
    
    /** Whether this node is read-only (collapsed conditional/array) */
    readOnly: boolean = false;
    
    /** Badge text for collapsed nodes (e.g., "if", "3x") */
    badge?: string;
    
    /** Tooltip text */
    tooltip?: string;
    
    /** Referenced document URI for cross-file navigation */
    referencedUri?: string;
    
    /** Metadata from server */
    args?: Args;
    
    /**
     * Override bounds setter to only update position, not size.
     * This prevents Sprotty's hidden bounds updater from overwriting server-calculated sizes
     * when the SVG bounding box changes due to CSS (e.g., stroke-width on selection).
     */
    override set bounds(newBounds: { x: number; y: number; width: number; height: number }) {
        this.position = {
            x: newBounds.x,
            y: newBounds.y
        };
        // Do NOT update this.size - preserve server-calculated size
    }
    
    override get bounds(): { x: number; y: number; width: number; height: number } {
        return {
            x: this.position.x,
            y: this.position.y,
            width: this.size.width,
            height: this.size.height
        };
    }
}

/**
 * Actor instance node
 */
export class ActorNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_ACTOR;
}

/**
 * External actor instance node
 */
export class ExternalActorNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR;
}

/**
 * Network instance node (allows drill-down)
 */
export class NetworkNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_NETWORK;
    override isNetworkInstance = true;
}

/**
 * Collapsed conditional node (EntityIfExpr)
 */
export class CollapsedConditionalNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_COLLAPSED_CONDITIONAL;
    override readOnly = true;
}

/**
 * Collapsed array node (EntityListExpr)
 */
export class CollapsedArrayNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_COLLAPSED_ARRAY;
    override readOnly = true;
}

/**
 * Structure if node (StructureStatementIf)
 * Rendered as a read-only grouping element.
 * 
 * IMPORTANT: Has layoutContainerFeature so Sprotty knows the server manages children's layout.
 */
export class StructureIfNode extends WorkflowNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature,
        layoutContainerFeature  // Tell Sprotty that children are server-laid-out
    ];
    
    override type = WorkflowDiagramTypes.NODE_STRUCTURE_IF;
    override readOnly = true;
}

/**
 * Structure foreach node (StructureStatementForeach)
 * Rendered as a read-only grouping container.
 * 
 * IMPORTANT: Has layoutContainerFeature so Sprotty knows the server manages children's layout.
 */
export class StructureForeachNode extends WorkflowNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature,
        layoutContainerFeature  // Tell Sprotty that children are server-laid-out
    ];
    
    override type = WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH;
    override readOnly = true;
}

/**
 * Inline if node (used to represent per-iteration ifs inside foreach)
 * Rendered as a small read-only statement marker.
 */
export class InlineIfNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_STRUCTURE_IF_INLINE;
    override readOnly = true;
}

/**
 * Proxy node for indexed entity references like c[i], c[nSegs-1].
 * Represents a single element from an entity list inside a foreach loop.
 * Read-only and movable for layout purposes.
 */
export class ProxyNode extends WorkflowNode {
    static override readonly DEFAULT_FEATURES = [
        moveFeature,
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature
        // NOT deletableFeature - proxy nodes are derived from foreach
    ];

    override type = WorkflowDiagramTypes.NODE_PROXY;
    override readOnly = true;
    
    /** The base entity name (e.g., 'c' for c[i]) */
    baseEntity?: string;
    
    /** The index expression text (e.g., 'i', 'i-1', 'nSegs-1') */
    indexExprText?: string;
}

/**
 * Structure if branch container node (then/else/elsif)
 * Read-only and not user-movable.
 * 
 * IMPORTANT: Has layoutContainerFeature so Sprotty knows the server manages children's layout.
 * We also override the `bounds` setter to only update position, NOT size.
 */
export class StructureIfBranchNode extends RectangularNode implements Hoverable, Selectable, Fadeable {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature,
        layoutContainerFeature  // Tell Sprotty that children are server-laid-out
    ];

    override type = WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH;
    override hoverFeedback: boolean = false;
    override selected: boolean = false;
    override opacity: number = 1;
    readOnly: boolean = true;
    args?: Args;
    
    override set bounds(newBounds: { x: number; y: number; width: number; height: number }) {
        this.position = { x: newBounds.x, y: newBounds.y };
    }
    
    override get bounds(): { x: number; y: number; width: number; height: number } {
        return { x: this.position.x, y: this.position.y, width: this.size.width, height: this.size.height };
    }
}

/**
 * Structure if join node (phi-like merge point)
 * Read-only and not user-movable.
 * 
 * IMPORTANT: We override the `bounds` setter to only update position, NOT size.
 */
export class StructureIfJoinNode extends RectangularNode implements Hoverable, Selectable, Fadeable {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature
    ];

    override type = WorkflowDiagramTypes.NODE_STRUCTURE_IF_JOIN;
    override hoverFeedback: boolean = false;
    override selected: boolean = false;
    override opacity: number = 1;
    readOnly: boolean = true;
    args?: Args;
    
    override set bounds(newBounds: { x: number; y: number; width: number; height: number }) {
        this.position = { x: newBounds.x, y: newBounds.y };
    }
    
    override get bounds(): { x: number; y: number; width: number; height: number } {
        return { x: this.position.x, y: this.position.y, width: this.size.width, height: this.size.height };
    }
}

/**
 * Structure foreach join node (merge point for foreach loop outputs)
 * Read-only and not user-movable.
 * 
 * IMPORTANT: We override the `bounds` setter to only update position, NOT size.
 */
export class StructureForeachJoinNode extends RectangularNode implements Hoverable, Selectable, Fadeable {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        boundsFeature
    ];

    override type = WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH_JOIN;
    override hoverFeedback: boolean = false;
    override selected: boolean = false;
    override opacity: number = 1;
    readOnly: boolean = true;
    args?: Args;
    
    override set bounds(newBounds: { x: number; y: number; width: number; height: number }) {
        this.position = { x: newBounds.x, y: newBounds.y };
    }
    
    override get bounds(): { x: number; y: number; width: number; height: number } {
        return { x: this.position.x, y: this.position.y, width: this.size.width, height: this.size.height };
    }
}

/**
 * Boundary port node (network input/output)
 */
export class BoundaryInputNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_BOUNDARY_INPUT;
    /** Port direction */
    direction: 'input' | 'output' = 'input';
}

export class BoundaryOutputNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
    /** Port direction */
    direction: 'input' | 'output' = 'output';
}

/**
 * CAL Port element
 * 
 * IMPORTANT: We override the `bounds` setter to only update position, NOT size.
 */
export class WorkflowPort extends CircularPort implements Hoverable, Selectable {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        hoverFeedbackFeature,
        connectableFeature,
        boundsFeature
    ];

    override hoverFeedback: boolean = false;
    override selected: boolean = false;
    
    /** Port direction */
    direction: 'input' | 'output' = 'input';
    
    /** Resolved concrete type */
    portType?: string;
    
    /** Whether type has unresolved generics */
    hasUnresolvedGenerics: boolean = false;
    
    /** Array port multiplicity (if array port) */
    multiplicity?: number;
    
    /** Original port name */
    portName?: string;
    
    /** Metadata from server */
    args?: Args;
    
    override set bounds(newBounds: { x: number; y: number; width: number; height: number }) {
        this.position = { x: newBounds.x, y: newBounds.y };
    }
    
    override get bounds(): { x: number; y: number; width: number; height: number } {
        return {
            x: this.position.x,
            y: this.position.y,
            width: this.size.width,
            height: this.size.height
        };
    }
}

export class WorkflowInputPort extends WorkflowPort {
    override type = WorkflowDiagramTypes.PORT_INPUT;
    override direction: 'input' | 'output' = 'input';
}

export class WorkflowOutputPort extends WorkflowPort {
    override type = WorkflowDiagramTypes.PORT_OUTPUT;
    override direction: 'input' | 'output' = 'output';
}

/**
 * CAL Edge (connection between ports)
 */
export class WorkflowEdge extends SEdgeImpl implements Selectable, Fadeable, Hoverable {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        editFeature,
        deletableFeature,
        hoverFeedbackFeature
    ];

    override selected: boolean = false;
    override hoverFeedback: boolean = false;
    override opacity: number = 1;
    
    /** Source entity name */
    sourceEntity?: string;
    
    /** Source port name */
    sourcePort?: string;
    
    /** Target entity name */
    targetEntity?: string;
    
    /** Target port name */
    targetPort?: string;
    
    /** Whether this edge is read-only */
    readOnly: boolean = false;

    override hasFeature(feature: symbol): boolean {
        if (feature === editFeature && this.readOnly) {
            return false;
        }
        return super.hasFeature(feature);
    }
}

/**
 * CAL Label element
 */
export class WorkflowLabel extends GLabel implements Selectable {
    override selected: boolean = false;
    
    /** Label kind (name, type, badge) */
    labelKind?: 'name' | 'type' | 'badge';
}

/**
 * Editable name label
 */
export class WorkflowEditableLabel extends WorkflowLabel {
    static override readonly DEFAULT_FEATURES = [
        selectFeature,
        editFeature,
        withEditLabelFeature
    ];
    
    editControlDimension = { width: 100, height: 20 };
}

/**
 * Boundary labels should not capture drag gestures.
 *
 * If boundary labels are selectable, the selection tool can consume the
 * mouse-down/drag on the label itself, making it feel like the boundary
 * port cannot be moved unless you grab an "empty" spot.
 *
 * We keep edit support (double-click) but drop selection so drag can bubble
 * to the parent boundary node's moveFeature.
 */
export class BoundaryEditableLabel extends WorkflowLabel {
    static override readonly DEFAULT_FEATURES = [
        editFeature,
        withEditLabelFeature
    ];

    editControlDimension = { width: 100, height: 20 };
}

/**
 * CAL Compartment for grouping elements
 */
export class WorkflowCompartment extends GCompartment {
    /** Compartment kind (header, ports) */
    compartmentKind?: 'header' | 'ports';
}

/**
 * Header compartment with name and type labels
 */
export class HeaderCompartment extends WorkflowCompartment {
    override type = WorkflowDiagramTypes.COMPARTMENT_HEADER;
    override compartmentKind: 'header' | 'ports' = 'header';
}

/**
 * Ports compartment containing input/output ports
 */
export class PortsCompartment extends WorkflowCompartment {
    override type = WorkflowDiagramTypes.COMPARTMENT_PORTS;
    override compartmentKind: 'header' | 'ports' = 'ports';
}

/**
 * Decoration marker for validation issues
 */
export interface ValidationDecoration {
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
}
