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
    const visit = (element: GModelElement, ownerName: string | undefined): void => {
        const type = element.type;
        let currentOwner = ownerName;
        if (typeof type === 'string' && type.startsWith('node:')) {
            // Task/actor nodes carry an instance name; boundary nodes carry a port name identity.
            currentOwner = argString(element, ENTITY_NAME) ?? argString(element, PORT_NAME) ?? currentOwner;
        }
        if (typeof type === 'string' && type.startsWith('port:')) {
            ports.push({
                elementId: element.id,
                portName: argString(element, PORT_NAME) ?? '',
                ownerName: currentOwner,
                direction: argString(element, PORT_DIRECTION)
            });
        }
        for (const child of (element.children ?? []) as GModelElement[]) {
            visit(child, currentOwner);
        }
    };
    visit(root, undefined);
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
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot >= trimmed.length - 1) {
        return {
            ok: false,
            message: `Malformed endpoint '${spec}': expected 'nodeName.portName' (e.g. 'producer.out').`
        };
    }
    const nodeName = trimmed.slice(0, dot);
    const portName = trimmed.slice(dot + 1);

    const ports = collectPorts(root);
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
