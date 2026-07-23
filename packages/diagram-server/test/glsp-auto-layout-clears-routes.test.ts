import { describe, expect, it } from 'vitest';
import { GEdge, GGraph } from '@eclipse-glsp/server';
import { clearAllEdgeRoutingPoints } from '../src/routing/clear-edge-routes';

describe('GLSP auto layout', () => {
    it('clears edge routing points before running ELK layout', async () => {
        const edge = GEdge.builder().id('e1').type('edge:connection').sourceId('s').targetId('t').build();
        (edge as any).routingPoints = [
            { x: 1, y: 1 },
            { x: 2, y: 2 }
        ];
        edge.args = { 'cal:manualRoute': true } as any;

        const root = GGraph.builder().id('root').addChildren(edge).build();

        clearAllEdgeRoutingPoints(root);

        expect((edge as any).routingPoints).toBeUndefined();
        expect((edge as any).args?.['cal:manualRoute']).toBeUndefined();
    });
});
