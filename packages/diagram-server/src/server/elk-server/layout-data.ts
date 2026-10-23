/**
 * The ELK server's answer, and writing it back into the graph that was sent.
 *
 * The server answers with a map from element id to its position and size, or
 * to its route for an edge, rather than the laid-out graph elkjs returns; this
 * puts each value where elkjs would have, so the layout engine reads the
 * result the same way from either. From mlir-viewer's
 * `packages/glsp-server/src/layout/elk-layout-data.ts`.
 */
import type { ElkNode } from 'elkjs';

export interface LayoutData {
    [id: string]: LayoutElement;
}

export type LayoutElement = ShapeLayoutElement | EdgeLayoutElement;

export interface ShapeLayoutElement {
    position: { x: number; y: number };
    size?: { width: number; height: number };
}

export interface EdgeLayoutElement {
    route: Array<{ x: number; y: number }>;
}

export function isShapeLayout(element: unknown): element is ShapeLayoutElement {
    return (
        typeof element === 'object' &&
        element !== null &&
        (element as ShapeLayoutElement).position !== undefined
    );
}

export function isEdgeLayout(element: unknown): element is EdgeLayoutElement {
    return (
        typeof element === 'object' &&
        element !== null &&
        (element as EdgeLayoutElement).route !== undefined
    );
}

/**
 * Apply the given layout data received from an ELK server to the original graph.
 */
export function applyLayoutData(data: LayoutData, node: ElkNode): void {
    const dataElem = data[node.id as string];
    if (isShapeLayout(dataElem)) {
        applyShapeLayout(dataElem, node);
    }
    if (node.ports) {
        for (const port of node.ports) {
            const portDataElem = data[port.id as string];
            if (isShapeLayout(portDataElem)) {
                applyShapeLayout(portDataElem, port);
            }
            if (port.labels) {
                for (const label of port.labels) {
                    const labelDataElem = label.id && data[label.id];
                    if (isShapeLayout(labelDataElem)) {
                        applyShapeLayout(labelDataElem, label);
                    }
                }
            }
        }
    }
    if (node.labels) {
        for (const label of node.labels) {
            const labelDataElem = label.id && data[label.id];
            if (isShapeLayout(labelDataElem)) {
                applyShapeLayout(labelDataElem, label);
            }
        }
    }
    if (node.edges) {
        for (const edge of node.edges) {
            const edgeDataElem = data[edge.id as string];
            if (isEdgeLayout(edgeDataElem)) {
                applyEdgeLayout(edgeDataElem, edge);
            }
            if (edge.labels) {
                for (const label of edge.labels) {
                    const labelDataElem = label.id && data[label.id];
                    if (isShapeLayout(labelDataElem)) {
                        applyShapeLayout(labelDataElem, label);
                    }
                }
            }
        }
    }
    if (node.children) {
        for (const child of node.children) {
            applyLayoutData(data, child);
        }
    }
}

function applyShapeLayout(
    dataElem: ShapeLayoutElement,
    shape: { x?: number; y?: number; width?: number; height?: number }
): void {
    shape.x = dataElem.position.x;
    shape.y = dataElem.position.y;
    if (dataElem.size) {
        shape.width = dataElem.size.width;
        shape.height = dataElem.size.height;
    }
}

function applyEdgeLayout(dataElem: EdgeLayoutElement, edge: any): void {
    const { route } = dataElem;
    if (edge.sections && edge.sections.length > 0) {
        const section = edge.sections[0];
        if (route.length >= 1) {
            section.startPoint = route[0];
        }
        section.bendPoints = route.slice(1, -1);
        if (route.length >= 2) {
            section.endPoint = route[route.length - 1];
        }
    } else if (isPrimitiveEdge(edge)) {
        if (route.length >= 1) {
            edge.sourcePoint = route[0];
        }
        edge.bendPoints = route.slice(1, -1);
        if (route.length >= 2) {
            edge.targetPoint = route[route.length - 1];
        }
    } else {
        edge.sections = [
            {
                id: `${edge.id}:layout`,
                startPoint: route[0],
                bendPoints: route.slice(1, -1),
                endPoint: route[route.length - 1]
            }
        ];
    }
}

function isPrimitiveEdge(edge: any): boolean {
    return typeof edge.source === 'string' && typeof edge.target === 'string';
}
