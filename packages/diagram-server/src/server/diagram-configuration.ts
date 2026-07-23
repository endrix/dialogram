/**
 * Workflow GLSP Diagram Configuration
 *
 * Type mapping and shape/edge type hints for Workflow network diagrams.
 */

import 'reflect-metadata';

import {
    DiagramConfiguration,
    GGraph,
    GNode,
    GPort,
    GLabel,
    GEdge,
    GCompartment,
    GModelElementConstructor,
    ServerLayoutKind
} from '@eclipse-glsp/server';
import { ShapeTypeHint, EdgeTypeHint } from '@eclipse-glsp/protocol';
import { injectable } from 'inversify';
import { WorkflowDiagramTypes } from '@dialogram/shared';

/**
 * Workflow-specific diagram configuration
 */
@injectable()
export class WorkflowDiagramConfiguration implements DiagramConfiguration {
    readonly typeMapping: Map<string, GModelElementConstructor>;

    /**
     * Run ELK automatically once bounds are available so initial render is laid out.
     */
    readonly layoutKind = ServerLayoutKind.MANUAL;

    /**
     * Whether the client needs to compute bounds before rendering.
     * Set to true for diagrams that need layout computation.
     */
    readonly needsClientLayout = true;

    /**
     * Whether the diagram supports animation.
     */
    readonly animatedUpdate = true;

    constructor() {
        this.typeMapping = this.createTypeMapping();
    }

    /**
     * Create the type mapping from Workflow element types to GModel constructors.
     * This maps diagram element types to their corresponding ES6 class constructors.
     */
    protected createTypeMapping(): Map<string, GModelElementConstructor> {
        const mapping = new Map<string, GModelElementConstructor>();

        // Graph container
        mapping.set(WorkflowDiagramTypes.GRAPH, GGraph);

        // Node types
        mapping.set(WorkflowDiagramTypes.NODE_ACTOR, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_NETWORK, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_PROXY, GNode);  // Indexed entity references
        mapping.set(WorkflowDiagramTypes.NODE_COLLAPSED_CONDITIONAL, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_COLLAPSED_ARRAY, GNode);
        // Structure visualization nodes
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_IF, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_THEN, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_ELSE, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_IF_JOIN, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH_JOIN, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_STRUCTURE_IF_INLINE, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, GNode);
        mapping.set(WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, GNode);

        // Port types
        mapping.set(WorkflowDiagramTypes.PORT_INPUT, GPort);
        mapping.set(WorkflowDiagramTypes.PORT_OUTPUT, GPort);

        // Edge types
        mapping.set(WorkflowDiagramTypes.EDGE_CONNECTION, GEdge);
        mapping.set(WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW, GEdge);
        mapping.set(WorkflowDiagramTypes.EDGE_VIRTUAL, GEdge);  // Virtual edges (derived from foreach)

        // Label types
        mapping.set(WorkflowDiagramTypes.LABEL_NAME, GLabel);
        mapping.set(WorkflowDiagramTypes.LABEL_TYPE, GLabel);
        mapping.set(WorkflowDiagramTypes.LABEL_BADGE, GLabel);
        mapping.set(WorkflowDiagramTypes.LABEL_PORT, GLabel);
        mapping.set(WorkflowDiagramTypes.LABEL_BOUNDARY_NAME, GLabel);
        mapping.set(WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE, GLabel);

        // Compartment types
        mapping.set(WorkflowDiagramTypes.COMPARTMENT_HEADER, GCompartment);
        mapping.set(WorkflowDiagramTypes.COMPARTMENT_PORTS, GCompartment);
        mapping.set(WorkflowDiagramTypes.COMPARTMENT_PORT_ROW, GCompartment);

        return mapping;
    }

    /**
     * Get the shape type hints that can be created via create node operations.
     */
    get shapeTypeHints(): ShapeTypeHint[] {
        return [
            // Main entity nodes (user-created, movable, deletable)
            {
                elementTypeId: WorkflowDiagramTypes.NODE_ACTOR,
                repositionable: true,
                deletable: true,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_NETWORK,
                repositionable: true,
                deletable: true,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR,
                repositionable: true,
                deletable: true,
                resizable: false,
                reparentable: false
            },
            // Boundary ports (user-created, movable, deletable)
            {
                elementTypeId: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
                repositionable: true,
                deletable: true,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT,
                repositionable: true,
                deletable: true,
                resizable: false,
                reparentable: false
            },
            // Proxy nodes (indexed entity references like c[i], c[nSegs-1])
            // Movable but not deletable (derived from foreach)
            {
                elementTypeId: WorkflowDiagramTypes.NODE_PROXY,
                repositionable: true,
                deletable: false,
                resizable: false,
                reparentable: false
            },
            // Structure containers (movable for layout, not deletable)
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH,
                repositionable: true,
                deletable: false,
                resizable: true,  // Allow resize to fit children
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_IF,
                repositionable: true,
                deletable: false,
                resizable: true,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH,
                repositionable: false,  // Branch position is determined by parent if
                deletable: false,
                resizable: true,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_THEN,
                repositionable: false,
                deletable: false,
                resizable: true,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_ELSE,
                repositionable: false,
                deletable: false,
                resizable: true,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_IF_JOIN,
                repositionable: false,  // Join position is derived
                deletable: false,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH_JOIN,
                repositionable: false,  // Foreach join position is derived
                deletable: false,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_STRUCTURE_IF_INLINE,
                repositionable: true,
                deletable: false,
                resizable: false,
                reparentable: false
            },
            // Collapsed nodes (movable, not directly deletable)
            {
                elementTypeId: WorkflowDiagramTypes.NODE_COLLAPSED_CONDITIONAL,
                repositionable: true,
                deletable: false,
                resizable: false,
                reparentable: false
            },
            {
                elementTypeId: WorkflowDiagramTypes.NODE_COLLAPSED_ARRAY,
                repositionable: true,
                deletable: false,
                resizable: false,
                reparentable: false
            }
        ];
    }

    /**
     * Get the edge type hints that can be created via create edge operations.
     */
    get edgeTypeHints(): EdgeTypeHint[] {
        return [
            {
                elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION,
                dynamic: true,
                repositionable: true,
                deletable: true,
                routable: true,
                sourceElementTypeIds: [
                    WorkflowDiagramTypes.PORT_OUTPUT
                ],
                targetElementTypeIds: [
                    WorkflowDiagramTypes.PORT_INPUT
                ]
            }
        ];
    }
}
