/**
 * Captions written once per trunk (`clientBehavior.edgeCaptions: 'once'`).
 *
 * Edges that leave one port together run along one line until they part, and
 * so do edges that reach one port: the router bundles them. Each edge writes
 * its caption at its own midpoint, and the midpoints of a bundle fall on the
 * shared line, so a node with twenty edges of one type stacks twenty copies of
 * one word there. With 'once', an edge leaves its caption out when an earlier
 * edge (in model order) that leaves the same port, or reaches the same port,
 * already writes the same text. Edges of different captions keep theirs, and
 * an edge alone on its ports always does. The hover tooltip of an edge whose
 * caption is left out still says what it carries.
 *
 * Decided once per model, for all its edges: which edge writes is a question
 * about its neighbours, which the edge view cannot answer edge by edge.
 */
import { WorkflowDiagramMetadata } from '@dialogram/shared';

/**
 * What a connection carries, as its caption, when the producer says:
 * `EDGE_LABEL`, text the producer formatted (a payload type, a protocol
 * name), else `EDGE_WIDTH`, a bit count. Both describe the same thing at
 * different resolutions, so only one is written.
 */
export function carriedTextOf(args: Record<string, unknown> | undefined): string | undefined {
    const label = (args?.[WorkflowDiagramMetadata.EDGE_LABEL] as string | undefined)?.trim();
    if (label) {
        return label;
    }
    const width = args?.[WorkflowDiagramMetadata.EDGE_WIDTH];
    return typeof width === 'number' && Number.isFinite(width) ? String(Math.max(0, Math.trunc(width))) : undefined;
}

export interface CaptionedEdge {
    id: string;
    sourceId: string;
    targetId: string;
    caption: string | undefined;
}

/** The edges, in the order given, whose caption an earlier edge of the same port already writes. */
export function edgesWithSharedCaption(edges: Iterable<CaptionedEdge>): Set<string> {
    const written = new Set<string>();
    const shared = new Set<string>();
    for (const edge of edges) {
        if (!edge.caption) {
            continue;
        }
        const leaving = `out\u0000${edge.sourceId}\u0000${edge.caption}`;
        const reaching = `in\u0000${edge.targetId}\u0000${edge.caption}`;
        if (written.has(leaving) || written.has(reaching)) {
            shared.add(edge.id);
            continue;
        }
        written.add(leaving);
        written.add(reaching);
    }
    return shared;
}

const sharedByRoot = new WeakMap<object, Set<string>>();

/** Whether this edge's caption is left out, an earlier edge of its port writing it. */
export function captionIsShared(edge: unknown): boolean {
    const { id, root } = edge as { id?: string; root?: { index?: { all(): Iterable<unknown> } } };
    if (!id || !root?.index) {
        return false;
    }
    let shared = sharedByRoot.get(root);
    if (!shared) {
        const edges: CaptionedEdge[] = [];
        for (const element of root.index.all()) {
            const candidate = element as { id?: string; sourceId?: string; targetId?: string; args?: Record<string, unknown> };
            if (candidate.id && typeof candidate.sourceId === 'string' && typeof candidate.targetId === 'string') {
                edges.push({
                    id: candidate.id,
                    sourceId: candidate.sourceId,
                    targetId: candidate.targetId,
                    caption: carriedTextOf(candidate.args)
                });
            }
        }
        shared = edgesWithSharedCaption(edges);
        sharedByRoot.set(root, shared);
    }
    return shared.has(id);
}
