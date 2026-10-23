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
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, normalizePortSide } from '@dialogram/shared';
import { groupLayoutOptions } from '../model/group-edges';

/** The margin a boundary node was placed in by its producer, when it was not left to its direction. */
function boundaryMargin(node: GNode): 'WEST' | 'EAST' | undefined {
    return normalizePortSide((node.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.BOUNDARY_SIDE]);
}

/**
 * Layout presets by graph size.
 *
 * ELK's layered algorithm with the default preset below lays out a diagram of a
 * few dozen nodes in well under a second, and that preset is what every test and
 * every persisted layout was tuned against. It does not scale: measured
 * standalone on the exact graphs the engine hands to `elk.layout`, four real
 * netlist modules of a hardware product,
 *
 * | nodes | edges | default | middle | fast  |
 * | ----: | ----: | ------: | -----: | ----: |
 * |   212 |   445 |   5.8 s |  ~1 s  | 0.9 s |
 * |   344 |   936 |    41 s |  1.7 s | 1.3 s |
 * |  1528 |  3617 |   334 s |  9.3 s | 3.8 s |
 * |  3293 |  8112 | RangeError: Maximum call stack size exceeded inside ELK | | 10 s |
 *
 * Two options carry the cost. `nodePlacement.strategy: NETWORK_SIMPLEX` is the
 * dominant one: switching it alone takes the 344-node module from 41 s to
 * 3.8 s. `considerModelOrder.strategy: NODES_AND_EDGES` is the other, a
 * ten-fold factor on the cheap presets. Crossing minimisation is not the cost.
 * Edge routing is, once placement is simple: the fast preset with ORTHOGONAL
 * routing takes 2.7 s on the 344-node module, 31 s on 1528 and 2289 s on 3293,
 * against 0.9 s, 3.8 s and 11.5 s with POLYLINE. So the fast preset routes
 * polylines, the one place the platform does; the middle preset stays
 * orthogonal, where POLYLINE was the slower of the two.
 *
 * So the graph's size picks the preset. Up to {@link LAYOUT_TIER_MIDDLE_NODES}
 * nodes and {@link LAYOUT_TIER_MIDDLE_EDGES} edges the options are exactly the
 * default preset, byte for byte. Above that the middle preset gives up model
 * order and network-simplex placement, which is what makes the 344-node module
 * open in under two seconds instead of forty. Above
 * {@link LAYOUT_TIER_FAST_NODES} nodes or {@link LAYOUT_TIER_FAST_EDGES} edges
 * the fast preset also gives up crossing minimisation and orthogonal routing
 * and takes simple placement: a rough layout in seconds for a graph the
 * default preset cannot lay out at all. The rule depends on nothing but node and edge counts.
 *
 * The tier applies wherever the configurator does: the initial layout on open,
 * Layout Diagram, the boundary-flow, Untangled and Free Ports layouts, and the
 * Free Ports probe. A layout that sets options on the graph (see
 * UNTANGLED_ELK_OPTIONS in operations/layout-tuned-handler.ts) is merged over
 * the preset by the engine, except in the fast tier, where the engine re-asserts
 * the fast preset: the default options crash on the largest graphs, so there
 * the tier wins.
 */
export type LayoutTier = 'default' | 'middle' | 'fast';

/** Above this many nodes the middle preset applies. */
export const LAYOUT_TIER_MIDDLE_NODES = 150;
/** Above this many edges the middle preset applies, whatever the node count. */
export const LAYOUT_TIER_MIDDLE_EDGES = 400;
/** Above this many nodes the fast preset applies. */
export const LAYOUT_TIER_FAST_NODES = 1000;
/** Above this many edges the fast preset applies, whatever the node count. */
export const LAYOUT_TIER_FAST_EDGES = 3000;

/** The middle preset: the default without model order and network-simplex placement. */
export const MIDDLE_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
    'elk.layered.considerModelOrder.strategy': 'NONE',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.thoroughness': '3'
};

/** The fast preset: the middle without crossing minimisation, with simple placement and polyline routing. */
export const FAST_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
    ...MIDDLE_LAYOUT_OPTIONS,
    'elk.layered.crossingMinimization.strategy': 'NONE',
    'elk.layered.nodePlacement.strategy': 'SIMPLE',
    'elk.layered.thoroughness': '1',
    'elk.edgeRouting': 'POLYLINE'
};

/** What each tier lays over the default preset; the default tier lays nothing. */
export const LAYOUT_TIER_OPTIONS: Readonly<Record<LayoutTier, Readonly<Record<string, string>>>> = {
    default: {},
    middle: MIDDLE_LAYOUT_OPTIONS,
    fast: FAST_LAYOUT_OPTIONS
};

export interface LayoutGraphSize {
    nodes: number;
    edges: number;
}

/**
 * The nodes and edges a layout has to place: every GNode at any depth that is
 * not a compartment (a header or port row is a GNode in some products and never
 * laid out by ELK as a node) and every GEdge at any depth.
 */
export function countLayoutElements(root: GModelElement): LayoutGraphSize {
    const size: LayoutGraphSize = { nodes: 0, edges: 0 };
    const visit = (element: GModelElement): void => {
        if (element instanceof GNode && !element.type.startsWith('comp:')) {
            size.nodes++;
        } else if (element instanceof GEdge) {
            size.edges++;
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    for (const child of root.children ?? []) {
        visit(child);
    }
    return size;
}

/** The tier a graph of this size lays out in. */
export function layoutTierFor(size: LayoutGraphSize): LayoutTier {
    if (size.nodes > LAYOUT_TIER_FAST_NODES || size.edges > LAYOUT_TIER_FAST_EDGES) {
        return 'fast';
    }
    if (size.nodes > LAYOUT_TIER_MIDDLE_NODES || size.edges > LAYOUT_TIER_MIDDLE_EDGES) {
        return 'middle';
    }
    return 'default';
}

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

        // Standard 'layered' configuration. The graph's size picks the tier laid
        // over it; the default tier lays nothing over it, so a graph under the
        // first threshold gets exactly these options.
        const tier = layoutTierFor(countLayoutElements(graph));
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
            'elk.layered.feedbackEdges': 'true',

            ...LAYOUT_TIER_OPTIONS[tier]
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

        if (nodeType === WorkflowDiagramTypes.NODE_GROUP) {
            // A producer's group: laid out on its own, members first, with its
            // header band and the boundary ports its crossing edges pass through.
            return groupLayoutOptions();
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
            // Unless the producer placed it with its bundle on the other margin
            // (`cal:boundarySide`), in which case it goes with the outputs.
            return {
                'elk.nodeSize.constraints': 'FIXED_SIZE',
                'elk.portConstraints': 'FIXED_POS',
                'elk.layered.layering.layerConstraint': boundaryMargin(node) === 'EAST' ? 'LAST_SEPARATE' : 'FIRST_SEPARATE'
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
                'elk.layered.layering.layerConstraint': boundaryMargin(node) === 'WEST' ? 'FIRST_SEPARATE' : 'LAST_SEPARATE'
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
        // The side the producer placed the port on wins over its direction
        // (`cal:portSide`, a bundle's `ready` beside its `valid`); this is the
        // side ELK routes to, so it has to be the one the anchor and the
        // glyph use, or a wire reaches the port from across its own node.
        // Without one, the direction decides exactly as before.
        const args = (port as any).args as Record<string, unknown> | undefined;
        const direction = args?.['cal:portDirection'] as string | undefined;
        const side = normalizePortSide(args?.[WorkflowDiagramMetadata.PORT_SIDE]) ?? (direction === 'output' ? 'EAST' : 'WEST');

        // A group's boundary port sits centred on the frame line, where the
        // edge crosses it, rather than outside it.
        const onFrame = port.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY
            ? { 'elk.port.borderOffset': String(-WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX / 2) }
            : {};
        return {
            ...onFrame,
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
