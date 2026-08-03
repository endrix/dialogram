import { describe, expect, it } from 'vitest';
import { GEdge, GGraph, GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { applyPersistedEdgeRoutes } from '../src/routing/persisted-edge-routes';

/**
 * A layout file stores absolute edge polylines but no node sizes — those are recomputed from the
 * source on every load. When the recomputed size differs from the one in effect when the layout
 * was saved (renamed port, changed sizing constant, older layout file), a verbatim replay of the
 * persisted polyline starts the edge where the port USED to be. On screen that is a gap between
 * the output-port marker and the beginning of the line.
 *
 * Reproduces the `motion.py` case: a legacy layout file whose `framebuf` node was 189px wide is
 * replayed against the current model where the same node is 140px wide.
 */
const PORT_WIDTH = 9;
const PORT_HEIGHT = 7;

function outputPort(id: string, nodeWidth: number, y: number): GPort {
    const port = GPort.builder()
        .id(id)
        .type(WorkflowDiagramTypes.PORT_OUTPUT)
        .position(nodeWidth, y)
        .size(PORT_WIDTH, PORT_HEIGHT)
        .build();
    port.args = { [WorkflowDiagramMetadata.PORT_DIRECTION]: 'output' };
    return port;
}

function inputPort(id: string, y: number): GPort {
    const port = GPort.builder()
        .id(id)
        .type(WorkflowDiagramTypes.PORT_INPUT)
        .position(-PORT_WIDTH, y)
        .size(PORT_WIDTH, PORT_HEIGHT)
        .build();
    port.args = { [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input' };
    return port;
}

function buildModel(sourceWidth: number, targetNodeY = 68): { root: GGraph; edge: GEdge } {
    const source = GNode.builder()
        .id('framebuf')
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .position(247, 68)
        .size(sourceWidth, 90)
        .addChildren(outputPort('framebuf.halfpel', sourceWidth, 30))
        .build();

    const target = GNode.builder()
        .id('interpolation')
        .type(WorkflowDiagramTypes.NODE_ACTOR)
        .position(544, targetNodeY)
        .size(140, 90)
        .addChildren(inputPort('interpolation.halfpel', 30))
        .build();

    const edge = GEdge.builder()
        .id('e1')
        .sourceId('framebuf.halfpel')
        .targetId('interpolation.halfpel')
        .build();
    edge.args = { [WorkflowDiagramMetadata.AST_PATH]: 'e:n:framebuf:halfpel->n:interpolation:halfpel:6' };

    const root = GGraph.builder().id('root').addChildren(source, target, edge).build();
    return { root, edge };
}

describe('applyPersistedEdgeRoutes', () => {
    it('re-snaps persisted endpoints onto the current port anchors', () => {
        // Layout saved when framebuf was 189 wide -> the route started at 247 + 189 + 9 = 445.
        const persisted = [
            { x: 445, y: 102 },
            { x: 535, y: 102 }
        ];
        // ...but the node is 140 wide now, so the anchor sits at 247 + 140 + 9 = 396.
        const { root, edge } = buildModel(140);

        applyPersistedEdgeRoutes(root, new Map([['e:n:framebuf:halfpel->n:interpolation:halfpel:6', persisted]]));

        const points = (edge as any).routingPoints as { x: number; y: number }[];
        expect(points[0]).toEqual({ x: 396, y: 101.5 });
        expect(points[points.length - 1]).toEqual({ x: 535, y: 101.5 });
    });

    it('keeps the leading and trailing segments orthogonal when the anchors moved', () => {
        const persisted = [
            { x: 445, y: 102 },
            { x: 490, y: 102 },
            { x: 490, y: 200 },
            { x: 535, y: 200 }
        ];
        // Target sits a layer lower, so the route genuinely needs the vertical jog.
        const { root, edge } = buildModel(140, 168);

        applyPersistedEdgeRoutes(root, new Map([['e:n:framebuf:halfpel->n:interpolation:halfpel:6', persisted]]));

        const points = (edge as any).routingPoints as { x: number; y: number }[];
        // Both anchors moved (source in x, target in y). The bends that shared the old endpoint
        // coordinate follow, so the staircase stays orthogonal instead of turning diagonal.
        expect(points).toEqual([
            { x: 396, y: 101.5 },
            { x: 490, y: 101.5 },
            { x: 490, y: 201.5 },
            { x: 535, y: 201.5 }
        ]);
    });

    it('leaves the persisted route untouched when an endpoint is not a port', () => {
        const persisted = [
            { x: 445, y: 102 },
            { x: 535, y: 102 }
        ];
        const { root, edge } = buildModel(140);
        (edge as any).sourceId = 'framebuf';

        applyPersistedEdgeRoutes(root, new Map([['e:n:framebuf:halfpel->n:interpolation:halfpel:6', persisted]]));

        expect((edge as any).routingPoints).toEqual(persisted);
    });
});
