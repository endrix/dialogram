/**
 * "Go to source" on a boundary port.
 *
 * The graph schema gives every port a `source: { file, line }`, and an entity's
 * port has always carried it into the model (see `mkPort`) — that is what the
 * go-to-source context menu reads. `createBoundaryNode` took the `name` and the
 * `type` off the very same port object and dropped `source` on the floor, so a
 * network's own inputs and outputs were the one kind of port you could not
 * navigate from. Nothing reported it as broken because nothing offered it.
 *
 * The metadata is deliberately the same triple the entity ports emit, so both
 * kinds of port travel the one navigation path rather than growing a second.
 */
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import * as path from 'node:path';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

/** A one-node graph whose only content is a boundary input port. */
function docWithBoundaryInput(source?: { file?: string; line?: number }): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [
                {
                    id: 'wf:input:Alloc',
                    kind: 'wf-input',
                    label: 'Alloc',
                    scope: 'root',
                    ports: [
                        {
                            id: 'port:wf:input:Alloc:out',
                            name: 'Alloc',
                            direction: 'out',
                            type: 'RobAlloc',
                            source
                        }
                    ]
                }
            ],
            edges: []
        }
    };
}

/** The single boundary node in a transformed graph. */
function boundaryNodeOf(doc: PyGraphDocument): any {
    const result = new GraphGModelSource().transform(doc);
    const node = result.graph.children?.find(
        (child: any) => child.args?.['wf:boundaryKind'] !== undefined
    );
    expect(node, 'no boundary node in the transformed graph').toBeDefined();
    return node;
}

describe('boundary port navigation metadata', () => {
    it('carries the port declaration site through to the model', () => {
        const node = boundaryNodeOf(docWithBoundaryInput({ file: '/w/pipeline.py', line: 12 }));

        // Line numbers arrive 1-based from the sidecar and are stored 0-based,
        // matching what the entity ports emit.
        const at = { start: { line: 11, character: 0 }, end: { line: 11, character: 0 } };
        expect(node.args[WorkflowDiagramMetadata.SOURCE_RANGE]).toEqual(at);
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]).toEqual(at);
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBe(
            URI.file(path.resolve('/w/pipeline.py')).toString()
        );
    });

    it('leaves the port identity alone', () => {
        const node = boundaryNodeOf(docWithBoundaryInput({ file: '/w/pipeline.py', line: 12 }));

        expect(node.args[WorkflowDiagramMetadata.PORT_NAME]).toBe('Alloc');
        expect(node.args[WorkflowDiagramMetadata.PORT_TYPE]).toBe('RobAlloc');
        expect(node.args['wf:boundaryKind']).toBe('input');
    });

    /**
     * A port whose source the sidecar could not resolve must not produce a
     * navigation target at all — an entry pointing nowhere would offer the menu
     * item and then fail on click.
     */
    it('emits nothing navigable when the sidecar gave no source', () => {
        const node = boundaryNodeOf(docWithBoundaryInput(undefined));

        expect(node.args[WorkflowDiagramMetadata.SOURCE_RANGE]).toBeUndefined();
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBeUndefined();
    });

    it('emits nothing navigable when the source has a file but no line', () => {
        const node = boundaryNodeOf(docWithBoundaryInput({ file: '/w/pipeline.py' }));

        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBeUndefined();
    });
});
