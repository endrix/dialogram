/**
 * Workflow Diagram Types
 * 
 * Defines the GLSP model element types used in Workflow network diagrams.
 */

import type { GGraph } from '@eclipse-glsp/server';

/**
 * Minimal diagram model interface used by the operation handlers.
 *
 * The model source populates the graph and `workflowName`.
 */
export interface WorkflowDiagramModel {
    graph: GGraph;
    documentUri: string;
    /** Set when loading the source model as `(diagramModel as any).workflowName`. */
    workflowName?: string;
}

/**
 * Type identifiers for Workflow diagram elements
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
    // Structure visualization nodes
    export const NODE_STRUCTURE_IF = 'node:structure:if';
    /** Then container. Spec: 'node:structure:then' */
    export const NODE_STRUCTURE_THEN = 'node:structure:then';
    /** Else container. Spec: 'node:structure:else' */
    export const NODE_STRUCTURE_ELSE = 'node:structure:else';
    // Foreach container (purely structural)
    export const NODE_STRUCTURE_FOREACH = 'node:structure:foreach';
    /**
     * A producer's own grouping of nodes: a scope of kind `group` in the
     * document, drawn as a labelled container around its members. The
     * platform learns nothing from the grouping but that the members belong
     * together; what a group IS (a layer, a domain, a stage) is the
     * producer's business and shows only in its label.
     */
    export const NODE_GROUP = 'node:group';
    export const NODE_BOUNDARY_INPUT = 'node:boundary:input';
    export const NODE_BOUNDARY_OUTPUT = 'node:boundary:output';
    /**
     * A state of an automaton: a node of kind `state` in the document. It has
     * no ports; what leaves and enters it are transitions
     * ({@link EDGE_TRANSITION}).
     */
    export const NODE_STATE = 'node:state';
    
    // Port types
    export const PORT_INPUT = 'port:input';
    export const PORT_OUTPUT = 'port:output';
    /** Where an edge crosses a group's frame: the server splits an edge that
     *  enters or leaves a group at one of these, so each group lays out on its
     *  own. Not a port anyone connects to. */
    export const PORT_GROUP_BOUNDARY = 'port:group-boundary';
    
    // Edge types
    export const EDGE_CONNECTION = 'edge:connection';
    /** Connection edge variant without arrowheads (used for structural wiring inside grouping nodes like if/then/else/join). */
    export const EDGE_CONNECTION_NO_ARROW = 'edge:connection:no-arrow';
    /**
     * A transition of an automaton: an edge of the document whose two ends
     * name states. It ends on the states themselves and carries no route: it
     * is drawn from where its states are. What takes it is its label, and the
     * transitions between the same two states are drawn as one line with
     * their labels beside it, each selected on its own.
     */
    export const EDGE_TRANSITION = 'edge:transition';
    
    // Compartment types
    export const COMPARTMENT_HEADER = 'comp:header';
    
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
    export const NODE_STRUCTURE = 'workflow-node-structure';
    export const NODE_STRUCTURE_IF = 'workflow-node-structure-if';
    export const NODE_STRUCTURE_FOREACH = 'workflow-node-structure-foreach';
    export const NODE_GROUP = 'workflow-node-group';
    /** A symbol's pin, drawn as its stub. */
    export const SYMBOL_PIN = 'symbol-pin';
    /** A symbol pin's name, shown on a register only. */
    export const SYMBOL_PIN_LABEL_HIDDEN = 'symbol-pin-label-hidden';
    export const GROUP_BOUNDARY_PORT = 'workflow-group-boundary-port';
    /** A boundary port where edges arrive at the group itself: no dot, the arrowhead meets the frame. */
    export const GROUP_END_PORT = 'workflow-group-end-port';
    /** A group whose loop stands for an edge in error. */
    export const GROUP_LOOP_ERROR = 'workflow-group-loop-error';
    /** An edge the producer marked as in error. */
    export const EDGE_ERROR = 'cal-edge-error';
    export const NODE_BOUNDARY = 'workflow-node-boundary';
    export const NODE_BOUNDARY_INPUT = 'workflow-node-boundary-input';
    export const NODE_BOUNDARY_OUTPUT = 'workflow-node-boundary-output';
    
    export const PORT = 'workflow-port';
    export const PORT_INPUT = 'workflow-port-input';
    export const PORT_OUTPUT = 'workflow-port-output';
    
    /**
     * A connection that closes a feedback loop — it feeds a stage that runs
     * before it. Always applied by the server; whether it is drawn differently
     * is the reader's choice, made in the webview.
     */
    export const EDGE_FEEDBACK = 'workflow-edge-feedback';
    /** A bundle of ports drawn as one port, a bus (see `PORT_BUS_GROUP`). */
    export const PORT_BUS = 'workflow-port-bus';
    /** A port drawn under its open bundle's header row. */
    export const PORT_BUS_MEMBER = 'workflow-port-bus-member';
    /** The one edge that stands for every connection between two buses. */
    export const EDGE_BUS = 'workflow-edge-bus';
    
    export const LABEL = 'workflow-label';
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
    export const IS_NETWORK_INSTANCE = 'cal:isNetworkInstance';
    /** The views the producer offers of the unit behind a node besides its
     *  structure, `[{ id, label, of? }]` as it listed them on `meta.views` (a
     *  leaf's synthesis, say; `of: 'instance'` for a view of this instance and
     *  not of the definition). On the root: the views of the unit shown. */
    export const VIEWS = 'wf:views';
    /**
     * Labelled values a producer states about the unit behind a node, as it
     * listed them on `meta.facts`: `[{ label, value, markdown? }]`, in its
     * order. On the root: the facts of the unit shown.
     *
     * The platform displays them and never interprets them. No label is
     * special and none is expected, so a product says whatever it knows (a
     * clock, a cost, a revision) without the platform learning the word. An
     * entry with `markdown: true` has its value rendered as Markdown through
     * the same sanitizer the chat uses; the rest is shown verbatim.
     */
    export const FACTS = 'wf:facts';
    /**
     * Short marks a producer puts on a node's header, as it listed them on
     * `meta.badges`: `[{ text, tone? }]`, drawn right-aligned in the header
     * in that order. `tone` is `neutral` (the default), `info`, `warning` or
     * `error` and picks the colour; the text is the producer's word and the
     * platform reads nothing into it. For what a reader must see without
     * opening the panel: a modality, a status, a count.
     */
    export const BADGES = 'wf:badges';
    /** What a double-click on the node opens, `{ uri, line? }`, as the
     *  producer said on `meta.open` (`{ file, line? }`): a file the node stands
     *  for, such as the code a specification clause names. It wins over a
     *  drill-down, the node's views and its definition. */
    export const OPEN_TARGET = 'wf:open';
    /** The node's id in the producer's graph document. The diagram names a
     *  node after its label, so this is how a producer's own reference to a
     *  node (a `#<id>` link in its text, a published node state, an outline
     *  row) finds it. */
    export const GRAPH_NODE_ID = 'wf:graphNodeId';
    export const IS_EXTERNAL_ACTOR = 'cal:isExternalActor';
    /** Marks a node as actively executing during a live run overlay. */
    export const IS_EXECUTING = 'cal:isExecuting';
    /** Marks a node as the entity that was last active when a run finished successfully. */
    export const IS_FINISHED = 'cal:isFinished';
    /** Marks a node as the entity that caused a run failure. */
    export const IS_ERRORED = 'cal:isErrored';
    /** Marks a connection as the one that closes a feedback loop. */
    export const IS_FEEDBACK = 'cal:isFeedback';
    /**
     * Set when the PRODUCER named this connection as the loop-closing one,
     * rather than the platform deriving it from the graph's shape.
     *
     * Both are legitimate and they answer slightly different questions. The
     * derived answer is a fact about the drawing — which edges point backwards
     * in the order the layout will use — and it is the only answer available
     * when the producer has no opinion. But a producer often knows something
     * the shape cannot show: in a synchronous design every loop is closed by a
     * state element, and which edge that is has a right answer that a
     * cycle-breaking heuristic can miss, because several edges of one cycle
     * are equally good candidates by shape alone.
     *
     * So the presence of this key anywhere in a document switches the whole
     * graph to the producer's answer. All-or-nothing on purpose: mixing a
     * declared set with a derived one would mark a cycle twice — once where
     * the producer said, once where the heuristic guessed — and a reader
     * cannot tell which of the two marks means anything.
     */
    export const DECLARED_FEEDBACK = 'cal:declaredFeedback';
    /**
     * How much a connection carries, when the producer states it.
     *
     * A number in whatever unit the producer counts in; the platform displays
     * it and never interprets it. {@link EDGE_LABEL} says the same thing in the
     * producer's own words and takes precedence where both are given.
     */
    export const EDGE_WIDTH = 'cal:edgeWidth';
    /**
     * What a connection carries, in the producer's own words.
     *
     * Formatted by the producer and displayed verbatim, for the same reason a
     * port's type is: the platform re-rendering it from anything structural
     * would drift from how the language actually writes it, and differ between
     * products. Takes precedence over {@link EDGE_WIDTH}, which describes the
     * same thing at lower resolution.
     */
    export const EDGE_LABEL = 'cal:edgeLabel';
    /** What a connection is for, beyond carrying data. Producer-defined. */
    export const EDGE_ROLE = 'cal:edgeRole';
    /** What a port is for, beyond carrying data. Producer-defined. */
    export const PORT_ROLE = 'cal:portRole';
    export const REFERENCED_URI = 'cal:referencedUri';
    /** Resolved referenced definition name (not alias text), used for robust drill-down. */
    export const REFERENCED_ENTITY_NAME = 'cal:referencedEntityName';

    /**
     * Where this element was AUTHORED, when that is a different file again.
     *
     * A third navigation target, because two were not enough for a diagram
     * whose own file nobody wrote by hand.
     *
     * `REFERENCED_URI` already answers two questions at once — *drill into this
     * element* and *show me its source* — and that works only while both have
     * the same answer. For a diagram generated from something else they come
     * apart: drilling has to stay inside the generated file, because that is
     * where the definitions being drilled into live, while "show me the source"
     * wants the file a person actually typed. Forcing both through one slot
     * means choosing which of the two features to break.
     *
     * So a producer that knows both says so, and neither has to lose. Nothing
     * here names a language or a toolchain: any product with a compile step
     * between what someone wrote and what the diagram is built from has exactly
     * this shape.
     *
     * Absent for a diagram whose file IS the authored one, which is the common
     * case and behaves exactly as before.
     */
    export const AUTHORED_URI = 'cal:authoredUri';
    export const AUTHORED_SOURCE_RANGE = 'cal:authoredSourceRange';

    // When an element refers to a definition in another file (e.g. actor/network type),
    // this range points into that referenced document.
    export const REFERENCED_SOURCE_RANGE = 'cal:referencedSourceRange';

    /**
     * `REFERENCED_URI` and its range are the element's DEFINITION, named by
     * the producer: where the class or function it instantiates is declared,
     * in whichever file the producer found it.
     *
     * Without it the referenced target may be only the place the element is
     * written in the file on screen, and "go to definition" asks the host's
     * language tooling to find the definition from there. A producer that
     * resolved the name itself (it imported the module, or elaborated the
     * design) knows the answer for certain, and the language tooling may be
     * configured for another interpreter or other import roots: so when this
     * is set the target is opened as it is and nothing else is asked.
     */
    export const REFERENCED_IS_DEFINITION = 'cal:referencedIsDefinition';

    // Source navigation metadata
    // Range is serialized as { start: { line, character }, end: { line, character } }
    // using 0-based line/character positions.
    export const SOURCE_RANGE = 'cal:sourceRange';
    
    // Port metadata
    export const PORT_ID = 'cal:portId';
    export const PORT_NAME = 'cal:portName';
    export const PORT_TYPE = 'cal:portType';
    export const PORT_DIRECTION = 'cal:portDirection';
    export const IS_INPUT_PORT = 'cal:isInputPort';
    /**
     * Which side of its node the port sits on, `'WEST'` or `'EAST'`, when the
     * producer places it with its bundle rather than by its direction: a
     * handshake's `ready` beside the `valid` and `data` it answers, so the wire
     * between two nodes runs straight instead of looping around both. Absent,
     * the side follows the direction. The direction itself is untouched.
     */
    export const PORT_SIDE = 'cal:portSide';
    /** The bundle the port belongs to (`s_axis`), a producer's fact. */
    export const PORT_GROUP = 'cal:portGroup';
    /**
     * On a bus port: the bundle it stands for. A bus is the platform's, never
     * the producer's: the ports of one {@link PORT_GROUP} drawn as one row, with
     * a toggle in front of the name that opens the bundle. Open, the row stays
     * as the bundle's header and its members are drawn under it.
     */
    export const PORT_BUS_GROUP = 'cal:portBusGroup';
    /** On a bus port: `true` when the bundle is open, its members drawn under it. */
    export const PORT_BUS_EXPANDED = 'cal:portBusExpanded';
    /** On a bus port: how many ports the bundle has. */
    export const PORT_BUS_MEMBERS = 'cal:portBusMembers';
    /** On a port: the bundle whose open header it is drawn under. */
    export const PORT_BUS_MEMBER_OF = 'cal:portBusMemberOf';
    /** On a bus edge: how many connections it stands for. */
    export const EDGE_BUS_MEMBERS = 'cal:edgeBusMembers';
    /**
     * On a boundary node: `'WEST'` or `'EAST'` when the producer places it with
     * its bundle rather than by its direction (an output `ready` beside the
     * input bundle it belongs to). The glyph, the text and the port mirror.
     */
    export const BOUNDARY_SIDE = 'cal:boundarySide';
    /**
     * On a boundary node standing for a bundle of the unit's ports: its
     * members' node ids, in order (port-bundles.ts).
     */
    export const BOUNDARY_BUS_MEMBERS = 'wf:busMembers';
    /** The producer's `meta` of a node, as it sent it. */
    export const NODE_META = 'wf:nodeMeta';
    /** On a node holding a graph of its own: it can be opened in place (node-open.ts). */
    export const NODE_OPENABLE = 'wf:openable';
    /** On the frame an open node is drawn as: the node's key, to close it by. */
    export const OPEN_NODE_KEY = 'wf:openNodeKey';
    /** On that frame: the node's open bundles, saved again while they are not drawn. */
    export const OPEN_NODE_BUNDLES = 'wf:openNodeBundles';
    /** What a node is drawn as, when not a box (`SymbolKind`, symbol-geometry.ts). */
    export const SYMBOL = 'wf:symbol';
    /** The glyph an `operator` symbol shows (`+`, `==`, `&`). */
    export const SYMBOL_OPERATOR = 'wf:symbolOperator';
    /** The name shown under a symbol: a `register`'s label, or any symbol's `meta.caption`. */
    export const SYMBOL_CAPTION = 'wf:symbolCaption';
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

    // Indexed entity/list references in connections (e.g. bf[0].In)
    export const EDGE_FROM_INDEX = 'cal:fromIndex';
    export const EDGE_TO_INDEX = 'cal:toIndex';
    /** The edge's indices are the bits of a port it is (a producer's `fromSlice`/`toSlice`): always written. */
    export const EDGE_SLICE = 'wf:slice';
    /**
     * The bits written as the producer's language writes them (a producer's
     * `fromSliceLabel`/`toSliceLabel`: VHDL's `(7 downto 4)`), drawn as they
     * are instead of `[7:4]`. The index stays the bits, by which wires meeting
     * one port are ordered.
     */
    export const EDGE_FROM_INDEX_LABEL = 'wf:fromIndexLabel';
    export const EDGE_TO_INDEX_LABEL = 'wf:toIndexLabel';

    /** Marks an edge as derived (not in the source), hence read-only. */
    export const IS_VIRTUAL = 'cal:isVirtual';
    
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
    /** Skill status summary for agent node. */
    export const AGENT_SKILL_STATUS = 'cal:agentSkillStatus';
    
    // Network-level metadata (for graph/background)
    /**
     * On the root: the view shown is read-only, as the producer marked it
     * (`graph.meta.readOnly`). A projection of a file it reads but does not
     * write, a project overview: nothing in it can be created, renamed,
     * duplicated or removed, so the client hides the palette's tools while it
     * is shown and the editing items leave the context menu. Moving nodes and laying them out stay;
     * they change the drawing, not the source. Per view, so one editor can
     * pass from an editable view to a read-only one and back.
     */
    export const READ_ONLY_VIEW = 'wf:readOnlyView';
    export const NETWORK_NAME = 'cal:networkName';
    export const NETWORK_FACTORY_NAME = 'cal:networkFactoryName';
    export const NETWORK_PARAMETERS = 'cal:networkParameters';

    // wf-lang semantic alias (keeps the metadata key stable)
    export const WORKFLOW_NAME = NETWORK_NAME;
    
    export const CONDITION_TEXT = 'cal:conditionText';

    // Structure node metadata (used on node:structure:* elements)
    export const STRUCTURE_KIND = 'cal:structureKind';
    /** The label a group container shows: the scope's `label`, else the last
     *  segment of its id. */
    export const GROUP_LABEL = 'wf:groupLabel';
    /** On a piece of an edge split at group frames: the id of the edge it is a
     *  piece of (the first, for a piece several edges share). The piece that
     *  keeps the edge's own id carries it too. */
    export const EDGE_OF = 'wf:edgeOf';
    /** Every edge a piece stands for, as a list: one for the stretch between
     *  frames, several for a stretch inside a group that edges share. */
    export const EDGES_OF = 'wf:edgesOf';
    /** Which piece: `source` (inside the source's groups), `middle` (between
     *  the outermost frames), or `target`. */
    export const EDGE_SEGMENT = 'wf:edgeSegment';
    /** On a port of a group's frame: an edge ends (or starts) here, at the
     *  frame itself, instead of crossing it to a member. */
    export const GROUP_END = 'wf:groupEnd';
    /** On a group: it has edges between itself and its own members, drawn as
     *  one loop on the frame. */
    export const GROUP_LOOP = 'wf:groupLoop';
    /** On a group with a loop: what the edges it stands for said (their
     *  captions, their error messages), one line each, for the loop's tooltip. */
    export const GROUP_LOOP_NOTES = 'wf:groupLoopNotes';
    /** On a member of a group, a node or a group nested in it: the row the
     *  producer puts it in (a node's `meta.row`, a scope's `row`), the first
     *  row on top. */
    export const GROUP_ROW = 'wf:groupRow';
    /** On a group: its members are laid out in rows (`GROUP_ROW`). */
    export const GROUP_ROWS = 'wf:groupRows';
    /** On a group: where the producer pins it (`pin: 'top'`), out of the flow
     *  of the diagram: in a band above everything else. */
    export const GROUP_PIN = 'wf:groupPin';
    /** On a group: the producer marks it as the one the diagram's flow starts
     *  in (`initial` on its scope): the initial state of a state machine. Not
     *  the pair of `GROUP_END`, which is where an edge meets a frame. */
    export const GROUP_INITIAL = 'wf:groupInitial';
    /** On a node: the lines of text a producer puts in it (`NodeLine[]`, from
     *  `meta.lines`): bands across the bottom of its body, their text drawn
     *  only close in. */
    export const NODE_LINES = 'wf:nodeLines';
    /** On the root: the links drawn only while one of their ends is selected
     *  (`SelectionLink[]`, from the edges a producer marks `meta.onSelection`). */
    export const SELECTION_LINKS = 'wf:selectionLinks';
    /** On a node: the thing it is one drawing of (`meta.sameAs`). Selecting a
     *  node outlines the others that draw the same thing. */
    export const SAME_AS = 'wf:sameAs';
    /** On a state: the automaton starts in it (`meta.initial` of the node). */
    export const STATE_INITIAL = 'wf:stateInitial';
    /** On a transition: how wide the server takes its label to be drawn, in
     *  px, so that the client places it without measuring. */
    export const TRANSITION_LABEL_WIDTH = 'wf:transitionLabelWidth';
    /** On a transition: its place in the order its state tries its
     *  transitions in, from 1 (`meta.order` of the edge). Transitions of one
     *  state with the same place are tried in no order. */
    export const TRANSITION_ORDER = 'wf:transitionOrder';
    /** On a transition: the condition it is taken under, as the producer
     *  writes it (`meta.condition` of the edge). */
    export const TRANSITION_CONDITION = 'wf:transitionCondition';
    /**
     * On a state: the steps of the run of states it stands for. A run of
     * states each with one way in and one way out (a sequence a program goes
     * through) is drawn as one state that lists the actions taken along it,
     * in order (`automaton-compress.ts`); each step is `{ action, count }`,
     * `count` the times the action is taken in a row.
     */
    export const STATE_STEPS = 'wf:stateSteps';
    /** On a state that stands for a run: the names of the states it folds, in order. */
    export const STATE_FOLDED = 'wf:stateFolded';
    /**
     * On a transition into a state entered from many: it is drawn as a short
     * arrow at its source towards that state, ending in the state's name,
     * not as a curve across the drawing (`automaton-compress.ts`).
     */
    export const TRANSITION_STUB = 'wf:transitionStub';
    /**
     * On a state that folds a run, and on the first state of a run the reader
     * unfolded: the run's id, under which the choice is kept in the layout
     * file (`ToggleNodeOpenOperation`). The state draws the toggle: `+`
     * unfolds the run, `−` folds it again.
     */
    export const STATE_RUN = 'wf:stateRun';
    /** On the first state of an unfolded run (`STATE_RUN`): the run is open. */
    export const STATE_RUN_OPEN = 'wf:stateRunOpen';
}

/**
 * Type guards for diagram element types
 */
export namespace WorkflowDiagramTypeGuards {
    /** Check if element is read-only (a derived element, or one the producer marked so) */
    export function isReadOnlyElement(type: string, args?: Record<string, unknown>): boolean {
        return args?.[WorkflowDiagramMetadata.IS_READ_ONLY] === true 
            || args?.[WorkflowDiagramMetadata.IS_VIRTUAL] === true;
    }
}
