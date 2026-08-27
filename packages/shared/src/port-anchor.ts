/**
 * Where an edge attaches to a port.
 *
 * This lives in shared for one reason: the client and the server must agree
 * EXACTLY. The server routes on commit, the client routes live during a drag,
 * and if the two compute anchors differently the edge visibly jumps the moment
 * the mouse is released — which is precisely why `views.ts` gave up on the
 * client router and rendered the server's polyline instead ("computes its own
 * source/target anchors using a different algorithm ... which creates
 * near-duplicate endpoint segments and visual artifacts").
 *
 * So the geometry is defined once, here, as a pure function. Each side supplies
 * its own element traversal — GPort on the server, SPortImpl in the webview —
 * and neither gets to have an opinion about the arithmetic.
 */

import { WorkflowDiagramConstants } from './diagram-constants';

export type PortSide = 'WEST' | 'EAST';

export interface PortAnchorGeometry {
    /** Port position in absolute diagram coordinates (top-left of the port box). */
    absolute: { x: number; y: number };
    /** Port box size. Falls back to the shared constants when absent or zero. */
    size?: { width?: number; height?: number };
    /** `cal:portDirection`, when the model carries it. */
    direction?: string;
    /** The element type, used only when `direction` is missing or unrecognised. */
    type?: string;
}

export interface PortAnchor {
    x: number;
    y: number;
    side: PortSide;
}

/**
 * Which side of its node a port sits on.
 *
 * `direction` wins when it is one of the two values the model uses; otherwise
 * fall back to the type string. An unrecognised port is treated as an input,
 * matching the model's own default.
 */
export function portSide(geometry: PortAnchorGeometry): PortSide {
    const { direction, type } = geometry;
    if (direction === 'output') {
        return 'EAST';
    }
    if (direction === 'input') {
        return 'WEST';
    }
    if (typeof type === 'string') {
        if (type.includes('output')) {
            return 'EAST';
        }
        if (type.includes('input')) {
            return 'WEST';
        }
    }
    return 'WEST';
}

/**
 * The point on the port's outer edge that an edge attaches to: the middle of
 * the side the port faces.
 */
export function portAnchor(geometry: PortAnchorGeometry): PortAnchor {
    const rawWidth = geometry.size?.width;
    const rawHeight = geometry.size?.height;
    const width = typeof rawWidth === 'number' && rawWidth > 0
        ? rawWidth
        : WorkflowDiagramConstants.PORT_WIDTH_PX;
    const height = typeof rawHeight === 'number' && rawHeight > 0
        ? rawHeight
        : WorkflowDiagramConstants.PORT_HEIGHT_PX;

    const side = portSide(geometry);
    return {
        x: side === 'EAST' ? geometry.absolute.x + width : geometry.absolute.x,
        y: geometry.absolute.y + height / 2,
        side
    };
}
