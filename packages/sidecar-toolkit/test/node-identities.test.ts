import { describe, expect, it } from 'vitest';
import { graphPayloadToDoc } from '../src/server/graph-payload-to-doc';
import { nodeIdentitiesFromDoc } from '../src/server/sidecar-model-source';

/**
 * The identities a nested workflow is searched by, when a run's active instance
 * is not drawn in the view: the workflow that holds it lights up. A unit's own
 * ports are not instances, and a port named like a running instance elsewhere
 * would light the wrong workflow, or make two match and light none.
 */
describe('node identities', () => {
    it('leaves out the input and output nodes of a plan document', () => {
        const doc = {
            version: '1.1',
            graph: {
                id: 'wf:inner',
                nodes: [
                    { id: 'wf:input:review', kind: 'wf-input', label: 'review', scope: 'scope:root', ports: [] },
                    { id: 'wf:output:Out', kind: 'wf-output', label: 'Out', scope: 'scope:root', ports: [] },
                    { id: 'writer', kind: 'agent', label: 'writer', type: 'Writer', scope: 'scope:root', ports: [] }
                ],
                edges: []
            }
        };
        expect(nodeIdentitiesFromDoc(doc)).toEqual([{ instanceName: 'writer', definitionName: 'Writer' }]);
    });

    it('leaves them out of a static export, where they are listed as nodes too', () => {
        const payload = {
            workflow: 'inner',
            nodes: [
                {
                    id: 'wf:input:review',
                    kind: 'wf-input',
                    label: 'review',
                    scope: 'scope:root',
                    nodeId: 'wf:input:review',
                    ports: [{ id: 'wf:review', name: 'review', direction: 'out', type: 'str', role: 'data' }]
                },
                { id: 'writer', ref: 'Writer', kind: 'task', nodeId: 'n:writer' }
            ],
            edges: []
        };
        expect(nodeIdentitiesFromDoc(graphPayloadToDoc(payload))).toEqual([{ instanceName: 'writer' }]);
    });

    it('has no list for a document with no nodes', () => {
        expect(nodeIdentitiesFromDoc({ version: '1.1' })).toBeUndefined();
    });
});
