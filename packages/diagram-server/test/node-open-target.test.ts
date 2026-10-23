/**
 * A node that stands for a file: the producer's `meta.open`.
 *
 * `{ file, line? }` becomes `wf:open` on the node, the file as a URI, which a
 * double-click opens (diagram-client `open-target.ts`). Anything malformed is
 * left off rather than half-mapped, and editable parameters pass through with
 * the choices and suggestions the panel needs.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const nodeWith = (meta: Record<string, unknown>): any => {
    const doc: PyGraphDocument = {
        version: '1',
        graph: { id: 'root', nodes: [{ id: 'node:clause', kind: 'source', label: 'clause', scope: 'root', meta, ports: [] }], edges: [] }
    };
    return new GraphGModelSource().transform(doc).graph.children?.find((c: any) => c.id === 'clause');
};

describe('the file a node stands for', () => {
    it('is the producer’s file as a URI, with its line', () => {
        const node = nodeWith({ open: { file: '/w/gen/membus/memif.py', line: 42 } });

        expect(node.args[WorkflowDiagramMetadata.OPEN_TARGET]).toEqual({ uri: 'file:///w/gen/membus/memif.py', line: 42 });
    });

    it('keeps the file without a usable line, and drops what is not a file', () => {
        expect(nodeWith({ open: { file: '/w/a.py', line: 0 } }).args[WorkflowDiagramMetadata.OPEN_TARGET]).toEqual({ uri: 'file:///w/a.py' });
        expect(nodeWith({ open: { line: 3 } }).args?.[WorkflowDiagramMetadata.OPEN_TARGET]).toBeUndefined();
        expect(nodeWith({ open: '/w/a.py' }).args?.[WorkflowDiagramMetadata.OPEN_TARGET]).toBeUndefined();
    });

    it('leaves editable parameters as the producer wrote them, choices and all', () => {
        const parameters = [{ name: 'status', value: 'draft', editable: true, choices: ['draft', 'active'] }];

        expect(nodeWith({ parameters }).args[WorkflowDiagramMetadata.ENTITY_PARAMETERS]).toEqual(parameters);
    });
});
