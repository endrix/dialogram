/**
 * CAL ELK Layout Configurator
 * 
 * Configures the ELK layout algorithm for Workflow network diagrams.
 * Uses a layered layout algorithm suitable for dataflow graphs.
 * 
 * Based on GLSP workflow example configuration.
 */

import { GGraph, GNode, GEdge, GPort, GLabel, GModelElement } from '@eclipse-glsp/server';
import { AbstractLayoutConfigurator, LayoutOptions } from '@eclipse-glsp/layout-elk';
import { injectable } from 'inversify';
import { WorkflowDiagramTypes } from '@dialogram/shared';

/**
 * Workflow-specific layout configurator for ELK.
 * 
 * Provides layout options for Workflow network diagrams using the ELK Layered algorithm,
 * which is well-suited for dataflow-style graphs with directed edges.
 */
@injectable()
export class WorkflowLayoutConfigurator extends AbstractLayoutConfigurator {

    constructor() {
        super();
        // Verbose logging removed for clarity
    }

    /**
     * Override apply() to fix the upstream bug where portOptions return value is ignored.
     */
    override apply(element: GModelElement): LayoutOptions | undefined {
        let result: LayoutOptions | undefined;
        if (element instanceof GGraph) {
            result = this.graphOptions(element);
        } else if (element instanceof GNode) {
            result = this.nodeOptions(element);
        } else if (element instanceof GEdge) {
            result = this.edgeOptions(element);
        } else if (element instanceof GLabel) {
            result = this.labelOptions(element);
        } else if (element instanceof GPort) {
            result = this.portOptions(element);
        }
        return result;
    }

    /**
     * Graph-level layout options.
     * Use simple, proven ELK layered config.
     * 
     * This is the single source of truth for all graph-level ELK options.
     * (Consolidated from the former custom WorkflowElkLayoutEngine)
     */
    protected override graphOptions(graph: GGraph): LayoutOptions | undefined {
        // Allow overriding the algorithm via graph options (e.g. for post-drag fixed layout)
        const requestedAlgorithm = graph.layoutOptions?.['elk.algorithm'];
        const algorithm = (requestedAlgorithm && typeof requestedAlgorithm === 'string') 
            ? requestedAlgorithm 
            : 'layered';

        // Separate configuration for 'fixed' layout strategy (Post-Drag)
        if (algorithm === 'fixed') {
            return {
                'elk.algorithm': 'fixed',
                // Explicitly request orthogonal edge routing
                'elk.edgeRouting': 'ORTHOGONAL',
                'elk.direction': 'RIGHT',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                // Spacing seems to be ignored by fixed layout, but good to have
                'elk.spacing.edgeNode': '30',
                'elk.spacing.edgeEdge': '20',
                // Ensure ports are treated as fixed
                'elk.portConstraints': 'FIXED_POS',
            };
        }

        // Standard 'layered' configuration
        return {
            // Core algorithm
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            // INCLUDE_CHILDREN is required for cross-hierarchy edges to be routed properly.
            // With SEPARATE_CHILDREN, edges crossing hierarchies need explicit hierarchical ports.
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            
            // Edge routing
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.layered.edgeRouting.selfLoopDistribution': 'EQUALLY',
            // Keep orthogonal paths clean (fewer gratuitous kinks)
            'elk.layered.unnecessaryBendpoints': 'false',
            // Inform ELK about edge thickness for spacing decisions.
            'elk.edge.thickness': '1.5',
            // Don't merge edges - this can cause edges to overlap and cross nodes
            'elk.layered.mergeEdges': 'false',
            'elk.layered.mergeHierarchyEdges': 'false',
            
            // CRITICAL: Spacing to prevent edges from crossing nodes
            'elk.spacing.nodeNode': '50',
            'elk.spacing.edgeNode': '30',
            'elk.spacing.edgeEdge': '20',
            'elk.spacing.portPort': '14',
            'elk.layered.spacing.nodeNodeBetweenLayers': '90',
            'elk.layered.spacing.edgeNodeBetweenLayers': '30',
            'elk.layered.spacing.edgeEdgeBetweenLayers': '15',

            // Port labels are modeled as true ELK port labels (labels on ports).
            // Let ELK place them according to port-label placement rules.
            'elk.portLabels.placement': 'INSIDE NEXT_TO_PORT_IF_POSSIBLE',
            // IMPORTANT: do not treat port labels as a group.
            // Grouping tends to align labels into a column, which can push output labels far from ports.
            'elk.portLabels.treatAsGroup': 'false',
            // Keep label-to-port distance tight (matches previous "micro layout" intent).
            'elk.spacing.labelPortHorizontal': '0',
            'elk.spacing.labelPortVertical': '0',
            
            // Layering and placement strategies
            'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            
            // Favor straight edges - reduces unnecessary bends that cause crossings
            'elk.layered.nodePlacement.favorStraightEdges': 'false',
            
            // Consider model order for consistent results
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            
            // Increase thoroughness for better edge routing
            'elk.layered.thoroughness': '15',
            
            // Keep connected components together
            'elk.separateConnectedComponents': 'false',
            
            // Use feedback edges option - routes backward edges around nodes
            'elk.layered.feedbackEdges': 'true'
        };
    }

    /**
     * Node-level layout options.
     * Set minimum sizes and port constraints.
     */
    protected override nodeOptions(node: GNode): LayoutOptions | undefined {
        const nodeType = node.type;

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_IF) {
            // Compound container: hierarchical layout for branch containers
            return {
                'elk.algorithm': 'layered',
                'elk.direction': 'RIGHT',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.padding': '[top=30,left=15,bottom=15,right=15]',
                'elk.portConstraints': 'FIXED_POS',
                'elk.spacing.nodeNode': '20',
                'elk.spacing.edgeNode': '20',
                'elk.spacing.portPort': '8'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH) {
            // Branch container: hierarchical layout for nested entities
            return {
                'elk.algorithm': 'layered',
                'elk.direction': 'RIGHT',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.padding': '[top=30,left=20,bottom=15,right=20]',
                'elk.portConstraints': 'FIXED_POS',
                'elk.spacing.nodeNode': '20',
                'elk.spacing.edgeNode': '20',
                'elk.spacing.portPort': '8'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_IF_JOIN) {
            // Join is a small helper node; size comes from server.
            const nodeWidth = node.size?.width ?? 70;
            const nodeHeight = node.size?.height ?? 34;
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${nodeWidth},${nodeHeight})`,
                'elk.portConstraints': 'FIXED_POS',
                'elk.padding': '[top=0,left=0,bottom=0,right=0]',
                'elk.layered.layering.layerConstraint': 'LAST'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH_JOIN) {
            // Foreach join is a small helper node similar to if join
            const nodeWidth = node.size?.width ?? 60;
            const nodeHeight = node.size?.height ?? 30;
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${nodeWidth},${nodeHeight})`,
                'elk.portConstraints': 'FIXED_POS',
                'elk.padding': '[top=0,left=0,bottom=0,right=0]',
                'elk.layered.layering.layerConstraint': 'LAST'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH) {
            // Compound container: hierarchical layout for children
            return {
                'elk.algorithm': 'layered',
                'elk.direction': 'RIGHT',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.padding': '[top=35,left=15,bottom=15,right=15]',
                'elk.spacing.nodeNode': '25',
                'elk.spacing.edgeNode': '25',
                'elk.portConstraints': 'FIXED_POS'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_PROXY) {
            // Proxy nodes (indexed entity access like c[i], c[nSegs-1])
            const nodeWidth = node.size?.width ?? 160;
            const nodeHeight = node.size?.height ?? 80;
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${nodeWidth},${nodeHeight})`,
                'elk.portConstraints': 'FIXED_POS',
                'elk.spacing.portPort': '10',
                // Port label placement: INSIDE forces them into the node body (same as actors)
                'elk.portLabels.placement': 'INSIDE NEXT_TO_PORT_IF_POSSIBLE',
                'elk.spacing.labelPortHorizontal': '0',
                'elk.spacing.labelPortVertical': '0'
            };
        }

        if (nodeType === WorkflowDiagramTypes.NODE_STRUCTURE_IF_INLINE) {
            const nodeWidth = node.size?.width ?? 140;
            const nodeHeight = node.size?.height ?? 24;
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.nodeSize.minimum': `(${nodeWidth},${nodeHeight})`,
                'elk.padding': '[top=0,left=0,bottom=0,right=0]'
            };
        }
        
        if (nodeType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT) {
            // Boundary input nodes - place in dedicated leftmost layer.
            // FIXED_SIZE prevents ELK from resizing the node: the port is positioned at
            // x = node.width (right edge), so any ELK-computed size change would push the
            // port outside the node bounds and break edge routing/anchoring.
            return {
                'elk.nodeSize.constraints': 'FIXED_SIZE',
                'elk.portConstraints': 'FIXED_POS',
                'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE'
            };
        }
        
        if (nodeType === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            // Boundary output nodes - place in dedicated rightmost layer.
            // FIXED_SIZE prevents ELK from resizing the node: the port is positioned at
            // x = -portWidth (left edge), so any ELK-computed size change would push the
            // port outside the node bounds and break edge routing/anchoring.
            return {
                'elk.nodeSize.constraints': 'FIXED_SIZE',
                'elk.portConstraints': 'FIXED_POS',
                'elk.layered.layering.layerConstraint': 'LAST_SEPARATE'
            };
        }

        if (nodeType === WorkflowDiagramTypes.COMPARTMENT_HEADER) {
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                // Ensure header fills the width of the node
                'elk.alignment': 'FILL'
            };
        }

        if (nodeType === WorkflowDiagramTypes.COMPARTMENT_PORTS) {
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.spacing.nodeNode': '0',
                'elk.padding': '[top=5,left=0,bottom=5,right=0]',
                'elk.alignment': 'FILL'
            };
        }

        if (nodeType === WorkflowDiagramTypes.COMPARTMENT_PORT_ROW) {
            return {
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.padding': '[top=0,left=5,bottom=0,right=5]',
                'elk.alignment': 'FILL'
            };
        }
        
        // Actor/Network nodes - use the server-provided size as fixed size
        // The server calculates exact dimensions based on ports and label width
        const nodeWidth = node.size?.width ?? 160;
        const nodeHeight = node.size?.height ?? 100;
        
        return {
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${nodeWidth},${nodeHeight})`,
            // CRITICAL: Use FIXED_POS so ELK does NOT move ports.
            // Port labels are placed by ELK, but we still rely on explicit port positions
            // for a stable visual layout and stable edge anchors.
            'elk.portConstraints': 'FIXED_POS',
            // Port spacing within the node (only matters if ports were movable)
            'elk.spacing.portPort': '15',
            // Padding inside the node for content
            'elk.padding': '[top=25,left=8,bottom=8,right=8]',
            // Node label placement
            'elk.nodeLabels.placement': 'H_CENTER V_TOP INSIDE',
            // Port label placement: INSIDE forces them into the node body
            'elk.portLabels.placement': 'INSIDE NEXT_TO_PORT_IF_POSSIBLE',
            // Keep label-to-port spacing tight at node scope too.
            'elk.spacing.labelPortHorizontal': '0',
            'elk.spacing.labelPortVertical': '0'
        };
    }

    /**
     * Port-level layout options.
     * Configure port side based on direction and let ELK handle label placement.
     */
    protected override portOptions(port: GPort): LayoutOptions | undefined {
        const direction = (port as any).args?.['cal:portDirection'] as string | undefined;
        const side = direction === 'output' ? 'EAST' : 'WEST';

        return {
            'elk.port.side': side,
            'elk.portLabels.placement': 'INSIDE NEXT_TO_PORT_IF_POSSIBLE',
            'elk.spacing.labelPortHorizontal': '0',
            'elk.spacing.labelPortVertical': '0'
        };
    }

    /**
     * Edge-level layout options.
     */
    protected override edgeOptions(edge: GEdge): LayoutOptions | undefined {
        return undefined;
    }

    /**
     * Label-level layout options.
     * Port labels should be handled by ELK's port label placement.
     */
    protected override labelOptions(label: GLabel): LayoutOptions | undefined {
        // Port labels are handled by ELK as port labels (children of ports),
        // so no special label options are needed here.
        return undefined;
    }
}
