/**
 * CAL ELK Layout Engine - Minimal Extension
 * 
 * Extends the standard GlspElkLayoutEngine with only essential customizations:
 * 1. Error resilience: Skip edges with missing endpoints during live editing
 * 2. Auto-sizing: Let ELK compute sizes for compound container nodes
 * 3. Graph direction: Ensure LEFT-TO-RIGHT layout
 * 4. Port labels: Handled by ELK as true port labels (labels on ports)
 * 
 * All layout options are configured via WorkflowLayoutConfigurator (single source of truth).
 */

import { ActionDispatcher, GEdge, GGraph, GLabel, GModelElement, GNode, GPort, GShapeElement, ModelState, Point, findParentByClass } from '@eclipse-glsp/server';
import { StatusAction } from '@eclipse-glsp/protocol';
import { GlspElkLayoutEngine, ElkFactory, ElementFilter, LayoutConfigurator } from '@eclipse-glsp/layout-elk';
import { ElkExtendedEdge, ElkNode, ElkPort, ElkShape } from 'elkjs';
import { injectable } from 'inversify';
import { WorkflowDiagramTypes, WORKFLOW_LAYOUT_PERSISTENCE_KEY } from '@dialogram/shared';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, portSide, type PortSide } from '@dialogram/shared';

/** Which side of its node a GPort sits on: the producer's placement, else its direction or type. */
function gportSide(port: GPort): PortSide {
    const args = (port.args ?? {}) as Record<string, unknown>;
    return portSide({
        absolute: { x: 0, y: 0 },
        direction: args[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
        side: args[WorkflowDiagramMetadata.PORT_SIDE] as string | undefined,
        type: port.type
    });
}
import { snapRouteEndpoints } from '../routing/persisted-edge-routes';
import { FAST_LAYOUT_OPTIONS, countLayoutElements, layoutTierFor, type LayoutGraphSize, type LayoutTier } from './layout-configurator';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

/** Graph layout option: `free` lets a layout choose each node's port order against crossings. */
export const PORT_ORDER_OPTION = 'dialogram.portOrder';
export const PORT_ORDER_FREE = 'free';
/** The ports in the order the source declares them, what every value but `free` means. */
export const PORT_ORDER_DECLARED = 'declared';
/** On a port the Free Ports pass has moved: the row the server gave it from the declaration. */
export const DECLARED_ROW_ARG = 'wf:declaredRowY';

/**
 * `elk.layered.priority.direction` of a wire that goes with the flow, in a
 * diagram that has return wires. A handshake's `ready` answers backwards: it
 * leaves an instance on the west, beside the `valid` it answers, and enters
 * the queue on the east, so ELK sees a cycle for every channel and lays one
 * of its wires against the flow. Its greedy cycle breaker counts wires, and a
 * queue drives more than it takes (data, valid, size, ready, space against
 * data, valid, ready), so every queue became a source and every actor a sink:
 * a pipeline came out as a column of queues beside a column of actors. With
 * the data wires at this priority and the return wires at zero, the return
 * wires are the ones laid backwards; a real feedback loop still reverses a
 * data wire, as it must. Measured on a ten-queue, six-actor netlist: two
 * layers at priority 2 and below, eight from 5 up. A diagram without return
 * wires gets no priority at all, so its layout is exactly what it was.
 */
export const FLOW_PRIORITY = '10';

/**
 * Minimal CAL extension of the standard GLSP ELK layout engine.
 * 
 * Key design decisions based on ELK/GLSP best practices:
 * - Port labels are modeled as children of ports so ELK can place them via
 *   `elk.portLabels.*` options.
 * - Ports use FIXED_SIDE constraint so ELK respects input/output sides while
 *   allowing vertical repositioning.
 */
@injectable()
export class WorkflowElkLayoutEngine extends GlspElkLayoutEngine {

    private readonly debugElkLevel: number = Number(process.env.WORKFLOW_DIAGRAM_DEBUG_ELK ?? '0') || 0;
    private debugDumped: boolean = false;
    private elkInputDumped: boolean = false;
    /** Whether the graph being transformed has a wire that leaves a west port or enters an east port. */
    private hasReturnWires: boolean = false;

    constructor(
        elkFactory: ElkFactory,
        filter: ElementFilter,
        configurator: LayoutConfigurator,
        modelState: ModelState,
        /** Where the fast tier's status message goes; a test may leave it out. */
        private readonly actionDispatcher?: ActionDispatcher
    ) {
        super(elkFactory, filter, configurator, modelState);
    }

    /**
     * The tier the graph lays out in (see the presets in layout-configurator.ts),
     * decided by its node and edge counts alone. Counted on each call: a few
     * thousand elements take microseconds, and the graph changes between layouts.
     */
    private tierOf(root: GModelElement): { size: LayoutGraphSize; tier: LayoutTier } {
        const size = countLayoutElements(root);
        return { size, tier: layoutTierFor(size) };
    }

    /** The network the perf lines name, or the graph's id where no layout meta is set. */
    private networkName(root: GGraph): string {
        const meta = typeof (this.modelState as any).get === 'function'
            ? ((this.modelState as any).get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as { networkId?: string } | undefined)
            : undefined;
        return meta?.networkId ?? root.id;
    }

    private stringifyLayoutOptions(input: Record<string, unknown> | undefined): Record<string, string> | undefined {
        if (!input || typeof input !== 'object') {
            return undefined;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(input)) {
            if (k.startsWith('dialogram.')) {
                continue; // the server's own options, see PORT_ORDER_OPTION
            }
            if (typeof v === 'string') {
                out[k] = v;
            } else if (typeof v === 'number' || typeof v === 'boolean') {
                out[k] = String(v);
            } else {
                // ELK JSON importer in GLSP expects layoutOptions to be string-valued.
                // Skip objects/arrays to avoid crashing the importer.
            }
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }

    /**
     * Dump the ELK input graph to JSON so we can inspect exactly what we send to elkjs.
     *
     * Enable with:
     * - WORKFLOW_DIAGRAM_DUMP_ELK_INPUT_JSON=1
     * Optional:
     * - WORKFLOW_DIAGRAM_DUMP_ELK_DIR=/path/to/dir
     * - WORKFLOW_DIAGRAM_DUMP_ELK_INPUT_JSON_ALWAYS=1
     */
    override layout(operation?: any): any {
        const root = this.modelState.root;
        if (!(root instanceof GGraph)) {
            return root;
        }
        const run = async (): Promise<GGraph> => {
            // Always-on breadcrumb beside the `elk=` timing the submission handler
            // prints: which preset this layout ran with, and why.
            const { size, tier } = this.tierOf(root);
            // eslint-disable-next-line no-console
            console.log(`[dialogram perf] layout ${this.networkName(root)}: tier=${tier} nodes=${size.nodes} edges=${size.edges}`);

            // Ports sit on a fixed grid in the order the source declares them, and
            // ELK may not move them (FIXED_POS, see applyShape). On a dense graph that
            // order is what tangles the edges: an input declared first whose producer
            // is laid out last crosses every edge between. The Free Ports layout asks
            // for the order to be chosen first, by a probe layout in which ELK is free
            // to arrange each side's ports against crossings; the ports are then put
            // back on their grid in that order, and the real layout runs as before.
            if (this.portOrderingEnabled(root)) {
                try {
                    await this.orderPortsAgainstCrossings(root);
                } catch (e) {
                    console.warn('[cal-elk] port ordering skipped:', e);
                }
            } else {
                // A layout that does not ask for the pass lays the ports out as the
                // source declares them, even after a Free Ports layout moved them.
                this.restoreDeclaredRows(root);
            }

            // Re-implement base `layout` so we can dump the exact object passed to elk.layout().
            (this as any).elkEdges = [];
            (this as any).idToElkElement = new Map();
            const elkGraph = (this as any).transformToElk(root) as ElkNode;

            const shouldDump = process.env.WORKFLOW_DIAGRAM_DUMP_ELK_INPUT_JSON === '1';
            const always = process.env.WORKFLOW_DIAGRAM_DUMP_ELK_INPUT_JSON_ALWAYS === '1';
            if (shouldDump && (always || !this.elkInputDumped)) {
                this.elkInputDumped = true;
                void this.dumpElkInputGraph(elkGraph);
            }

            const result = (await (this as any).elk.layout(elkGraph)) as ElkNode;
            this.applyLayout(result);

            // The fast tier skips crossing minimisation: say so in the diagram's
            // status line, since the result looks nothing like a usual layout.
            if (tier === 'fast' && this.actionDispatcher) {
                const message = `${size.nodes} nodes: laid out roughly. Run Layout for the full layout.`;
                void Promise.resolve(this.actionDispatcher.dispatch(StatusAction.create(message, { severity: 'INFO', timeout: 10000 })))
                    .catch(e => console.warn('[cal-elk] layout status not shown:', e));
            }
            return root;
        };
        return run();
    }

    /**
     * The pass runs only when a layout asks for it with the graph option
     * `dialogram.portOrder: free` (the Free Ports layout), and only for a layered
     * layout: by default, and after a drag, the ports keep the order the source
     * declares them in.
     */
    private portOrderingEnabled(root: GGraph): boolean {
        const options = (root as any).layoutOptions as Record<string, unknown> | undefined;
        if (options?.[PORT_ORDER_OPTION] !== PORT_ORDER_FREE) {
            return false;
        }
        const algorithm = options?.['elk.algorithm'];
        return algorithm === undefined || algorithm === 'layered';
    }

    /**
     * A node whose ports may change order: every ordinary node. The if and loop
     * containers place their branch ports by index, and a boundary node has one.
     */
    private portsMayReorder(node: GNode): boolean {
        return node.type !== WorkflowDiagramTypes.NODE_STRUCTURE_IF
            && node.type !== WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH
            && node.type !== WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH
            && node.type !== WorkflowDiagramTypes.NODE_BOUNDARY_INPUT
            && node.type !== WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
    }

    /**
     * The probe: the same graph with `FIXED_SIDE` on every ordinary node, so that
     * ELK's crossing minimisation orders the ports of each side. Nothing of its
     * result is kept but that order, which `regridPorts` writes back onto the
     * server's rows.
     */
    private async orderPortsAgainstCrossings(root: GGraph): Promise<void> {
        (this as any).elkEdges = [];
        (this as any).idToElkElement = new Map();
        const probe = (this as any).transformToElk(root) as ElkNode;
        const free = (n: ElkNode): void => {
            for (const child of n.children ?? []) {
                const el = this.modelState.index.get(child.id);
                if (el instanceof GNode && this.portsMayReorder(el)) {
                    child.layoutOptions = { ...(child.layoutOptions ?? {}), 'elk.portConstraints': 'FIXED_SIDE' };
                    for (const p of child.ports ?? []) {
                        if (p.layoutOptions && 'elk.port.index' in p.layoutOptions) {
                            const { ['elk.port.index']: _index, ...rest } = p.layoutOptions as Record<string, string>;
                            p.layoutOptions = rest;
                        }
                    }
                }
                free(child);
            }
        };
        free(probe);
        const result = (await (this as any).elk.layout(probe)) as ElkNode;
        const apply = (n: ElkNode): void => {
            for (const child of n.children ?? []) {
                const el = this.modelState.index.get(child.id);
                if (el instanceof GNode && this.portsMayReorder(el) && child.ports && child.ports.length > 1) {
                    this.regridPorts(el, child.ports);
                }
                apply(child);
            }
        };
        apply(result);
    }

    /**
     * The node's ports of one side take the rows they already occupy, in the
     * order ELK placed them top to bottom. The labels are the ports' children and
     * move with them; nothing else about the node changes.
     */
    private regridPorts(node: GNode, elkPorts: ElkPort[]): void {
        for (const side of ['WEST', 'EAST'] as const) {
            const ports = this.findChildren(node, GPort).filter(p => gportSide(p) === side);
            if (ports.length < 2) {
                continue;
            }
            const rows = ports.map(p => p.position?.y ?? 0).sort((a, b) => a - b);
            const byId = new Map(ports.map(p => [p.id, p] as const));
            const order = elkPorts.filter(ep => byId.has(ep.id)).sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
            if (order.length !== ports.length) {
                continue;
            }
            order.forEach((ep, k) => {
                const port = byId.get(ep.id)!;
                const args = (port.args ?? {}) as Record<string, unknown>;
                if (args[DECLARED_ROW_ARG] === undefined) {
                    port.args = { ...args, [DECLARED_ROW_ARG]: port.position?.y ?? 0 };
                }
                port.position = { x: port.position?.x ?? 0, y: rows[k] };
            });
        }
    }

    /** Every port the pass has moved goes back on its declared row. */
    private restoreDeclaredRows(root: GGraph): void {
        const visit = (element: GModelElement): void => {
            if (element instanceof GPort) {
                const row = (element.args as Record<string, unknown> | undefined)?.[DECLARED_ROW_ARG];
                if (typeof row === 'number') {
                    element.position = { x: element.position?.x ?? 0, y: row };
                }
            }
            for (const child of element.children ?? []) {
                visit(child);
            }
        };
        visit(root);
    }

    private async dumpElkInputGraph(elkGraph: ElkNode): Promise<void> {
        try {
            const dumpDir = process.env.WORKFLOW_DIAGRAM_DUMP_ELK_DIR
                ? path.resolve(process.env.WORKFLOW_DIAGRAM_DUMP_ELK_DIR)
                : path.join(os.tmpdir(), 'cal-elk-dump');
            await mkdir(dumpDir, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(dumpDir, `elk-input-${process.pid}-${ts}.json`);
            await writeFile(filePath, JSON.stringify(elkGraph, null, 2), 'utf8');
            console.info('[cal-elk-debug] wrote ELK input JSON:', filePath);
        } catch (e) {
            console.warn('[cal-elk-debug] failed to write ELK input JSON', e);
        }
    }

    /**
     * Override transformGraph to ensure our layout options are applied.
     * Layout options come from WorkflowLayoutConfigurator - we only add direction propagation here.
     */
    protected override transformGraph(graph: GGraph): ElkNode {
        this.hasReturnWires = this.findChildren(graph, GEdge).some(edge => this.isReturnWire(edge));
        const elkGraph = super.transformGraph(graph) as ElkNode;

        // Forward any runtime-injected layoutOptions (e.g. interactive reroute tweaks).
        // The base engine primarily uses the LayoutConfigurator; we additionally merge
        // `graph.layoutOptions` so operations can temporarily override behavior.
        const graphLayoutOptions = this.stringifyLayoutOptions((graph as any)?.layoutOptions as Record<string, unknown> | undefined);
        if (graphLayoutOptions) {
            elkGraph.layoutOptions = {
                ...(elkGraph.layoutOptions ?? {}),
                ...graphLayoutOptions
            };
            // In the fast tier the preset wins over what a layout set on the
            // graph (Untangled's Brandes-Koepf placement, say): the options it
            // replaces are the ones that take minutes or crash on such a graph.
            if (elkGraph.layoutOptions['elk.algorithm'] === 'layered' && this.tierOf(graph).tier === 'fast') {
                elkGraph.layoutOptions = { ...elkGraph.layoutOptions, ...FAST_LAYOUT_OPTIONS };
            }
        }
        
        // Apply direction to all child nodes to ensure nested hierarchies use RIGHT
        this.applyDirectionToChildren(elkGraph);
        
        return elkGraph;
    }
    
    /**
     * Recursively apply RIGHT direction to all nodes in the hierarchy.
     */
    private applyDirectionToChildren(node: ElkNode): void {
        if (node.children) {
            for (const child of node.children) {
                child.layoutOptions = {
                    ...child.layoutOptions,
                    'elk.direction': 'RIGHT'
                };
                this.applyDirectionToChildren(child);
            }
        }
    }

    /**
     * Override transformNode to keep the ELK graph compact and deterministic.
     *
     * Port labels are now attached to ports, so we don't need any special handling here.
     */
    protected override transformNode(node: GNode): ElkNode {
        const elkNode: ElkNode = {
            id: node.id,
            layoutOptions: this.configurator.apply(node)
        };

        // Forward runtime-injected node.layoutOptions (e.g. position hints).
        const nodeLayoutOptions = this.stringifyLayoutOptions((node as any)?.layoutOptions as Record<string, unknown> | undefined);
        if (nodeLayoutOptions) {
            elkNode.layoutOptions = {
                ...(elkNode.layoutOptions ?? {}),
                ...nodeLayoutOptions
            };
        }

        // Most CAL nodes are rendered as "compound" in the GModel only because they
        // contain cosmetic compartments (header/ports rows). Forwarding those child nodes
        // into ELK makes the node a compound node, which changes ELK's port-label behavior
        // (e.g. disables NEXT_TO_PORT placement for compound connections).
        //
        // Only forward true container hierarchies (e.g. if/foreach structures) to ELK.
        if (node.children && this.isAutoSizedContainer(node)) {
            elkNode.children = this.findChildren(node, GNode).map(child => (this as any).transformToElk(child));
            elkNode.edges = [];
            (this as any).elkEdges.push(...this.findChildren(node, GEdge).map(child => (this as any).transformToElk(child)));
        }

        // Ports are always forwarded so ELK can route edges and place port labels.
        elkNode.ports = this.findChildren(node, GPort).map(child => (this as any).transformToElk(child));

        // Node labels are not required for Workflow layout (sizes are server-provided), but
        // forwarding them is harmless and can help with debugging.
        elkNode.labels = this.findChildren(node, GLabel).map(child => (this as any).transformToElk(child));

        (this as any).transformShape(elkNode, node);
        (this as any).idToElkElement.set(node.id, elkNode);

        return elkNode;
    }

    /**
     * Ensure port labels (GLabel children of GPort) are forwarded to ELK as real port labels.
     * Without this, ELK will not compute `elkPort.labels[*].x/y` and placement options like
     * `elk.portLabels.*` won't have any effect.
     */
    protected override transformPort(port: GPort): ElkPort {
        const elkPort = super.transformPort(port) as unknown as ElkPort;
        if (port.children) {
            const labels = this.findChildren(port, GLabel).map(child => (this as any).transformToElk(child));
            if (labels.length > 0) {
                // Important: when port labels were previously modeled as node children,
                // they may still carry stale coordinates. If we forward those into ELK,
                // they can bias placement or appear to be "double-offset" after we
                // re-parent labels under ports.
                //
                // For port labels we want ELK to be the single source of truth for x/y.
                for (const l of labels as any[]) {
                    // Keep width/height (needed for placement), but drop any existing x/y.
                    delete l.x;
                    delete l.y;
                }
                (elkPort as any).labels = labels;
            }
        }
        return elkPort;
    }

    /**
     * Override findCommonAncestor to properly find the lowest common ancestor.
     * The base class only handles trivial cases and returns undefined for sibling nodes,
     * which causes edges to not be added to the ELK graph.
     */
    protected override findCommonAncestor(elkEdge: ElkExtendedEdge): ElkNode | undefined {
        if (elkEdge.sources.length === 0 || elkEdge.targets.length === 0) {
            return undefined;
        }

        const source = this.modelState.index.get(elkEdge.sources[0]);
        const target = this.modelState.index.get(elkEdge.targets[0]);
        if (!source || !target) {
            return undefined;
        }

        // Find the parent node (not port) for source
        const sourceNode = source instanceof GNode ? source : this.findParentNode(source);
        const targetNode = target instanceof GNode ? target : this.findParentNode(target);

        if (!sourceNode || !targetNode) {
            return undefined;
        }

        // Collect ancestors of source node
        const sourceAncestors = this.collectAncestors(sourceNode);
        const sourceIds = new Set(sourceAncestors.map(a => a.id));

        // Collect ancestors of target node and find first common one
        const targetAncestors = this.collectAncestors(targetNode);
        for (const ancestor of targetAncestors) {
            if (sourceIds.has(ancestor.id)) {
                const elkElement = (this as any).idToElkElement.get(ancestor.id);
                return this.readyToHoldEdges(elkElement as ElkNode | undefined);
            }
        }

        // Fallback: find the graph root
        const graph = this.findParentGraph(sourceNode);
        return graph
            ? this.readyToHoldEdges((this as any).idToElkElement.get(graph.id) as ElkNode)
            : undefined;
    }

    /**
     * The caller pushes an edge into whatever this returns, so it has to have
     * somewhere to put it.
     *
     * Only the graph is built with an `edges` array; a transformed node gets
     * `children` and `ports` and nothing else. That is fine while every edge
     * belongs to the graph, and it is not the moment an edge belongs to a node
     * — an edge whose endpoints are ports of the SAME node, which is what a
     * feedback edge is. Then the ancestor found above is that node, and pushing
     * into it threw `Cannot read properties of undefined (reading 'push')`,
     * taking the whole layout with it. A compound node's inner edge lands here
     * for the same reason.
     */
    private readyToHoldEdges(elkNode: ElkNode | undefined): ElkNode | undefined {
        if (elkNode && !elkNode.edges) {
            elkNode.edges = [];
        }
        return elkNode;
    }

    private findParentNode(element: GModelElement): GNode | undefined {
        let current: GModelElement | undefined = element;
        while (current) {
            if (current instanceof GNode) {
                return current;
            }
            current = (current as any).parent;
        }
        return undefined;
    }

    private findParentGraph(element: GModelElement): GGraph | undefined {
        let current: GModelElement | undefined = element;
        while (current) {
            if (current instanceof GGraph) {
                return current;
            }
            current = (current as any).parent;
        }
        return undefined;
    }

    private collectAncestors(node: GNode): Array<GNode | GGraph> {
        const ancestors: Array<GNode | GGraph> = [node];
        let current: GModelElement | undefined = node;
        while (current) {
            const parent: GModelElement | undefined = (current as any).parent;
            if (!parent) break;
            if (parent instanceof GNode || parent instanceof GGraph) {
                ancestors.push(parent);
            }
            current = parent;
        }
        return ancestors;
    }

    /**
     * Skip edges with missing endpoints instead of crashing.
     * This can happen during live editing when model is transiently inconsistent.
     */
    protected override transformEdge(edge: GEdge): ElkExtendedEdge {
        try {
            const source = this.modelState.index.get(edge.sourceId);
            const target = this.modelState.index.get(edge.targetId);
            if (!source || !target) {
                console.warn('[cal-elk] Skipping edge with missing endpoint(s):', edge.id);
                return { id: edge.id, sources: [], targets: [] };
            }
        } catch {
            // Index.get() can throw if element doesn't exist
            console.warn('[cal-elk] Skipping edge with missing endpoint(s):', edge.id);
            return { id: edge.id, sources: [], targets: [] };
        }
        const elkEdge = super.transformEdge(edge);

        // In a diagram with return wires, tell ELK which wires go with the flow
        // (see FLOW_PRIORITY); the return wires are the ones to lay backwards.
        if (this.hasReturnWires) {
            (elkEdge as any).layoutOptions = {
                ...(((elkEdge as any).layoutOptions ?? {}) as Record<string, string>),
                'elk.layered.priority.direction': this.isReturnWire(edge) ? '0' : FLOW_PRIORITY
            };
        }

        // Forward runtime-injected edge.layoutOptions if present.
        const edgeLayoutOptions = this.stringifyLayoutOptions((edge as any)?.layoutOptions as Record<string, unknown> | undefined);
        if (edgeLayoutOptions) {
            (elkEdge as any).layoutOptions = {
                ...(((elkEdge as any).layoutOptions ?? {}) as Record<string, string>),
                ...edgeLayoutOptions
            };
        }

        return elkEdge;
    }

    /**
     * A wire drawn against the flow: it leaves a port its producer put on the
     * west, or enters one put on the east. A handshake's `ready` is one; so is
     * a wire from a boundary input placed in the east margin.
     */
    private isReturnWire(edge: GEdge): boolean {
        let source: GModelElement | undefined;
        let target: GModelElement | undefined;
        try {
            source = this.modelState.index.get(edge.sourceId);
            target = this.modelState.index.get(edge.targetId);
        } catch {
            return false;
        }
        return (source instanceof GPort && gportSide(source) === 'WEST')
            || (target instanceof GPort && gportSide(target) === 'EAST');
    }

    /**
     * For compound containers, accept ELK's computed size.
     * For boundary nodes, only apply position — never change their size.
     * For normal nodes, preserve server-provided sizes.
     */
    protected override applyShape(shape: GShapeElement, elkShape: ElkShape): void {
        // Ports are placed by the server and every node type declares `elk.portConstraints:
        // FIXED_POS`, so ELK is not meant to move them — but it does not hand them back
        // untouched. ELK re-centres a port on a whole-pixel routing lane, so a port whose height
        // is odd (PORT_HEIGHT_PX is 7: centre 30 + 3.5 = 33.5, snapped to 34) returns half a
        // pixel below where it was placed. Writing that back makes a freshly laid-out diagram sit
        // 0.5px off every later open of the same layout, since a reopen skips ELK and re-places
        // the ports at the server coordinates — a visible twitch on each reload.
        //
        // So port geometry is never taken from ELK. Edge endpoints are snapped to the server
        // anchors instead (see applyEdgeWithOffset), which keeps edges attached without letting
        // ELK's rounding leak into the model. Port LABELS are unaffected: applyLayoutWithOffset
        // applies those from `elkPort.labels` separately.
        if (shape instanceof GPort) {
            return;
        }

        // Boundary nodes have a fixed-position port whose x-coordinate equals the node
        // width (right edge for inputs, or a negative offset for outputs).  If ELK were
        // allowed to recompute a smaller width the port would land outside the visual
        // rectangle, breaking edge anchoring and producing backwards / looping routes.
        // We apply only position here and restore the original size afterwards.
        if (shape instanceof GNode) {
            const nodeType = shape.type;
            if (nodeType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ||
                nodeType === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
                const savedSize = shape.size ? { ...shape.size } : undefined;
                super.applyShape(shape, elkShape);
                if (savedSize) {
                    shape.size = savedSize;
                }
                return;
            }
        }

        super.applyShape(shape, elkShape);
        
        // Compound containers must expand to fit children
        if (shape instanceof GNode && this.isAutoSizedContainer(shape)) {
            if (elkShape.width !== undefined && elkShape.height !== undefined) {
                shape.size = { width: elkShape.width, height: elkShape.height };
            }
        }
    }

    /**
     * Nodes that should have their size computed by ELK based on children.
     */
    private isAutoSizedContainer(node: GNode): boolean {
        return node.type === WorkflowDiagramTypes.NODE_STRUCTURE_IF
            || node.type === WorkflowDiagramTypes.NODE_STRUCTURE_IF_BRANCH
            || node.type === WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH;
    }

    /**
     * Track offsets during layout application for edge coordinate translation.
     * Maps ELK node ID -> absolute offset from graph root.
     */
    private nodeOffsets: Map<string, Point> = new Map();

    /**
     * Override applyLayout to track coordinate offsets for edge routing.
     */
    protected override applyLayout(elkNode: ElkNode): void {
        if (this.debugElkLevel >= 1 && (!this.debugDumped || this.debugElkLevel >= 2)) {
            this.debugDumped = true;
            const stats = this.collectPortLabelStats(elkNode, this.debugElkLevel >= 2 ? 200 : 25);
            const rootOpts = elkNode.layoutOptions ?? {};
            const placement = (rootOpts as any)['elk.portLabels.placement'] ?? (rootOpts as any)['org.eclipse.elk.portLabels.placement'];
            const treatAsGroup = (rootOpts as any)['elk.portLabels.treatAsGroup'] ?? (rootOpts as any)['org.eclipse.elk.portLabels.treatAsGroup'];

            console.info('[cal-elk-debug] applyLayout()', {
                rootPortLabelPlacement: placement,
                rootPortLabelTreatAsGroup: treatAsGroup,
                portsTotal: stats.portsTotal,
                portsWithLabels: stats.portsWithLabels,
                portLabelsTotal: stats.portLabelsTotal,
                samples: stats.samples,
                unlabeledPorts: stats.unlabeledPorts
            });
        }
        // Clear offsets for fresh layout
        this.nodeOffsets.clear();
        // Apply layout with offset tracking
        this.applyLayoutWithOffset(elkNode, { x: 0, y: 0 });
    }

    private collectPortLabelStats(
        elkNode: ElkNode,
        sampleLimit: number
    ): {
        portsTotal: number;
        portsWithLabels: number;
        portLabelsTotal: number;
        samples: Array<{ portId: string; labelId: string; x?: number; y?: number; width?: number; height?: number }>;
        unlabeledPorts: Array<{ portId: string; direction?: string; parentNodeType?: string; parentNodeId?: string }>;
    } {
        const samples: Array<{ portId: string; labelId: string; x?: number; y?: number; width?: number; height?: number }> = [];
        const unlabeledPorts: Array<{ portId: string; direction?: string; parentNodeType?: string; parentNodeId?: string }> = [];
        let portsTotal = 0;
        let portsWithLabels = 0;
        let portLabelsTotal = 0;

        const visit = (n: ElkNode): void => {
            if (n.ports) {
                for (const p of n.ports) {
                    portsTotal += 1;
                    const labels = (p as any).labels as ElkShape[] | undefined;
                    if (labels && labels.length > 0) {
                        portsWithLabels += 1;
                        portLabelsTotal += labels.length;
                        for (const l of labels) {
                            if (samples.length >= sampleLimit) {
                                break;
                            }
                            samples.push({
                                portId: p.id,
                                labelId: (l as any).id,
                                x: (l as any).x,
                                y: (l as any).y,
                                width: (l as any).width,
                                height: (l as any).height
                            });
                        }
                    }
                    if ((!labels || labels.length === 0) && unlabeledPorts.length < 25) {
                        try {
                            const portEl = this.modelState.index.get(p.id);
                            if (portEl && portEl instanceof GPort) {
                                const parentNode = findParentByClass(portEl, GNode);
                                unlabeledPorts.push({
                                    portId: p.id,
                                    direction: (portEl as any).args?.['cal:portDirection'] as string | undefined,
                                    parentNodeType: parentNode?.type,
                                    parentNodeId: parentNode?.id
                                });
                            } else {
                                unlabeledPorts.push({ portId: p.id });
                            }
                        } catch {
                            unlabeledPorts.push({ portId: p.id });
                        }
                    }
                    if (samples.length >= sampleLimit) {
                        break;
                    }
                }
            }
            if (samples.length >= sampleLimit) {
                return;
            }
            if (n.children) {
                for (const c of n.children) {
                    visit(c);
                    if (samples.length >= sampleLimit) {
                        break;
                    }
                }
            }
        };

        visit(elkNode);
        return { portsTotal, portsWithLabels, portLabelsTotal, samples, unlabeledPorts };
    }

    /**
     * Apply layout recursively while tracking absolute offsets.
     */
    private applyLayoutWithOffset(elkNode: ElkNode, offset: Point): void {
        const element = this.modelState.index.get(elkNode.id);
        if (!element) {
            return;
        }

        if (element instanceof GNode) {
            (this as any).applyShape(element, elkNode);
        }

        // Apply port positions returned by ELK
        if (elkNode.ports) {
            for (const elkPort of elkNode.ports) {
                try {
                    const portEl = this.modelState.index.get(elkPort.id);
                    if (portEl instanceof GPort) {
                        (this as any).applyShape(portEl, elkPort);

                        // Apply port label positions/sizes returned by ELK.
                        // Port labels are represented as GLabel children of GPort in the GModel.
                        const elkPortLabels = (elkPort as any).labels as ElkShape[] | undefined;
                        if (elkPortLabels) {
                            for (const elkLabel of elkPortLabels) {
                                try {
                                    const labelEl = this.modelState.index.get((elkLabel as any).id);
                                    if (labelEl instanceof GLabel) {
                                        // DEBUG: Log ELK's label positions for ports
                                        const portDirection = (portEl as any).args?.['cal:portDirection'];
                                        /*
                                        console.log('[ELK-DEBUG] Port label position from ELK:', {
                                            portId: elkPort.id,
                                            portDirection,
                                            portX: elkPort.x,
                                            portY: elkPort.y,
                                            portW: elkPort.width,
                                            portH: elkPort.height,
                                            labelId: (elkLabel as any).id,
                                            labelX: elkLabel.x,
                                            labelY: elkLabel.y,
                                            labelW: elkLabel.width,
                                            labelH: elkLabel.height,
                                            labelText: (labelEl as any).text
                                        });*/
                                        (this as any).applyShape(labelEl, elkLabel);
                                    }
                                } catch {
                                    // Label not found, skip
                                }
                            }
                        }
                    }
                } catch {
                    // Port not found, skip
                }
            }
        }

        // Apply node label positions/sizes returned by ELK.
        if ((elkNode as any).labels) {
            const elkNodeLabels = (elkNode as any).labels as ElkShape[];
            for (const elkLabel of elkNodeLabels) {
                try {
                    const labelEl = this.modelState.index.get((elkLabel as any).id);
                    if (labelEl instanceof GLabel) {
                        (this as any).applyShape(labelEl, elkLabel);
                    }
                } catch {
                    // Label not found, skip
                }
            }
        }

        // Accumulate offset for this node
        const selfOffset: Point = {
            x: offset.x + (elkNode.x ?? 0),
            y: offset.y + (elkNode.y ?? 0)
        };

        // Store offset for edge routing
        this.nodeOffsets.set(elkNode.id, selfOffset);

        // Recursively apply to children
        if (elkNode.children) {
            for (const child of elkNode.children) {
                this.applyLayoutWithOffset(child, selfOffset);
            }
        }

        // Apply edges with offset for proper coordinate translation
        if (elkNode.edges) {
            for (const elkEdge of elkNode.edges) {
                try {
                    const edge = this.modelState.index.get(elkEdge.id);
                    if (edge instanceof GEdge) {
                        this.applyEdgeWithOffset(edge, elkEdge, selfOffset);
                    }
                } catch {
                    // Edge not found, skip
                }
            }
        }
    }

    /**
     * Apply edge routing with coordinate translation for hierarchical layouts.
     * 
     * ELK returns edge routing coordinates relative to the edge's container node.
     * For hierarchical layouts with INCLUDE_CHILDREN, we need to choose the correct
     * coordinate interpretation based on which one best matches actual port anchors.
     */
    private applyEdgeWithOffset(edge: GEdge, elkEdge: ElkExtendedEdge, offset: Point): void {
        const rawPoints: Point[] = [];
        if (elkEdge.sections && elkEdge.sections.length > 0) {
            const section = elkEdge.sections[0];
            if (section.startPoint) {
                rawPoints.push({ x: section.startPoint.x, y: section.startPoint.y });
            }
            if (section.bendPoints) {
                rawPoints.push(...section.bendPoints.map(p => ({ x: p.x, y: p.y })));
            }
            if (section.endPoint) {
                rawPoints.push({ x: section.endPoint.x, y: section.endPoint.y });
            }
        }

        // Translated points (container-relative -> graph-absolute)
        const translatedPoints = rawPoints.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));

        // Compute port anchor positions in absolute coordinates
        const srcAnchor = this.portAnchorAbsolute(edge.sourceId);
        const tgtAnchor = this.portAnchorAbsolute(edge.targetId);

        // Score function: sum of distances from start/end points to expected port anchors
        const score = (pts: Point[]): number | undefined => {
            if (!srcAnchor || !tgtAnchor || pts.length < 2) {
                return undefined;
            }
            const start = pts[0];
            const end = pts[pts.length - 1];
            return this.pointDistance(start, srcAnchor) + this.pointDistance(end, tgtAnchor);
        };

        const rawScore = score(rawPoints);
        const translatedScore = score(translatedPoints);

        // Choose the interpretation that best matches port anchors
        const useTranslated = translatedScore !== undefined
            ? (rawScore === undefined ? true : translatedScore <= rawScore)
            : false;

        const chosen = useTranslated ? translatedPoints : rawPoints;
        // ELK routes from its own (re-centred) port coordinates, which we deliberately do not
        // write into the model — see applyShape. Pin the endpoints back onto the server's port
        // anchors so the edge attaches exactly, carrying the adjacent bend so the leading and
        // trailing segments stay orthogonal.
        const full = srcAnchor && tgtAnchor && chosen.length >= 2
            ? snapRouteEndpoints(chosen, srcAnchor, tgtAnchor)
            : chosen;
        if (full.length >= 2) {
            edge.routingPoints = full;
        } else if (Array.isArray(edge.routingPoints) && edge.routingPoints.length === 0) {
            delete (edge as any).routingPoints;
        }
    }

    /**
     * Compute absolute anchor position for a port (where edge should connect).
     */
    private portAnchorAbsolute(portId: string): Point | undefined {
        let port: GModelElement | undefined;
        try {
            port = this.modelState.index.get(portId);
        } catch {
            return undefined;
        }
        if (!(port instanceof GPort)) {
            return undefined;
        }
        const node = findParentByClass(port, GNode);
        if (!node) {
            return undefined;
        }

        const nodePos = this.absolutePosition(node);
        const portPos = port.position ?? { x: 0, y: 0 };
        const fallbackPortWidth = WorkflowDiagramConstants.PORT_WIDTH_PX;
        const fallbackPortHeight = WorkflowDiagramConstants.PORT_HEIGHT_PX;
        const w = (port.size?.width && port.size.width > 0) ? port.size.width : fallbackPortWidth;
        const h = (port.size?.height && port.size.height > 0) ? port.size.height : fallbackPortHeight;

        // Determine port side: the producer's placement, else direction or type
        const side = gportSide(port);

        const absPortX = nodePos.x + portPos.x;
        const absPortY = nodePos.y + portPos.y;
        const cx = absPortX + w / 2;
        const cy = absPortY + h / 2;

        // Return anchor point on port boundary based on side
        switch (side.toUpperCase()) {
            case 'WEST': return { x: absPortX, y: cy };
            case 'EAST': return { x: absPortX + w, y: cy };
            case 'NORTH': return { x: cx, y: absPortY };
            case 'SOUTH': return { x: cx, y: absPortY + h };
            default: return { x: cx, y: cy };
        }
    }

    /**
     * Compute absolute position of a node by walking up the hierarchy.
     */
    private absolutePosition(element: GModelElement): Point {
        let x = 0;
        let y = 0;
        let cur: GModelElement | undefined = element;
        while (cur) {
            if (cur instanceof GNode) {
                const p = cur.position;
                if (p) {
                    x += p.x;
                    y += p.y;
                }
            }
            const parent: GModelElement | undefined = (cur as any).parent;
            if (!parent) break;
            cur = parent;
        }
        return { x, y };
    }

    /**
     * Euclidean distance between two points.
     */
    private pointDistance(a: Point, b: Point): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
}
