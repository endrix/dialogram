/**
 * A list of one family's nodes across a hierarchy (shared `NodeListSpec`),
 * published on the root model as `wf:nodeList`.
 *
 * The hierarchy outline shows the instances; this shows the nodes of one
 * kind wherever they are (a workflow's viewers), under the instances that
 * hold them, with nothing else. Each node row carries the node as the canvas
 * would draw it: its element and the edges into it, with what the last run
 * left on them. So a product's node opener, which reads a node, its root's
 * edges and its root's arguments, works on a row as on a node of the view
 * shown, and a double click opens what one on the node opens, without that
 * node's view being opened.
 *
 * The rows are built from the graphs of the hierarchy's export
 * (`GraphDocument.hierarchyGraphs`), each transformed as a view of it would
 * be, and their edges given the run's tokens by the same rule the canvas
 * uses (`OverlayTokenOf`). Nothing is laid out. A node is in the family the
 * canvas colours it by: shared `resolveNodeFamily` over its definition's
 * annotations, with the families the canvas has.
 */
import {
    nodeFamilyName,
    resolveNodeFamily,
    WorkflowDiagramMetadata,
    type DetachedNode,
    type GraphDocument,
    type HierarchyGraph,
    type HierarchyOutlineEntry,
    type NodeAnnotationList,
    type NodeFamilySpec,
    type NodeListOutline,
    type NodeListSpec
} from '@dialogram/shared';
import type { GModelElement } from '../model/graph-gmodel-source';

/** The token the last run left on an edge, by the edge's arguments; undefined when it left none. */
export type OverlayTokenOf = (edgeArgs: Record<string, unknown> | undefined) => { token: unknown } | undefined;

export interface NodeListInput {
    spec: NodeListSpec;
    /** The product's node families, as the canvas has them (`clientBehavior.nodeFamilies`). */
    families: readonly NodeFamilySpec[];
    graphs: HierarchyGraph[];
    /** The hierarchy outline, for the instances' order, labels and node ids. */
    hierarchy?: HierarchyOutlineEntry;
    /** An instance's document as the canvas model's graph, as a view of it is made. */
    transform(document: GraphDocument): GModelElement;
    /** The run's token on an edge; absent with no run. */
    tokenOf?: OverlayTokenOf;
    /** The run's arguments a view's root carries (`wf:viewerOverlayRunId`, `wf:viewerOverlayOutDir`), published once with the list. */
    rootArgs?: Record<string, unknown>;
}

const EDGE_PREFIX = 'edge';
const NODE_PREFIX = 'node';

function pathKey(path: string[]): string {
    return path.join('/');
}

/** Whether the canvas draws `element` as a node of `family`. */
function inFamily(element: GModelElement, family: string, families: readonly NodeFamilySpec[]): boolean {
    if (!element.type.startsWith(NODE_PREFIX)) {
        return false;
    }
    const annotations = element.args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as NodeAnnotationList | undefined;
    const found = resolveNodeFamily(annotations, families);
    return found !== undefined && nodeFamilyName(found) === family;
}

/** Every element under `root`, depth first. */
function* elementsOf(root: GModelElement): Generator<GModelElement> {
    const stack: GModelElement[] = [root];
    while (stack.length > 0) {
        const element = stack.pop()!;
        yield element;
        for (let index = (element.children ?? []).length - 1; index >= 0; index--) {
            stack.push(element.children![index]);
        }
    }
}

/** The ids of `node` and everything in it: its ports, what an edge into it ends at. */
function idsWithin(node: GModelElement): Set<string> {
    return new Set([...elementsOf(node)].map(element => element.id));
}

function stringArg(element: GModelElement, key: string): string | undefined {
    const value = element.args?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A node of `family` in one instance's graph, as a row. */
function nodeRow(
    node: GModelElement,
    edges: GModelElement[],
    instance: HierarchyGraph,
    input: NodeListInput
): HierarchyOutlineEntry {
    const within = idsWithin(node);
    const into = edges
        .filter(edge => within.has(String((edge as { targetId?: unknown }).targetId)))
        .map(edge => {
            const args = { ...(edge.args ?? {}) };
            delete args[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
            const carried = input.tokenOf?.(edge.args);
            if (carried) {
                args[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN] = carried.token;
            }
            const ends = edge as unknown as { sourceId: string; targetId: string };
            return { id: edge.id, type: edge.type, sourceId: ends.sourceId, targetId: ends.targetId, args };
        });
    const name = stringArg(node, WorkflowDiagramMetadata.ENTITY_NAME) ?? node.id;
    const type = stringArg(node, WorkflowDiagramMetadata.ENTITY_TYPE);
    const detachedNode: DetachedNode = {
        id: node.id,
        type: node.type,
        ...(node.args ? { args: node.args } : {}),
        edges: into
    };
    return {
        path: [...instance.path, name],
        workflowName: instance.workflowName,
        ...(instance.sourceUri ? { sourceUri: instance.sourceUri } : {}),
        nodeId: stringArg(node, WorkflowDiagramMetadata.GRAPH_NODE_ID) ?? node.id,
        role: 'node',
        label: name,
        ...(type && type !== name ? { detail: type.split('.').pop() } : {}),
        family: input.spec.family,
        detachedNode,
        children: []
    };
}

/** One instance's nodes of a family and every edge of its graph, as the canvas draws them. */
type FamilyNodes = { family: string; nodes: GModelElement[]; edges: GModelElement[] };

/**
 * What a document's transform found, by document: the export's documents
 * stay the same objects while the hierarchy is not exported again, and a
 * run's tokens, which change, are put on afterwards.
 */
const familyNodesByDocument = new WeakMap<object, FamilyNodes>();

/**
 * Whether a producer's document may hold a node with `annotation`: the
 * name is somewhere in it, as a key (`meta.viewer`, `meta.annotations.viewer`)
 * or as a `name` (`meta.definitionAnnotations`). A document that does not is
 * not transformed, which is most of a hierarchy.
 */
function mayHold(document: unknown, annotation: string): boolean {
    const stack: unknown[] = [document];
    while (stack.length > 0) {
        const value = stack.pop();
        if (Array.isArray(value)) {
            stack.push(...value);
        } else if (value && typeof value === 'object') {
            if ((value as { name?: unknown }).name === annotation || Object.prototype.hasOwnProperty.call(value, annotation)) {
                return true;
            }
            stack.push(...Object.values(value));
        }
    }
    return false;
}

function familyNodesOf(instance: HierarchyGraph, input: NodeListInput, annotation: string): FamilyNodes | undefined {
    const known = familyNodesByDocument.get(instance.document);
    if (known && known.family === input.spec.family) {
        return known;
    }
    const none: FamilyNodes = { family: input.spec.family, nodes: [], edges: [] };
    if (!mayHold(instance.document, annotation)) {
        familyNodesByDocument.set(instance.document, none);
        return none;
    }
    let graph: GModelElement;
    try {
        graph = input.transform(instance.document);
    } catch (error) {
        // Said once per export: the same document fails the same way.
        console.warn(`[node-list] the graph of ${pathKey(instance.path) || 'the root'} could not be read: ${String(error)}`);
        familyNodesByDocument.set(instance.document, none);
        return none;
    }
    const elements = [...elementsOf(graph)];
    const nodes = elements.filter(element => inFamily(element, input.spec.family, input.families));
    const within = new Set(nodes.flatMap(node => [...idsWithin(node)]));
    const found: FamilyNodes = {
        family: input.spec.family,
        nodes,
        // Only the edges into a listed node are read.
        edges: elements.filter(element => element.type.startsWith(EDGE_PREFIX)
            && within.has(String((element as { targetId?: unknown }).targetId)))
    };
    familyNodesByDocument.set(instance.document, found);
    return found;
}

/** The rows of the family's nodes in one instance, in the graph's order. */
function rowsOfInstance(instance: HierarchyGraph, input: NodeListInput, annotation: string): HierarchyOutlineEntry[] {
    const found = familyNodesOf(instance, input, annotation);
    return found ? found.nodes.map(node => nodeRow(node, found.edges, instance, input)) : [];
}

/**
 * The node list: the root instance, holding the family's nodes and the
 * instances below that hold some. Undefined when the hierarchy holds none,
 * so that no panel is offered for an empty list.
 */
export function buildNodeList(input: NodeListInput): NodeListOutline | undefined {
    const graphByPath = new Map(input.graphs.map(graph => [pathKey(graph.path), graph]));
    const rootGraph = graphByPath.get('');
    // The family's annotation, for a cheap look at each graph before its transform.
    const annotation = input.families.find(family => nodeFamilyName(family) === input.spec.family)?.annotation;
    if (!rootGraph || !annotation) {
        return undefined;
    }
    let listed = 0;
    // The outline's tree gives the instances' order and their node ids; an
    // instance it lacks (no outline given) is placed from the graphs' paths.
    const outlineByPath = new Map<string, HierarchyOutlineEntry>();
    const walkOutline = (entry: HierarchyOutlineEntry): void => {
        outlineByPath.set(pathKey(entry.path), entry);
        entry.children.forEach(walkOutline);
    };
    if (input.hierarchy) {
        walkOutline(input.hierarchy);
    }
    const childPaths = new Map<string, string[][]>();
    for (const graph of input.graphs) {
        if (graph.path.length === 0) {
            continue;
        }
        const parent = pathKey(graph.path.slice(0, -1));
        childPaths.set(parent, [...(childPaths.get(parent) ?? []), graph.path]);
    }
    const orderedChildren = (path: string[]): string[][] => {
        const outlined = outlineByPath.get(pathKey(path))?.children.map(child => child.path);
        const fromGraphs = childPaths.get(pathKey(path)) ?? [];
        if (!outlined) {
            return fromGraphs;
        }
        const seen = new Set(outlined.map(pathKey));
        return [...outlined, ...fromGraphs.filter(child => !seen.has(pathKey(child)))];
    };

    const instanceRow = (path: string[]): HierarchyOutlineEntry | undefined => {
        const graph = graphByPath.get(pathKey(path));
        const nodes = graph ? rowsOfInstance(graph, input, annotation) : [];
        listed += nodes.length;
        const below = orderedChildren(path)
            .map(instanceRow)
            .filter((row): row is HierarchyOutlineEntry => row !== undefined);
        if (path.length > 0 && nodes.length === 0 && below.length === 0) {
            return undefined;
        }
        const outlined = outlineByPath.get(pathKey(path));
        return {
            path,
            workflowName: graph?.workflowName ?? outlined?.workflowName ?? '',
            ...((graph?.sourceUri ?? outlined?.sourceUri) ? { sourceUri: graph?.sourceUri ?? outlined?.sourceUri } : {}),
            ...(outlined?.nodeId ? { nodeId: outlined.nodeId } : {}),
            ...(outlined?.label ? { label: outlined.label } : {}),
            children: [...nodes, ...below]
        };
    };
    const outline = instanceRow([]);
    if (!outline || listed === 0) {
        return undefined;
    }
    return {
        title: input.spec.title,
        ...(input.spec.codicon ? { codicon: input.spec.codicon } : {}),
        ...(input.rootArgs ? { rootArgs: input.rootArgs } : {}),
        outline
    };
}
