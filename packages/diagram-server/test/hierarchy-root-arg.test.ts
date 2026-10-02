/**
 * The hierarchy a view is part of reaches the client on the root model, as
 * `wf:hierarchy`: plain JSON the outline renders without laying anything out.
 */
import { describe, expect, it } from 'vitest';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const doc = (hierarchy?: unknown): PyGraphDocument => ({
    version: '1',
    graph: { id: 'root', nodes: [], edges: [] },
    ...(hierarchy ? { hierarchy } : {})
});

describe('the hierarchy on the root model', () => {
    it('is published as JSON when the graph carries one', () => {
        const outline = { path: [], workflowName: 'top', children: [{ path: ['b1'], workflowName: 'block', children: [] }] };
        const root: any = new GraphGModelSource({} as any).transform(doc(outline)).graph;

        expect(JSON.parse(root.args['wf:hierarchy'])).toEqual(outline);
    });

    it('is absent otherwise', () => {
        const root: any = new GraphGModelSource({} as any).transform(doc()).graph;
        expect(root.args?.['wf:hierarchy']).toBeUndefined();
    });
});
