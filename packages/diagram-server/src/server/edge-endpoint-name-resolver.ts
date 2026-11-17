/**
 * Name-addressable edge endpoints for the agent-dispatch `create-edges` tool.
 *
 * The stock GLSP-MCP `create-edges` tool addresses endpoints by raw element id, which an agent can
 * only obtain through a scavenger hunt (query-elements / diagram-model / diagram-svg) to map a
 * human-meaningful `nodeName.portName` onto the opaque id the tool needs. This module resolves a
 * `"nodeName.portName"` spec against the current model tree to that element id, so an agent that
 * just created a node (whose confirmation lists its port names) can connect it with no further
 * queries. Raw element-id addressing keeps working — this is a superset.
 *
 * Neutrality: purely structural (node/port `type` prefixes + the shared metadata arg keys). No
 * product vocabulary.
 */
import type { GModelElement, GModelRoot } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

/** One `nodeName.portName` candidate discovered in the model tree. */
interface DiscoveredPort {
    elementId: string;
    portName: string;
    ownerName: string | undefined;
    /** Whether the owner is a boundary node: a port of the diagram itself (a workflow's input or output). */
    ownerIsBoundary: boolean;
    direction: string | undefined;
}

/**
 * Flat result (not a discriminated union): this package compiles with `strict:false`, where a
 * boolean discriminant does not narrow. Consumers read `elementId` on success, `message` on failure.
 */
export interface EndpointResolution {
    ok: boolean;
    elementId?: string;
    message?: string;
}

const ENTITY_NAME = WorkflowDiagramMetadata.ENTITY_NAME;
const PORT_NAME = WorkflowDiagramMetadata.PORT_NAME;
const PORT_DIRECTION = WorkflowDiagramMetadata.PORT_DIRECTION;

function argString(element: GModelElement, key: string): string | undefined {
    const value = (element as { args?: Record<string, unknown> }).args?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Collect every port in the tree tagged with the name of its nearest owning node. */
function collectPorts(root: GModelRoot): DiscoveredPort[] {
    const ports: DiscoveredPort[] = [];
    const visit = (element: GModelElement, ownerName: string | undefined, ownerIsBoundary: boolean): void => {
        const type = element.type;
        let currentOwner = ownerName;
        let currentIsBoundary = ownerIsBoundary;
        if (typeof type === 'string' && type.startsWith('node:')) {
            // Task/actor nodes carry an instance name; boundary nodes carry a port name identity.
            const entity = argString(element, ENTITY_NAME);
            const boundary = entity ? undefined : argString(element, PORT_NAME);
            if (entity || boundary) {
                currentOwner = entity ?? boundary;
                currentIsBoundary = !entity;
            }
        }
        if (typeof type === 'string' && type.startsWith('port:')) {
            ports.push({
                elementId: element.id,
                portName: argString(element, PORT_NAME) ?? '',
                ownerName: currentOwner,
                ownerIsBoundary: currentIsBoundary,
                direction: argString(element, PORT_DIRECTION)
            });
        }
        for (const child of (element.children ?? []) as GModelElement[]) {
            visit(child, currentOwner, currentIsBoundary);
        }
    };
    visit(root, undefined, false);
    return ports;
}

/** True when `spec` looks like a `nodeName.portName` reference (as opposed to a raw element id). */
export function looksLikeNameSpec(spec: string): boolean {
    return spec.includes('.');
}

/**
 * Resolve a `"nodeName.portName"` spec to a port element id against the current model tree.
 * Returns an actionable failure for a malformed spec, an unknown node, an unknown port (listing the
 * node's real ports), or an ambiguous match (listing the candidate ids).
 */
export function resolveEndpointElementId(root: GModelRoot, spec: string): EndpointResolution {
    const trimmed = spec.trim();
    const ports = collectPorts(root);
    const dot = trimmed.indexOf('.');
    if (dot < 0 && trimmed !== '') {
        return resolveDiagramPort(ports, trimmed);
    }
    if (dot <= 0 || dot >= trimmed.length - 1) {
        return {
            ok: false,
            message: `Malformed endpoint '${spec}': expected 'nodeName.portName' (e.g. 'producer.out'), or the name of one of the diagram's own ports.`
        };
    }
    const nodeName = trimmed.slice(0, dot);
    const portName = trimmed.slice(dot + 1);

    const nodePorts = ports.filter((port) => port.ownerName === nodeName);
    if (nodePorts.length === 0) {
        const knownNodes = [...new Set(ports.map((port) => port.ownerName).filter((name): name is string => !!name))].sort();
        const known = knownNodes.length > 0 ? ` Known nodes: ${knownNodes.join(', ')}.` : '';
        return { ok: false, message: `No node named '${nodeName}' in the diagram.${known}` };
    }

    const matches = nodePorts.filter((port) => port.portName === portName);
    if (matches.length === 0) {
        const available = [...new Set(nodePorts.map((port) => port.portName).filter((name) => name !== ''))].sort();
        const list = available.length > 0 ? ` Ports on '${nodeName}': ${available.join(', ')}.` : ` Node '${nodeName}' has no named ports.`;
        return { ok: false, message: `No port named '${portName}' on node '${nodeName}'.${list}` };
    }
    if (matches.length > 1) {
        const ids = matches.map((port) => `${port.elementId}${port.direction ? ` (${port.direction})` : ''}`).join(', ');
        return {
            ok: false,
            message: `Endpoint '${spec}' is ambiguous — ${matches.length} matching ports [${ids}]. Pass the raw element id instead.`
        };
    }
    return { ok: true, elementId: matches[0].elementId };
}

/**
 * A bare name is one of the diagram's own ports (a workflow's input or output, drawn as a
 * boundary node): it has no node to name, so `nodeName.portName` cannot address it.
 */
function resolveDiagramPort(ports: readonly DiscoveredPort[], name: string): EndpointResolution {
    const matches = ports.filter((port) => port.ownerIsBoundary && port.ownerName === name);
    if (matches.length === 1) {
        return { ok: true, elementId: matches[0].elementId };
    }
    if (matches.length > 1) {
        const ids = matches.map((port) => `${port.elementId}${port.direction ? ` (${port.direction})` : ''}`).join(', ');
        return { ok: false, message: `The diagram port '${name}' is ambiguous — ${matches.length} matching ports [${ids}]. Pass the raw element id instead.` };
    }
    const own = [...new Set(ports.filter((port) => port.ownerIsBoundary).map((port) => port.ownerName).filter((each): each is string => !!each))].sort();
    const known = own.length > 0 ? ` The diagram's own ports: ${own.join(', ')}.` : ' The diagram has no ports of its own.';
    return { ok: false, message: `No diagram port named '${name}'; a node's port is 'nodeName.portName'.${known}` };
}
