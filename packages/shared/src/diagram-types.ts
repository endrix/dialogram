/**
 * Workflow Diagram Types
 * 
 * Defines the GLSP model element types used in Workflow network diagrams.
 */

import type { GGraph } from '@eclipse-glsp/server';

/**
 * Minimal diagram model interface used by language-mode operation handlers.
 *
 * The model source populates `workflowName` and the graph;
 * `workflow` is an opaque object whose only accessed property is `.name: string`.
 */
export interface WorkflowDiagramModel {
    graph: GGraph;
    documentUri: string;
    /** Set when loading the source model as `(diagramModel as any).workflowName`. */
    workflowName?: string;
    /** Opaque; the model source sets this to `undefined`. */
    workflow?: { name?: string };
    /**
     * AST-node lookup table.  The model source does NOT populate this;
     * it is only present for legacy code paths that will be removed.
     */
    idToAstNode: Map<string, any>;
    astNodeToId: Map<any, string>;
}

/**
 * Type identifiers for Workflow diagram elements
 * 
 * Spec compliance note: The spec defines types like 'node:entity', 'port:in', 'port:out'.
 * We use more specific types (node:actor, node:network, port:input, port:output) but provide
 * aliases and type guards for spec compatibility.
 */
export namespace WorkflowDiagramTypes {
    // Graph container
    export const GRAPH = 'graph';
    
    // Node types
    export const NODE_ACTOR = 'node:actor';
    export const NODE_EXTERNAL_ACTOR = 'node:external-actor';
    export const NODE_NETWORK = 'node:network';

    // wf-lang semantic aliases (keep GLSP type IDs stable)
    export const NODE_TASK = NODE_ACTOR;
    export const NODE_EXTERNAL_TASK = NODE_EXTERNAL_ACTOR;
    /** Palette-only element type: creates a viewer external task definition + instance. */
    export const NODE_VIEWER_TASK = 'node:viewer-task';
    export const NODE_WORKFLOW = NODE_NETWORK;
    /** Proxy node for indexed entity references like c[i], c[nSegs-1]. Spec: 'node:proxy' */
    export const NODE_PROXY = 'node:proxy';
    export const NODE_COLLAPSED_CONDITIONAL = 'node:collapsed:conditional';
    export const NODE_COLLAPSED_ARRAY = 'node:collapsed:array';
    // Structure visualization nodes
    export const NODE_STRUCTURE_IF = 'node:structure:if';
    export const NODE_STRUCTURE_IF_BRANCH = 'node:structure:if:branch';
    /** Then container. Spec: 'node:structure:then' */
    export const NODE_STRUCTURE_THEN = 'node:structure:then';
    /** Else container. Spec: 'node:structure:else' */
    export const NODE_STRUCTURE_ELSE = 'node:structure:else';
    export const NODE_STRUCTURE_IF_JOIN = 'node:structure:if:join';
    /** Alias for spec compatibility: 'node:join' */
    export const NODE_JOIN = 'node:join';
    // Foreach container + inline statement nodes (purely structural)
    export const NODE_STRUCTURE_FOREACH = 'node:structure:foreach';
    export const NODE_STRUCTURE_FOREACH_JOIN = 'node:structure:foreach:join';
    export const NODE_STRUCTURE_IF_INLINE = 'node:structure:if:inline';
    export const NODE_BOUNDARY_INPUT = 'node:boundary:input';
    export const NODE_BOUNDARY_OUTPUT = 'node:boundary:output';
    
    // Type aliases for spec compatibility
    /** Spec alias: entity nodes are actors or networks */
    export const NODE_ENTITY = NODE_ACTOR;
    
    // Port types
    export const PORT_INPUT = 'port:input';
    export const PORT_OUTPUT = 'port:output';
    /** Spec alias: 'port:in' */
    export const PORT_IN = PORT_INPUT;
    /** Spec alias: 'port:out' */
    export const PORT_OUT = PORT_OUTPUT;
    
    // Edge types
    export const EDGE_CONNECTION = 'edge:connection';
    /** Connection edge variant without arrowheads (used for structural wiring inside grouping nodes like if/then/else/join). */
    export const EDGE_CONNECTION_NO_ARROW = 'edge:connection:no-arrow';
    /** Virtual edge derived from loop structure (e.g., c[nSegs-1] shows connections from c[i] when i=nSegs-1). Read-only. */
    export const EDGE_VIRTUAL = 'edge:virtual';
    
    // Compartment types
    export const COMPARTMENT_HEADER = 'comp:header';
    export const COMPARTMENT_PORTS = 'comp:ports';
    export const COMPARTMENT_PORT_ROW = 'comp:port-row';
    
    // Label types
    export const LABEL_NAME = 'label:name';
    export const LABEL_TYPE = 'label:type';
    export const LABEL_BADGE = 'label:badge';
    // Port label (rendered inside node body near ports)
    export const LABEL_PORT = 'label:port';

    // Boundary port labels (editable)
    export const LABEL_BOUNDARY_NAME = 'label:boundary:name';
    export const LABEL_BOUNDARY_TYPE = 'label:boundary:type';
}

/**
 * CSS class names for Workflow diagram styling
 */
export namespace WorkflowDiagramCss {
    export const NODE = 'workflow-node';
    export const NODE_ACTOR = 'workflow-node-actor';
    export const NODE_EXTERNAL_ACTOR = 'workflow-node-external-actor';
    export const NODE_NETWORK = 'workflow-node-network';

    // wf-lang semantic aliases (keep CSS class names stable)
    export const NODE_TASK = NODE_ACTOR;
    export const NODE_EXTERNAL_TASK = NODE_EXTERNAL_ACTOR;
    export const NODE_WORKFLOW = NODE_NETWORK;
    /** Proxy node for indexed entity references */
    export const NODE_PROXY = 'workflow-node-proxy';
    export const NODE_COLLAPSED = 'workflow-node-collapsed';
    export const NODE_STRUCTURE = 'workflow-node-structure';
    export const NODE_STRUCTURE_IF = 'workflow-node-structure-if';
    export const NODE_STRUCTURE_IF_BRANCH = 'workflow-node-structure-if-branch';
    export const NODE_STRUCTURE_IF_JOIN = 'workflow-node-structure-if-join';
    export const NODE_STRUCTURE_FOREACH = 'workflow-node-structure-foreach';
    export const NODE_STRUCTURE_FOREACH_JOIN = 'workflow-node-structure-foreach-join';
    export const NODE_STRUCTURE_IF_INLINE = 'workflow-node-structure-if-inline';
    export const NODE_BOUNDARY = 'workflow-node-boundary';
    export const NODE_BOUNDARY_INPUT = 'workflow-node-boundary-input';
    export const NODE_BOUNDARY_OUTPUT = 'workflow-node-boundary-output';
    
    export const PORT = 'workflow-port';
    export const PORT_INPUT = 'workflow-port-input';
    export const PORT_OUTPUT = 'workflow-port-output';
    
    export const EDGE = 'workflow-edge';
    /** Virtual edge (dashed, read-only) derived from loop structure. */
    export const EDGE_VIRTUAL = 'workflow-edge-virtual';
    /**
     * A connection that closes a feedback loop — it feeds a stage that runs
     * before it. Always applied by the server; whether it is drawn differently
     * is the reader's choice, made in the webview.
     */
    export const EDGE_FEEDBACK = 'workflow-edge-feedback';
    
    export const LABEL = 'workflow-label';
    export const LABEL_NAME = 'workflow-label-name';
    export const LABEL_TYPE = 'workflow-label-type';

    export const COMPARTMENT = 'workflow-compartment';
    export const COMPARTMENT_HEADER = 'workflow-compartment-header';
    
    export const BADGE_CONDITIONAL = 'workflow-badge-conditional';
    export const BADGE_ARRAY = 'workflow-badge-array';
    
    export const ERROR = 'workflow-error';
    export const WARNING = 'workflow-warning';
}

/**
 * Metadata keys stored on diagram elements
 */
export namespace WorkflowDiagramMetadata {
    // Node metadata
    export const ENTITY_NAME = 'cal:entityName';
    export const ENTITY_TYPE = 'cal:entityType';
    export const AST_PATH = 'cal:astPath';
    export const IS_READ_ONLY = 'cal:readOnly';
    export const IS_COLLAPSED = 'cal:isCollapsed';
    export const IS_NETWORK_INSTANCE = 'cal:isNetworkInstance';
    export const IS_EXTERNAL_ACTOR = 'cal:isExternalActor';
    /** Marks a regular task that contains external function declarations or agent annotations. */
    export const HAS_EXTERNAL_MEMBERS = 'cal:hasExternalMembers';
    /** Marks a node as actively executing during a live run overlay. */
    export const IS_EXECUTING = 'cal:isExecuting';
    /** Marks a node as the entity that was last active when a run finished successfully. */
    export const IS_FINISHED = 'cal:isFinished';
    /** Marks a node as the entity that caused a run failure. */
    export const IS_ERRORED = 'cal:isErrored';
    /** Marks a connection as the one that closes a feedback loop. */
    export const IS_FEEDBACK = 'cal:isFeedback';
    /** Marks a node as a proxy (indexed entity reference like c[i]) */
    export const IS_PROXY = 'cal:isProxy';
    /** Index expression for proxy nodes (e.g., "i", "i-1", "nSegs-1") */
    export const PROXY_INDEX_EXPR = 'cal:proxyIndexExpr';
    /** Base entity name for proxy nodes (e.g., "c" for c[i]) */
    export const PROXY_BASE_ENTITY = 'cal:proxyBaseEntity';
    export const REFERENCED_URI = 'cal:referencedUri';
    /** Resolved referenced definition name (not alias text), used for robust drill-down. */
    export const REFERENCED_ENTITY_NAME = 'cal:referencedEntityName';

    // When an element refers to a definition in another file (e.g. actor/network type),
    // this range points into that referenced document.
    export const REFERENCED_SOURCE_RANGE = 'cal:referencedSourceRange';

    // Source navigation metadata
    // Range is serialized as { start: { line, character }, end: { line, character } }
    // using 0-based line/character positions.
    export const SOURCE_RANGE = 'cal:sourceRange';
    
    // Port metadata
    export const PORT_ID = 'cal:portId';
    export const PORT_NAME = 'cal:portName';
    export const PORT_TYPE = 'cal:portType';
    export const PORT_INDEX = 'cal:portIndex';
    export const PORT_DIRECTION = 'cal:portDirection';
    export const IS_INPUT_PORT = 'cal:isInputPort';
    export const IS_ARRAY_PORT = 'cal:isArrayPort';
    export const ARRAY_SIZE = 'cal:arraySize';
    
    // Edge metadata
    export const SOURCE_PORT_NAME = 'cal:sourcePortName';
    export const TARGET_PORT_NAME = 'cal:targetPortName';

    // Viewer overlay metadata
    // Attached by the GLSP server when a recent successful run overlay is available.
    // Value is the “last token” observed for this connection during the last run (often an absolute file path).
    export const VIEWER_LAST_TOKEN = 'cal:viewerLastToken';
    // Queue trace metadata (when run.wf-queues.json is available).
    // Value is the queue length for the selected step.
    export const QUEUE_SIZE = 'cal:queueSize';

    // Structure-aware edge metadata (for if/else/foreach visualization)
    export const STRUCTURE_BRANCH = 'cal:structureBranch';
    export const STRUCTURE_CONDITION = 'cal:structureCondition';
    export const STRUCTURE_FOREACH = 'cal:structureForeach';

    // The AST path of the structure statement that owns this edge (e.g. StructureStatementIf).
    // Used for stable grouping/routing decisions.
    export const STRUCTURE_OWNER_AST_PATH = 'cal:structureOwnerAstPath';

    // Indexed entity/list references in connections (e.g. bf[0].In)
    export const EDGE_FROM_INDEX = 'cal:fromIndex';
    export const EDGE_TO_INDEX = 'cal:toIndex';

    // Virtual edge metadata (derived from loop structure, read-only)
    /** Marks an edge as virtual (derived, not in AST). */
    export const IS_VIRTUAL = 'cal:isVirtual';
    /** The ID of the loop edge this virtual edge was derived from. */
    export const DERIVED_FROM = 'cal:derivedFrom';
    /** The foreach AST path that the virtual edge is derived from. */
    export const DERIVED_FOREACH_PATH = 'cal:derivedForeachPath';
    
    // Entity parameter metadata
    export const ENTITY_PARAMETERS = 'cal:entityParameters';
    export const ENTITY_DEFINITION_PARAMETERS = 'cal:entityDefParams';

    // Entity definition annotations (from referenced task/workflow definition)
    // Array of: { name: string, text?: string, arguments?: Array<{ name: string, value: string }> }
    export const ENTITY_DEFINITION_ANNOTATIONS = 'cal:entityDefAnnotations';

    // Agent context metadata (from run.wf-agent-context.live.json or run.wf-agent-context.json)
    // Attached to agent nodes when a matching run exists.
    /** JSON string — full chat history: Array<{ role: string, content: string }> */
    export const AGENT_CHAT_HISTORY = 'cal:agentChatHistory';
    /** Number of times the agent has fired. */
    export const AGENT_FIRE_COUNT = 'cal:agentFireCount';
    /** Context budget (max messages). */
    export const AGENT_CONTEXT_BUDGET = 'cal:agentContextBudget';
    /** Truncation strategy: "sliding" | "summarize". */
    export const AGENT_TRUNCATION_STRATEGY = 'cal:agentTruncationStrategy';
    /** Model identifier (e.g. "openai/gpt-5-mini"). */
    export const AGENT_MODEL = 'cal:agentModel';
    /** Whether the agent is stateful. */
    export const AGENT_STATEFUL = 'cal:agentStateful';
    /** Skill status summary for agent node. */
    export const AGENT_SKILL_STATUS = 'cal:agentSkillStatus';
    
    // Network-level metadata (for graph/background)
    export const NETWORK_NAME = 'cal:networkName';
    export const NETWORK_FACTORY_NAME = 'cal:networkFactoryName';
    export const NETWORK_PARAMETERS = 'cal:networkParameters';
    export const NETWORK_VARIABLES = 'cal:networkVariables';
    export const NETWORK_INPUT_PORTS = 'cal:networkInputPorts';
    export const NETWORK_OUTPUT_PORTS = 'cal:networkOutputPorts';

    // wf-lang semantic aliases (keep metadata keys stable)
    export const WORKFLOW_NAME = NETWORK_NAME;
    export const WORKFLOW_FACTORY_NAME = NETWORK_FACTORY_NAME;
    export const WORKFLOW_PARAMETERS = NETWORK_PARAMETERS;
    export const WORKFLOW_VARIABLES = NETWORK_VARIABLES;
    export const WORKFLOW_INPUT_PORTS = NETWORK_INPUT_PORTS;
    export const WORKFLOW_OUTPUT_PORTS = NETWORK_OUTPUT_PORTS;
    
    // Collapsed node metadata
    export const CONDITION_TEXT = 'cal:conditionText';
    export const ARRAY_GENERATOR_TEXT = 'cal:arrayGeneratorText';
    export const ARRAY_COUNT = 'cal:arrayCount';

    // Structure node metadata (used on node:structure:* elements)
    export const STRUCTURE_KIND = 'cal:structureKind';
}
/**
 * Consolidated origin metadata interface (spec-compliant).
 * Use `createOrigin()` and `extractOrigin()` helpers for conversion.
 */
export interface OriginMeta {
    /** AST path (e.g., "/namespaces@0/entities@0/structure/connections@1") */
    astPath: string;
    /** Source range for incremental edits */
    range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

/**
 * Create an OriginMeta object from AST path and optional range.
 */
export function createOrigin(astPath: string, range?: OriginMeta['range']): OriginMeta {
    return range ? { astPath, range } : { astPath };
}

/**
 * Extract OriginMeta from GModel element args (converts flat metadata to spec object).
 */
export function extractOrigin(args: Record<string, unknown> | undefined): OriginMeta | undefined {
    if (!args) return undefined;
    const astPath = args[WorkflowDiagramMetadata.AST_PATH];
    if (typeof astPath !== 'string') return undefined;
    
    const range = args[WorkflowDiagramMetadata.SOURCE_RANGE] as OriginMeta['range'] | undefined;
    return createOrigin(astPath, range);
}

/**
 * Convert OriginMeta back to flat args for GModel elements.
 */
export function originToArgs(origin: OriginMeta): Record<string, unknown> {
    const args: Record<string, unknown> = {
        [WorkflowDiagramMetadata.AST_PATH]: origin.astPath,
    };
    if (origin.range) {
        args[WorkflowDiagramMetadata.SOURCE_RANGE] = origin.range;
    }
    return args;
}

/**
 * Type guards for diagram element types
 */
export namespace WorkflowDiagramTypeGuards {
    /** Check if element is an entity node (task/workflow, or external task) */
    export function isEntityNode(type: string): boolean {
        return type === WorkflowDiagramTypes.NODE_TASK
            || type === WorkflowDiagramTypes.NODE_WORKFLOW
            || type === WorkflowDiagramTypes.NODE_EXTERNAL_TASK;
    }
    
    /** Check if element is a proxy node */
    export function isProxyNode(type: string): boolean {
        return type === WorkflowDiagramTypes.NODE_PROXY;
    }
    
    /** Check if element is a container node */
    export function isContainerNode(type: string): boolean {
        // wf-lang diagrams currently do not model CAL control-structure containers (if/foreach).
        // Only flat structure connections are visualized.
        return false;
    }
    
    /** Check if element is a join node (derived, read-only) */
    export function isJoinNode(type: string): boolean {
        // wf-lang diagrams do not emit join nodes.
        return false;
    }
    
    /** Check if element is a virtual edge (derived, read-only) */
    export function isVirtualEdge(type: string): boolean {
        // wf-lang diagrams do not emit virtual edges.
        return false;
    }
    
    /** Check if element is read-only (derived elements like joins and virtual edges) */
    export function isReadOnlyElement(type: string, args?: Record<string, unknown>): boolean {
        return args?.[WorkflowDiagramMetadata.IS_READ_ONLY] === true 
            || args?.[WorkflowDiagramMetadata.IS_VIRTUAL] === true;
    }
    
    /** Check if element is an input port */
    export function isInputPort(type: string): boolean {
        return type === WorkflowDiagramTypes.PORT_INPUT;
    }
    
    /** Check if element is an output port */
    export function isOutputPort(type: string): boolean {
        return type === WorkflowDiagramTypes.PORT_OUTPUT;
    }
}
