/**
 * The chat's untangle: the agent lays the diagram out a few ways (Free Ports
 * first, the instances of a definition sharing one port order), keeps what
 * cuts the crossings, and proposes one try to the person, who applies it (the
 * port orders written into the source, the layout saved) or discards it.
 *
 * What a session of it holds, one per diagram: the drawing the diagram had
 * when it began (put back on Discard and on undo), Layout Diagram's drawing to
 * compare with, and each try, at most {@link MAX_TRIES}. Nothing of it is
 * saved; a reload of the diagram (its source changed) ends it.
 */
import { GNode, GPort, type GModelElement, type ModelState } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { definitionNameOf, definitionsUnder, gportSide, lastProbe, portNameOf, sidesOf, type SideOrder } from '@dialogram/diagram-server/model/definition-port-order';
import type { PreviewLayout } from '@dialogram/diagram-server/operations/layout-preview';
import type { LayoutGeometry } from '@dialogram/diagram-server/server/layout-snapshot';

/** At most this many tries per untangle. */
export const MAX_TRIES = 10;

/** One definition's ports, as a try drew them. */
export interface DrawnDefinition {
    name: string;
    /** Its instances' names. */
    instances: string[];
    /** One of its instances: where its file is found from. */
    elementId: string;
    drawn: Required<SideOrder>;
    declared: Required<SideOrder>;
    /** Each instance's order on its own, as the Free Ports probe found it, by instance name. */
    alone?: Record<string, Required<SideOrder>>;
    /** Its instances are not all drawn in one order (a port name repeats on a side). */
    disagree?: true;
    /**
     * Its name and file are another group's too, drawn with other ports (a
     * bus open on one instance): one port order cannot be written for both.
     */
    split?: true;
}

export interface UntangleTry {
    n: number;
    layout: PreviewLayout;
    given: Record<string, SideOrder>;
    crossings: number;
    picture?: string;
    geometry: LayoutGeometry;
    definitions: DrawnDefinition[];
}

export interface UntangleState {
    /** The model it began on: another (a reload) ends it. */
    root: object;
    /** The drawing before it began. */
    original: LayoutGeometry;
    baseline: { crossings: number; picture?: string; definitions: DrawnDefinition[] };
    tries: UntangleTry[];
    /** The try put to the person, while they decide. */
    proposed?: number;
    /** What Apply did: the files it wrote, or why it wrote none. */
    applied?: { ok: boolean; files: string[]; message?: string };
}

const states = new WeakMap<ModelState, UntangleState>();

/** The untangle going on in this diagram; nothing when none is, or its model was reloaded since. */
export function untangleOf(modelState: ModelState): UntangleState | undefined {
    const state = states.get(modelState);
    if (state && state.root !== modelState.root) {
        states.delete(modelState);
        return undefined;
    }
    return state;
}

export function beginUntangle(modelState: ModelState, state: UntangleState): void {
    states.set(modelState, state);
}

export function endUntangle(modelState: ModelState): void {
    states.delete(modelState);
}

function sameSides(a: Required<SideOrder>, b: Required<SideOrder>): boolean {
    return a.west.join('\u0000') === b.west.join('\u0000') && a.east.join('\u0000') === b.east.join('\u0000');
}

function instanceName(node: GNode): string {
    const name = (node.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.ENTITY_NAME];
    return typeof name === 'string' && name.trim() !== '' ? name : node.id;
}

/**
 * Each definition under `root` whose ports may be reordered, as drawn now:
 * its instances, the order they are drawn in and the one declared, and, after
 * a Free Ports layout, the order each would have had on its own.
 */
export function drawnDefinitions(root: GModelElement): DrawnDefinition[] {
    const probe = lastProbe(root);
    const groups = [...definitionsUnder(root).values()];
    const sourceOf = (node: GNode): string => {
        const args = node.args as Record<string, unknown> | undefined;
        return `${definitionNameOf(node) ?? node.id}\u0000${String(args?.[WorkflowDiagramMetadata.REFERENCED_URI] ?? '')}`;
    };
    const groupsOfSource = new Map<string, number>();
    for (const nodes of groups) {
        groupsOfSource.set(sourceOf(nodes[0]), (groupsOfSource.get(sourceOf(nodes[0])) ?? 0) + 1);
    }
    const result: DrawnDefinition[] = [];
    for (const nodes of groups) {
        const first = nodes[0];
        const drawn = sidesOf(first, 'drawn');
        const alone = probe && nodes.length > 1
            ? Object.fromEntries(nodes.filter(node => probe.has(node.id)).map(node => [instanceName(node), probe.get(node.id)!]))
            : undefined;
        result.push({
            name: definitionNameOf(first) ?? first.id,
            instances: nodes.map(instanceName),
            elementId: first.id,
            drawn,
            declared: sidesOf(first, 'declared'),
            ...(alone && Object.keys(alone).length > 0 ? { alone } : {}),
            ...(nodes.some(node => !sameSides(sidesOf(node, 'drawn'), drawn)) ? { disagree: true as const } : {}),
            ...((groupsOfSource.get(sourceOf(first)) ?? 0) > 1 ? { split: true as const } : {})
        });
    }
    return result.sort((a, b) => b.instances.length - a.instances.length || a.name.localeCompare(b.name));
}

/** Whether the order `definition` is drawn in can be written: one order, for it alone. */
export function writable(definition: DrawnDefinition): boolean {
    return !definition.disagree && !definition.split;
}

/** Whether `definition` is drawn in another order than its source declares. */
export function reordered(definition: DrawnDefinition): boolean {
    return !sameSides(definition.drawn, definition.declared);
}

/** `sides` as the agent and the person read them: left (inputs), right (outputs). */
export function sidesText(sides: SideOrder): string {
    return [
        ...(sides.west && sides.west.length > 0 ? [`left ${sides.west.join(', ')}`] : []),
        ...(sides.east && sides.east.length > 0 ? [`right ${sides.east.join(', ')}`] : [])
    ].join('; ');
}

/**
 * The full order to write for `node`'s definition so that it is drawn as
 * `sides`: its ports as its source declares them (the node's ports in their
 * own order, which is the declaration's), each left port's place taken by the
 * next of `sides.west`, each right port's by the next of `sides.east`. Inputs
 * and outputs keep the places they had among each other.
 */
export function orderToWrite(node: GNode, sides: Required<SideOrder>): string[] {
    const next = { WEST: [...sides.west], EAST: [...sides.east] };
    return (node.children ?? [])
        .filter((child): child is GPort => child instanceof GPort)
        .map(port => {
            const name = portNameOf(node, port);
            const side = gportSide(port);
            return side === 'WEST' || side === 'EAST' ? next[side].shift() ?? name : name;
        });
}
