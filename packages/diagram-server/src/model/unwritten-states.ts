/**
 * The states a reader placed in a view that nothing is written of yet.
 *
 * An automaton written as its transitions (a schedule of triples, a table of
 * from, by, to) has no state that no transition names: a state placed with
 * the palette's State has nowhere to be written until a transition from or
 * to it is drawn. Until then the editor holds it, with the view's layout
 * (`unwrittenStates`), and draws it among the producer's states; drawing a
 * transition names it to the producer, which writes both.
 *
 * A held state the producer has since written is not drawn twice: the
 * producer's is drawn, where the held one was placed if the view has no
 * place of its own for it. The editor keeps holding it, so that undoing the
 * transition that wrote it leaves the state where it was, held; deleting the
 * state lets go of it. A held state the producer stops writing some other
 * way (its transitions deleted, a rename in the source) is held again, drawn
 * as not written, until it is deleted. A held state and the producer's of
 * the same name are drawn under one layout key, the state's name, so a held
 * state moved keeps its place once written.
 */
import { UNWRITTEN_STATE_ID_PREFIX, WorkflowDiagramMetadata, WorkflowDiagramTypes, viewEditsOf } from '@dialogram/shared';
import type { PyGraphDocument, PyGraphNode } from './graph-gmodel-source';

/** Where a held state was placed. */
export interface Place {
    x: number;
    y: number;
}

/** Whether `doc` is a view the producer lets states be placed in (`meta.edits` has `state`). */
export function allowsStateEdits(doc: PyGraphDocument): boolean {
    return doc.graph.meta?.['readOnly'] === true
        && viewEditsOf({ [WorkflowDiagramMetadata.VIEW_EDITS]: doc.graph.meta?.['edits'] }).includes('state');
}

/** The names of the states the producer wrote (`meta.state`), by the node that draws each. */
export function writtenStates(doc: PyGraphDocument): Map<string, PyGraphNode> {
    const out = new Map<string, PyGraphNode>();
    for (const node of doc.graph.nodes) {
        const name = node.kind === 'state' ? node.meta?.['state'] : undefined;
        if (typeof name === 'string' && name !== '' && !out.has(name)) {
            out.set(name, node);
        }
    }
    return out;
}

/** The node that draws a held state. */
export function unwrittenStateNode(name: string, scope: string): PyGraphNode {
    return {
        id: UNWRITTEN_STATE_ID_PREFIX + name,
        kind: 'state',
        label: name,
        type: 'state',
        scope,
        ports: [],
        meta: {
            state: name,
            unwritten: true,
            facts: [{ label: 'Not written yet', value: 'A transition drawn from or to it writes it.' }]
        }
    };
}

/** `doc` with the states the editor holds that the producer has not written; `doc` itself in a view that takes no states. */
export function withUnwrittenStates(doc: PyGraphDocument, held: ReadonlyMap<string, Place>): PyGraphDocument {
    if (held.size === 0 || !allowsStateEdits(doc)) {
        return doc;
    }
    const written = writtenStates(doc);
    // Among the producer's states; with none written yet, among its nodes
    // that are not in a group (a list or a band pinned beside the drawing).
    const groups = new Set((doc.graph.subgraphs ?? []).filter(scope => scope.kind === 'group').map(scope => scope.id));
    const scope = [...written.values()][0]?.scope
        ?? doc.graph.nodes.find(node => !groups.has(node.scope))?.scope
        ?? 'scope:root';
    const added = [...held.keys()].filter(name => !written.has(name)).map(name => unwrittenStateNode(name, scope));
    return added.length === 0 ? doc : { ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes, ...added] } };
}

/**
 * Where the held states are drawn, into `positions` (by layout key): each
 * where it was placed, unless the view has a place of its own for its node.
 * A held state the producer has since written is placed so too: it keeps
 * its place when the transition that wrote it is drawn.
 */
export function placeHeldStates(
    root: { children?: unknown[] } | undefined,
    held: ReadonlyMap<string, Place>,
    positions: Map<string, Place>
): void {
    if (held.size === 0) {
        return;
    }
    for (const node of statesIn(root)) {
        const name = node.args?.[WorkflowDiagramMetadata.STATE_NAME];
        const key = node.args?.[WorkflowDiagramMetadata.AST_PATH];
        const place = typeof name === 'string' ? held.get(name) : undefined;
        if (place && typeof key === 'string' && !positions.has(key)) {
            positions.set(key, { x: place.x, y: place.y });
        }
    }
}

/** The states drawn in `root`, at any depth: a scope may hold them. */
export function* statesIn(root: { children?: unknown[] } | undefined): Generator<{ type?: string; args?: Record<string, unknown> }> {
    for (const child of root?.children ?? []) {
        const node = child as { type?: string; args?: Record<string, unknown>; children?: unknown[] };
        if (node.type === WorkflowDiagramTypes.NODE_STATE) {
            yield node;
        } else if (Array.isArray(node.children)) {
            yield* statesIn(node);
        }
    }
}
