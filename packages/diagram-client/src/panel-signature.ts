/**
 * What the property panel draws from the model, in short: when it changes,
 * the panel is drawn again.
 *
 * An edit (a port renamed, retyped, added or taken out, a node renamed, a
 * parameter set) comes back as a new model; the panel, drawn from the old
 * one, went on showing what was there before until something else was
 * selected. A run sends new models too, a step at a time, and puts its state
 * on the nodes; those the node sections update in place
 * (`NodeSectionContribution.modelChanged`), and the panel is not drawn again
 * for them. So the signature takes only what the panel's own rows read: a
 * node's name, entity, definition, parameters, annotations and facts, and
 * its ports' names, types and kinds; an edge's two ends, by node and port; a
 * state's name; and, for the network shown when nothing is selected, its
 * name, parameters, annotations, facts, load issues and its own ports.
 */
import { isBoundaryNodeType, WorkflowDiagramMetadata as M, WorkflowDiagramTypes } from '@dialogram/shared';

interface ElementLike {
    id?: string;
    type?: string;
    args?: Record<string, unknown>;
    parent?: ElementLike;
    children?: readonly ElementLike[];
    sourceId?: string;
    targetId?: string;
}

interface RootLike extends ElementLike {
    index?: { getById?: (id: string) => ElementLike | undefined };
}

const NODE_KEYS = [
    M.ENTITY_NAME,
    M.ENTITY_TYPE,
    M.REFERENCED_URI,
    M.REFERENCED_IS_DEFINITION,
    M.ENTITY_PARAMETERS,
    M.ENTITY_DEFINITION_PARAMETERS,
    M.ENTITY_DEFINITION_ANNOTATIONS,
    M.IS_NETWORK_INSTANCE,
    M.IS_EXTERNAL_ACTOR,
    M.NETWORK_FACTORY_NAME,
    M.FACTS,
    M.PORT_NAME,
    M.PORT_TYPE,
    M.GROUP_LABEL,
    M.STATE_INITIAL
];

const PORT_KEYS = [M.PORT_NAME, M.PORT_TYPE, M.IS_INPUT_PORT, M.IS_ARRAY_PORT, M.ARRAY_SIZE, M.GROUP_END];

const EDGE_KEYS = [M.TRANSITION_CONDITION, M.TRANSITION_ORDER, M.EDGE_LABEL];

const ROOT_KEYS = [
    M.NETWORK_NAME,
    'wf:workflowName',
    M.NETWORK_FACTORY_NAME,
    M.NETWORK_PARAMETERS,
    'wf:workflowSourceUri',
    M.REFERENCED_URI,
    M.FACTS,
    M.ENTITY_DEFINITION_ANNOTATIONS,
    'wf:errors',
    'wf:partial'
];

function picked(element: ElementLike | undefined, keys: readonly string[]): unknown[] {
    const args = element?.args ?? {};
    return keys.map(key => args[key]);
}

function isPort(element: ElementLike | undefined): boolean {
    return (element?.type ?? '').startsWith('port');
}

function nodeParts(node: ElementLike): unknown[] {
    return [
        node.id,
        node.type,
        picked(node, NODE_KEYS),
        (node.children ?? []).filter(isPort).map(port => [port.id, port.type, picked(port, PORT_KEYS)])
    ];
}

/** An edge's end as the panel names it: its port, and the node the port is on. */
function endParts(root: RootLike | undefined, id: string | undefined): unknown[] {
    const port = id ? root?.index?.getById?.(id) : undefined;
    return [id, picked(port, PORT_KEYS), picked(port?.parent, [M.ENTITY_NAME, M.GROUP_LABEL])];
}

/**
 * The signature of what the panel draws for `element` (a node, a port, which
 * is drawn as its node, an edge or a state), read in `root`.
 */
export function elementPanelSignature(element: ElementLike, root?: RootLike): string {
    const type = element.type ?? '';
    if (type.startsWith('edge')) {
        return JSON.stringify(['edge', element.id, type, picked(element, EDGE_KEYS),
            endParts(root, element.sourceId), endParts(root, element.targetId)]);
    }
    if (isPort(element) && element.parent) {
        return JSON.stringify(['port', element.id, nodeParts(element.parent)]);
    }
    return JSON.stringify(['node', nodeParts(element)]);
}

/** The signature of the network the panel draws when nothing is selected. */
export function networkPanelSignature(root: RootLike | undefined): string {
    const boundaries: unknown[] = [];
    const visit = (element: ElementLike | undefined): void => {
        for (const child of element?.children ?? []) {
            if (isBoundaryNodeType(child.type)) {
                boundaries.push([child.type, child.id, picked(child, NODE_KEYS)]);
            }
            visit(child);
        }
    };
    visit(root);
    return JSON.stringify(['network', root?.id, picked(root, ROOT_KEYS), boundaries]);
}
