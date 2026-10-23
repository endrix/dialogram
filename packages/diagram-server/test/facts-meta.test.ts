/**
 * A producer's facts, passed through and never read.
 *
 * `meta.facts` is a list of labelled values the producer states about a unit
 * — whatever it knows that a reader would want beside the node. The platform
 * has no vocabulary for them: no label is recognised, none is required, and
 * the order on the way out is the order on the way in. What it does do is
 * check the shape once, here, so that one malformed entry costs the producer
 * that entry and not the section, and no reader downstream has to defend
 * against it again.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWith(nodeMeta?: Record<string, unknown>, graphMeta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            meta: graphMeta,
            nodes: [{
                id: 'node:adder',
                kind: 'task',
                label: 'adder',
                scope: 'root',
                meta: nodeMeta,
                ports: [{ id: 'p', name: 'stimulus', direction: 'in' }]
            }],
            edges: []
        }
    } as PyGraphDocument;
}

const transform = (doc: PyGraphDocument) => new GraphGModelSource({} as any).transform(doc).graph;

const nodeFacts = (meta?: Record<string, unknown>): unknown => {
    const node: any = transform(docWith(meta)).children?.find((child: any) => child.id === 'adder');
    return node?.args?.[WorkflowDiagramMetadata.FACTS];
};

describe('a node’s facts', () => {
    it('reach the node’s args as the producer listed them, in its order', () => {
        const facts = [
            { label: 'Clock', value: '200 MHz' },
            { label: 'Area', value: '12 LUT' },
            { label: 'Notes', value: 'see **below**', markdown: true }
        ];

        expect(nodeFacts({ facts })).toEqual(facts);
    });

    it('drop an entry without a string label and a string value, keeping the rest', () => {
        const facts = nodeFacts({
            facts: [
                { label: 'Clock', value: '200 MHz' },
                { label: 'Area' },
                { value: 'orphaned' },
                { label: 'Depth', value: 3 },
                'not an object',
                null,
                { label: 'Revision', value: 'r7' }
            ]
        });

        expect(facts).toEqual([
            { label: 'Clock', value: '200 MHz' },
            { label: 'Revision', value: 'r7' }
        ]);
    });

    it('keep `markdown` only when it is exactly true', () => {
        // A truthy string is not the flag: `markdown: 'yes'` would otherwise
        // render a value as Markdown that the producer never marked up.
        expect(nodeFacts({ facts: [{ label: 'A', value: 'x', markdown: 'yes' }] }))
            .toEqual([{ label: 'A', value: 'x' }]);
    });

    it('are absent when the producer gave none, or none that were well-formed', () => {
        expect(nodeFacts()).toBeUndefined();
        expect(nodeFacts({ facts: [] })).toBeUndefined();
        expect(nodeFacts({ facts: 'Clock: 200 MHz' })).toBeUndefined();
        expect(nodeFacts({ facts: [{ label: 'Clock' }] })).toBeUndefined();
    });
});

describe('the facts of the unit shown', () => {
    it('reach the root’s args from `graph.meta.facts`', () => {
        const graph: any = transform(docWith(undefined, {
            facts: [{ label: 'Top', value: 'yes' }, { label: 'Cells', value: '1,204' }]
        }));

        expect(graph.args?.[WorkflowDiagramMetadata.FACTS]).toEqual([
            { label: 'Top', value: 'yes' },
            { label: 'Cells', value: '1,204' }
        ]);
    });

    it('are absent from the root when the graph states none', () => {
        const graph: any = transform(docWith());

        expect(graph.args?.[WorkflowDiagramMetadata.FACTS]).toBeUndefined();
    });
});
