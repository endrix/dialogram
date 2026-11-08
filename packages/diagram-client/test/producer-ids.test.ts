/**
 * One lookup of a diagram element by a producer's id, for the outline, the
 * property panel and the headless renderer.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { findNodeIdByGraphId } from '../src/producer-ids';

const node = (id: string, graphId: string | undefined, ...children: unknown[]) => ({
    id,
    type: 'node:actor',
    args: graphId === undefined ? {} : { [WorkflowDiagramMetadata.GRAPH_NODE_ID]: graphId },
    children
});
const port = (id: string) => ({ id, type: 'port:output', args: {}, children: [] });

describe('findNodeIdByGraphId', () => {
    it('finds a node by its producer id, and by its own id when no producer id matches', () => {
        const root = { id: 'root', type: 'graph', children: [node('Issue contract', 'PIPE-001'), node('Settle', undefined)] };
        expect(findNodeIdByGraphId(root, 'PIPE-001')).toBe('Issue contract');
        expect(findNodeIdByGraphId(root, 'Settle')).toBe('Settle');
        expect(findNodeIdByGraphId(root, 'PIPE-404')).toBeUndefined();
    });

    it('lets the producer id win over another node that merely carries it as its diagram id', () => {
        // Diagram ids are labels: node B is labelled "merge", node A's producer id is "merge".
        const root = { id: 'root', type: 'graph', children: [node('merge', 'n7'), node('Merge A', 'merge')] };
        expect(findNodeIdByGraphId(root, 'merge')).toBe('Merge A');
    });

    it('never answers with a port, label or compartment that carries the id', () => {
        const root = { id: 'root', type: 'graph', children: [node('a', 'A', port('X')), node('X', undefined)] };
        expect(findNodeIdByGraphId(root, 'X')).toBe('X');
        const portsOnly = { id: 'root', type: 'graph', children: [node('a', 'A', port('X'))] };
        expect(findNodeIdByGraphId(portsOnly, 'X')).toBeUndefined();
    });

    it('takes the first match in document order', () => {
        const root = { id: 'root', type: 'graph', children: [node('first', 'dup'), node('second', 'dup')] };
        expect(findNodeIdByGraphId(root, 'dup')).toBe('first');
    });

    it('walks a very wide root without a spread of its children', () => {
        const children = Array.from({ length: 200_000 }, (_, i) => node(`n${i}`, `g${i}`));
        const root = { id: 'root', type: 'graph', children };
        expect(findNodeIdByGraphId(root, 'g199999')).toBe('n199999');
    });
});
