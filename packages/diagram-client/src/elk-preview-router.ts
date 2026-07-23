import { GModelElement, GShapeElement, SEdgeImpl } from '@eclipse-glsp/client';
import Elk from 'elkjs/lib/elk.bundled.js';
import { WorkflowDiagramTypes } from '@dialogram/shared';

export type WorkflowPoint = { x: number; y: number };

function absPos(element: any): WorkflowPoint {
    let x = 0;
    let y = 0;
    let current = element;
    while (current) {
        if (current.position) {
            x += current.position.x || 0;
            y += current.position.y || 0;
        }
        current = current.parent;
    }
    return { x, y };
}

function getById(index: any, id: string): any | undefined {
    return (typeof index?.getById === 'function' ? index.getById(id) : undefined)
        ?? (typeof index?.get === 'function' ? index.get(id) : undefined);
}

function sizeOf(el: any): { width: number; height: number } {
    const width = el?.size?.width ?? el?.bounds?.width ?? 0;
    const height = el?.size?.height ?? el?.bounds?.height ?? 0;
    return { width: Math.max(1, width), height: Math.max(1, height) };
}

function centerOf(el: any): WorkflowPoint {
    const pos = absPos(el);
    const { width, height } = sizeOf(el);
    return { x: pos.x + width / 2, y: pos.y + height / 2 };
}

function findParentNode(el: any): any | undefined {
    let cur = el;
    while (cur) {
        const t = cur.type as string | undefined;
        if (typeof t === 'string' && t.startsWith('node:')) {
            return cur;
        }
        cur = cur.parent;
    }
    return undefined;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

function portAnchorOnParentBoundary(portEl: any): WorkflowPoint {
    const portC = centerOf(portEl);
    const parent = findParentNode(portEl);
    if (!parent) {
        return portC;
    }
    const nodePos = absPos(parent);
    const { width, height } = sizeOf(parent);
    if (width <= 1 || height <= 1) {
        return portC;
    }

    const portType = portEl?.type as string | undefined;
    const cx = nodePos.x + width / 2;
    const cy = nodePos.y + height / 2;
    const dx = portC.x - cx;
    const dy = portC.y - cy;

    // Prefer CAL conventions when available.
    if (portType === WorkflowDiagramTypes.PORT_INPUT) {
        return { x: nodePos.x, y: clamp(portC.y, nodePos.y + 1, nodePos.y + height - 1) };
    }
    if (portType === WorkflowDiagramTypes.PORT_OUTPUT) {
        return { x: nodePos.x + width, y: clamp(portC.y, nodePos.y + 1, nodePos.y + height - 1) };
    }

    // Fallback: infer nearest side.
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx <= 0
            ? { x: nodePos.x, y: clamp(portC.y, nodePos.y + 1, nodePos.y + height - 1) }
            : { x: nodePos.x + width, y: clamp(portC.y, nodePos.y + 1, nodePos.y + height - 1) };
    }
    return dy <= 0
        ? { x: clamp(portC.x, nodePos.x + 1, nodePos.x + width - 1), y: nodePos.y }
        : { x: clamp(portC.x, nodePos.x + 1, nodePos.x + width - 1), y: nodePos.y + height };
}

function serverLikeRerouteOptions(): Record<string, string> {
    // Mirror the server's conservative reroute options so preview matches mouse-up results.
    return {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.interactiveLayout': 'true',
        // Clearance.
        'elk.spacing.edgeNode': '30',
        'elk.spacing.edgeEdge': '20',
        'elk.layered.spacing.edgeNodeBetweenLayers': '30',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
        // Stability / fewer gratuitous kinks.
        'elk.layered.unnecessaryBendpoints': 'false',
        'elk.layered.mergeEdges': 'false',
        'elk.layered.mergeHierarchyEdges': 'false',
        'elk.edge.thickness': '1.5',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.crossingMinimization.semiInteractive': 'true'
    };
}

function isNodeElement(el: GModelElement): boolean {
    return typeof (el as any).type === 'string' && (el as any).type.startsWith('node:');
}

function isPortElement(el: GModelElement): boolean {
    const t = (el as any).type as string | undefined;
    return t === WorkflowDiagramTypes.PORT_INPUT || t === WorkflowDiagramTypes.PORT_OUTPUT;
}

function findParentNodeId(el: any): string | undefined {
    let cur = el;
    while (cur) {
        const t = cur.type as string | undefined;
        if (typeof t === 'string' && t.startsWith('node:') && typeof cur.id === 'string') {
            return cur.id;
        }
        cur = cur.parent;
    }
    return undefined;
}

export class WorkflowElkPreviewRouter {
    private elk = new (Elk as any)({});

    // No caching: always reroute from scratch. We only keep the *latest* result per edge.
    private inflightByEdgeId = new Map<string, Promise<void>>();
    private pendingByEdgeId = new Map<
        string,
        { root: Readonly<GModelElement>; edge: Readonly<SEdgeImpl>; start: WorkflowPoint; end: WorkflowPoint; seq: number }
    >();
    private seqByEdgeId = new Map<string, number>();
    private latestByEdgeId = new Map<string, { start: WorkflowPoint; end: WorkflowPoint; route: WorkflowPoint[]; seq: number }>();

    getLast(edgeId: string): { start: WorkflowPoint; end: WorkflowPoint; route: WorkflowPoint[] } | undefined {
        const entry = this.latestByEdgeId.get(edgeId);
        if (!entry) {
            return undefined;
        }
        return { start: entry.start, end: entry.end, route: entry.route };
    }

    // Retained for API compatibility with the edge view, but intentionally does no caching.
    getCached(_edgeId: string, _start: WorkflowPoint, _end: WorkflowPoint): WorkflowPoint[] | undefined {
        return undefined;
    }

    requestRoute(root: Readonly<GModelElement>, edge: Readonly<SEdgeImpl>, start: WorkflowPoint, end: WorkflowPoint): void {
        const seq = (this.seqByEdgeId.get(edge.id) ?? 0) + 1;
        this.seqByEdgeId.set(edge.id, seq);
        this.pendingByEdgeId.set(edge.id, { root, edge, start, end, seq });

        if (!this.inflightByEdgeId.has(edge.id)) {
            this.kick(edge.id);
        }
    }

    private kick(edgeId: string): void {
        const pending = this.pendingByEdgeId.get(edgeId);
        if (!pending) {
            return;
        }

        // Consume the current pending request.
        this.pendingByEdgeId.delete(edgeId);
        const { root, edge, start, end, seq } = pending;

        const promise = this.computeRoute(root, edge, start, end)
            .then(route => {
                const latestSeq = this.seqByEdgeId.get(edgeId);
                if (latestSeq !== seq) {
                    // Outdated result; a newer request arrived while computing.
                    return;
                }
                if (route.length >= 2) {
                    this.latestByEdgeId.set(edgeId, { start, end, route, seq });
                }
            })
            .catch(() => {
                // ignore
            })
            .finally(() => {
                this.inflightByEdgeId.delete(edgeId);
                if (this.pendingByEdgeId.has(edgeId)) {
                    // Immediately compute the newest endpoints.
                    this.kick(edgeId);
                }
            });

        this.inflightByEdgeId.set(edgeId, promise);
    }

    private async computeRoute(
        root: Readonly<GModelElement>,
        edge: Readonly<SEdgeImpl>,
        start: WorkflowPoint,
        end: WorkflowPoint
    ): Promise<WorkflowPoint[]> {
        const sourceEl = getById((root as any).index, (edge as any).sourceId) as any | undefined;
        const targetEl = getById((root as any).index, (edge as any).targetId) as any | undefined;

        const sourceNodeId = findParentNodeId(sourceEl);
        const targetNodeId = findParentNodeId(targetEl);

        const elements = Array.from(root.index.all());

        // Obstacles: real nodes (including the source/target nodes). We'll route *through ports*
        // so ELK can still consider the parent nodes as obstacles.
        const nodeById = new Map<string, any>();
        for (const el of elements) {
            if (!isNodeElement(el) || isPortElement(el)) continue;
            if (!(el instanceof GShapeElement)) continue;
            const pos = absPos(el as any);
            const { width, height } = sizeOf(el as any);
            if (width <= 1 || height <= 1) continue;
            nodeById.set(el.id, {
                id: el.id,
                x: pos.x,
                y: pos.y,
                width,
                height
            });
        }

        const startAnchor = (sourceEl && isPortElement(sourceEl)) ? centerOf(sourceEl) : start;
        const endAnchor = (targetEl && isPortElement(targetEl)) ? centerOf(targetEl) : end;

        // Performance: on large graphs, routing with all nodes as obstacles can be too slow for live drag.
        // Only keep obstacles that intersect a corridor around the endpoints.
        const margin = 420;
        const minX = Math.min(startAnchor.x, endAnchor.x) - margin;
        const maxX = Math.max(startAnchor.x, endAnchor.x) + margin;
        const minY = Math.min(startAnchor.y, endAnchor.y) - margin;
        const maxY = Math.max(startAnchor.y, endAnchor.y) + margin;

        const obstacleNodes = Array.from(nodeById.values()).filter(n => {
            const nx2 = n.x + n.width;
            const ny2 = n.y + n.height;
            return !(nx2 < minX || n.x > maxX || ny2 < minY || n.y > maxY);
        });

        // Always include the endpoints' parent nodes, even if outside the corridor.
        if (sourceNodeId && nodeById.has(sourceNodeId)) {
            const n = nodeById.get(sourceNodeId);
            if (!obstacleNodes.includes(n)) obstacleNodes.push(n);
        }
        if (targetNodeId && nodeById.has(targetNodeId)) {
            const n = nodeById.get(targetNodeId);
            if (!obstacleNodes.includes(n)) obstacleNodes.push(n);
        }

        const edgeId = `__cal_elk_edge__${edge.id}`;
        const srcDummyId = `__cal_elk_src__${edge.id}`;
        const tgtDummyId = `__cal_elk_tgt__${edge.id}`;

        // If we have real ports, route via ports on their parent nodes.
        const canUsePorts =
            !!sourceEl && !!targetEl
            && isPortElement(sourceEl) && isPortElement(targetEl)
            && typeof sourceNodeId === 'string' && typeof targetNodeId === 'string'
            && nodeById.has(sourceNodeId) && nodeById.has(targetNodeId);

        if (canUsePorts) {
            const srcNode = nodeById.get(sourceNodeId!)!;
            const tgtNode = nodeById.get(targetNodeId!)!;

            const srcPortAbs = portAnchorOnParentBoundary(sourceEl);
            const tgtPortAbs = portAnchorOnParentBoundary(targetEl);

            const srcPortRel = { x: srcPortAbs.x - srcNode.x, y: srcPortAbs.y - srcNode.y };
            const tgtPortRel = { x: tgtPortAbs.x - tgtNode.x, y: tgtPortAbs.y - tgtNode.y };

            srcNode.layoutOptions = {
                ...(srcNode.layoutOptions ?? {}),
                'elk.portConstraints': 'FIXED_POS',
                'org.eclipse.elk.portConstraints': 'FIXED_POS'
            };
            tgtNode.layoutOptions = {
                ...(tgtNode.layoutOptions ?? {}),
                'elk.portConstraints': 'FIXED_POS',
                'org.eclipse.elk.portConstraints': 'FIXED_POS'
            };

            srcNode.ports = [
                {
                    id: sourceEl.id,
                    x: srcPortRel.x,
                    y: srcPortRel.y,
                    width: 1,
                    height: 1
                }
            ];
            tgtNode.ports = [
                {
                    id: targetEl.id,
                    x: tgtPortRel.x,
                    y: tgtPortRel.y,
                    width: 1,
                    height: 1
                }
            ];

            const graph: any = {
                id: 'root',
                layoutOptions: {
                    ...serverLikeRerouteOptions()
                },
                children: obstacleNodes,
                edges: [
                    {
                        id: edgeId,
                        sources: [sourceNodeId],
                        targets: [targetNodeId],
                        sourcePorts: [sourceEl.id],
                        targetPorts: [targetEl.id]
                    }
                ]
            };

            const laidOut = await this.elk.layout(graph);
            const routed = (laidOut.edges ?? []).find((e: any) => e.id === edgeId);
            const section = routed?.sections?.[0];
            if (!section?.startPoint || !section?.endPoint) {
                return [];
            }

            return [
                { x: section.startPoint.x, y: section.startPoint.y },
                ...((section.bendPoints ?? []).map((p: any) => ({ x: p.x, y: p.y })) as WorkflowPoint[]),
                { x: section.endPoint.x, y: section.endPoint.y }
            ];
        }

        const graph: any = {
            id: 'root',
            layoutOptions: {
                ...serverLikeRerouteOptions()
            },
            children: [
                ...obstacleNodes,
                { id: srcDummyId, x: startAnchor.x, y: startAnchor.y, width: 1, height: 1 },
                { id: tgtDummyId, x: endAnchor.x, y: endAnchor.y, width: 1, height: 1 }
            ],
            edges: [
                {
                    id: edgeId,
                    sources: [srcDummyId],
                    targets: [tgtDummyId]
                }
            ]
        };

        const laidOut = await this.elk.layout(graph);
        const routed = (laidOut.edges ?? []).find((e: any) => e.id === edgeId);
        const section = routed?.sections?.[0];
        if (!section?.startPoint || !section?.endPoint) {
            return [];
        }

        const points: WorkflowPoint[] = [
            { x: section.startPoint.x, y: section.startPoint.y },
            ...((section.bendPoints ?? []).map((p: any) => ({ x: p.x, y: p.y })) as WorkflowPoint[]),
            { x: section.endPoint.x, y: section.endPoint.y }
        ];

        return points;
    }
}

export const workflowElkPreviewRouter = new WorkflowElkPreviewRouter();
