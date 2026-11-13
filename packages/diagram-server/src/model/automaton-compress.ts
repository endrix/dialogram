/**
 * A large automaton made small enough to read, by two rewrites a reader of
 * state machines knows.
 *
 * **Runs are folded.** A run of three states or more, each with one way in
 * and one way out (no loop, not the state the automaton starts in), is the
 * automaton going through a sequence: a program counter, not a choice. It is
 * drawn as one state, named for its first and last, that lists the actions
 * taken along it in order; an action taken several times in a row is one
 * step with its count (`get_pred ×3`). The way into the run comes into that
 * state, the way out of it leaves from it.
 *
 * **Ways into a hub are stubs.** A state entered from many others (a state
 * every failure goes to) would draw a curve from each across the whole
 * automaton. Each such transition is marked a stub: the client draws a short
 * arrow at its source, towards the hub, ending in the hub's name, and the
 * placement does not pull the hub towards all of them.
 *
 * Both are rewrites of the document, before it becomes a model: the folded
 * state is a node like the others, and every transition keeps its id, its
 * label, its order, its condition and its facts.
 *
 * A run the reader unfolds is drawn as its states again; its first state
 * says so (`meta.run`, `meta.runOpen`), for the toggle that folds it back.
 */
import type { StateStep } from '@dialogram/shared';
import type { PyGraphDocument, PyGraphEdge, PyGraphNode } from './graph-gmodel-source';

/** The fewest states a run must have to be folded. */
export const FOLD_MIN_STATES = 3;
/** The fewest other states a state must be entered from to be a hub. */
export const HUB_MIN_SOURCES = 5;

/** The runs the reader has unfolded, by their ids (`foldId`). */
export interface OpenRuns {
    has(runId: string): boolean;
}

/** The id of the state a run is folded into: the first state's, marked. */
export function foldId(firstStateId: string): string {
    return `fold:${firstStateId}`;
}

const isState = (node: PyGraphNode): boolean => node.kind === 'state';

/** The runs of states with one way in and one way out, in the document's order of their first states. */
export function foldableRuns(states: readonly PyGraphNode[], transitions: readonly PyGraphEdge[]): string[][] {
    const ids = new Set(states.map(state => state.id));
    const succ = new Map<string, Set<string>>();
    const pred = new Map<string, Set<string>>();
    const looped = new Set<string>();
    for (const t of transitions) {
        if (t.from === t.to) {
            looped.add(t.from);
            continue;
        }
        if (!succ.has(t.from)) {
            succ.set(t.from, new Set());
        }
        if (!pred.has(t.to)) {
            pred.set(t.to, new Set());
        }
        succ.get(t.from)!.add(t.to);
        pred.get(t.to)!.add(t.from);
    }
    const one = (set: Set<string> | undefined): string | undefined => (set?.size === 1 ? [...set][0] : undefined);
    const inner = new Set(states
        .filter(state => !looped.has(state.id) && state.meta?.['initial'] !== true
            && one(succ.get(state.id)) !== undefined && one(pred.get(state.id)) !== undefined)
        .map(state => state.id));
    const seen = new Set<string>();
    const runs: string[][] = [];
    for (const state of states) {
        if (!inner.has(state.id) || seen.has(state.id)) {
            continue;
        }
        // Back to where the run starts; a run that goes round to itself is a cycle, not a sequence.
        let start = state.id;
        let cycle = false;
        for (let p = one(pred.get(start)); p !== undefined && inner.has(p); p = one(pred.get(start))) {
            if (p === state.id) {
                cycle = true;
                break;
            }
            start = p;
        }
        const run: string[] = [];
        for (let at: string | undefined = start; at !== undefined && inner.has(at) && !seen.has(at); at = one(succ.get(at))) {
            seen.add(at);
            run.push(at);
        }
        if (!cycle && run.length >= FOLD_MIN_STATES && run.every(id => ids.has(id))) {
            runs.push(run);
        }
    }
    return runs;
}

/** The steps along a run: the actions from each of its states to the next, a repeated one counted. */
export function stepsOf(run: readonly string[], transitions: readonly PyGraphEdge[]): StateStep[] {
    const steps: StateStep[] = [];
    for (let k = 0; k + 1 < run.length; k++) {
        const labels = transitions
            .filter(t => t.from === run[k] && t.to === run[k + 1])
            .map(t => (typeof t.meta?.['label'] === 'string' ? t.meta['label'] as string : t.id));
        const action = labels.join(' | ');
        const last = steps[steps.length - 1];
        if (last && last.action === action) {
            last.count++;
        } else {
            steps.push({ action, count: 1 });
        }
    }
    return steps;
}

/**
 * `doc` with its runs folded and the ways into its hubs marked as stubs; the
 * document itself when it has no automaton. `open` names folded states the
 * reader has unfolded (by their ids, `foldId`): those runs stay as they are,
 * their first state marked as the one that folds them again.
 */
export function compressAutomaton(doc: PyGraphDocument, open: OpenRuns = new Set<string>()): PyGraphDocument {
    const nodes = doc.graph.nodes;
    const states = nodes.filter(isState);
    if (states.length < 2) {
        return doc;
    }
    const stateIds = new Set(states.map(state => state.id));
    const isTransition = (edge: PyGraphEdge): boolean => stateIds.has(edge.from) && stateIds.has(edge.to);
    const transitions = doc.graph.edges.filter(isTransition);
    const byId = new Map(states.map(state => [state.id, state]));

    // Fold the runs.
    const foldOf = new Map<string, string>();
    const folds: PyGraphNode[] = [];
    const inside = new Set<string>();
    // The first state of each unfolded run, and the run it opens.
    const unfolded = new Map<string, { id: string; label: string }>();
    for (const run of foldableRuns(states, transitions)) {
        const id = foldId(run[0]);
        const first = byId.get(run[0])!;
        const last = byId.get(run[run.length - 1])!;
        if (open.has(id)) {
            unfolded.set(run[0], { id, label: `${first.label} … ${last.label}` });
            continue;
        }
        const steps = stepsOf(run, transitions);
        const ways = transitions.filter(t => run.includes(t.from) && run.includes(t.to));
        ways.forEach(way => inside.add(way.id));
        run.forEach(stateId => foldOf.set(stateId, id));
        folds.push({
            id,
            kind: 'state',
            label: `${first.label} … ${last.label}`,
            type: first.type,
            scope: first.scope,
            ports: [],
            meta: {
                ...(first.meta?.['source'] !== undefined ? { source: first.meta['source'] } : {}),
                steps,
                folded: run.map(stateId => byId.get(stateId)!.label),
                // What was said of a way inside the run is said of the run (a link that starts there).
                foldedTransitions: ways.map(way => way.id),
                run: id,
                facts: [{
                    label: `Steps (${run.length} states)`,
                    markdown: true,
                    value: run.slice(0, -1).map((stateId, k) => {
                        const labels = transitions.filter(t => t.from === stateId && t.to === run[k + 1])
                            .map(t => `\`${typeof t.meta?.['label'] === 'string' ? t.meta['label'] : t.id}\``);
                        return `${k + 1}. ${byId.get(stateId)!.label} → ${labels.join(', ')}`;
                    }).concat(`${run.length}. ${last.label}`).join('\n')
                }]
            }
        });
    }
    const end = (id: string): string => foldOf.get(id) ?? id;
    let edges = doc.graph.edges
        .filter(edge => !inside.has(edge.id))
        .map(edge => (isTransition(edge) && (foldOf.has(edge.from) || foldOf.has(edge.to))
            ? { ...edge, from: end(edge.from), to: end(edge.to) }
            : edge));
    // The folded state takes the first state's place in the order of the nodes.
    const ordered: PyGraphNode[] = [];
    for (const node of nodes) {
        const fold = foldOf.get(node.id);
        const opens = unfolded.get(node.id);
        if (opens) {
            ordered.push({ ...node, meta: { ...(node.meta ?? {}), run: opens.id, runOpen: true, runLabel: opens.label } });
        } else if (fold === undefined) {
            ordered.push(node);
        } else if (fold === foldId(node.id)) {
            ordered.push(folds.find(f => f.id === fold)!);
        }
    }

    // Mark the ways into the hubs.
    const afterIds = new Set([...states.filter(s => !foldOf.has(s.id)).map(s => s.id), ...folds.map(f => f.id)]);
    const sources = new Map<string, Set<string>>();
    for (const edge of edges) {
        if (afterIds.has(edge.from) && afterIds.has(edge.to) && edge.from !== edge.to) {
            if (!sources.has(edge.to)) {
                sources.set(edge.to, new Set());
            }
            sources.get(edge.to)!.add(edge.from);
        }
    }
    const hubs = new Set([...sources].filter(([, from]) => from.size >= HUB_MIN_SOURCES).map(([to]) => to));
    if (hubs.size > 0) {
        edges = edges.map(edge => (hubs.has(edge.to) && afterIds.has(edge.from) && edge.from !== edge.to
            ? { ...edge, meta: { ...(edge.meta ?? {}), stub: true } }
            : edge));
    }
    if (folds.length === 0 && hubs.size === 0 && unfolded.size === 0) {
        return doc;
    }
    // A scope lists its nodes and edges: the folded ones leave it, the folds join their first state's.
    const subgraphs = doc.graph.subgraphs?.map(scope => {
        const list = (scope as unknown as { nodes?: string[]; edges?: string[] });
        if (!Array.isArray(list.nodes) && !Array.isArray(list.edges)) {
            return scope;
        }
        return {
            ...scope,
            ...(Array.isArray(list.nodes)
                ? { nodes: list.nodes.flatMap(id => (foldOf.has(id) ? (foldOf.get(id) === foldId(id) ? [foldId(id)] : []) : [id])) }
                : {}),
            ...(Array.isArray(list.edges) ? { edges: list.edges.filter(id => !inside.has(id)) } : {})
        };
    });
    return { ...doc, graph: { ...doc.graph, nodes: ordered, edges, ...(subgraphs ? { subgraphs } : {}) } };
}
