/**
 * A third navigation target, for a diagram whose file nobody wrote.
 *
 * `cal:referencedUri` answers two questions at once — drill into this element,
 * and show me its source — and that works only while both have the same answer.
 * When a diagram is generated from something else they come apart: drilling has
 * to stay inside the generated file, because that is where the definitions being
 * drilled into live, while "show me the source" wants the file a person typed.
 * One slot means choosing which of the two features to break.
 *
 * These pin the shape of the third slot, and — more importantly — that adding it
 * changed nothing for a producer that does not use it.
 */

import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';

function transform(nodes: PyGraphNode[]): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph.children ?? [];
}

function nodeWith(meta: Record<string, unknown>): any {
    return transform([
        {
            id: 'node:a',
            kind: 'instance',
            label: 'a',
            scope: 'root',
            ports: [],
            meta
        }
    ]).find(child => child.id === 'a');
}

describe('an element authored in another file', () => {
    it('carries the authored file and line as their own metadata', () => {
        const node = nodeWith({ authoredSource: { file: '/work/src/Top.scala', line: 42 } });

        expect(node.args[WorkflowDiagramMetadata.AUTHORED_URI]).toBe('file:///work/src/Top.scala');
        expect(node.args[WorkflowDiagramMetadata.AUTHORED_SOURCE_RANGE]).toEqual({
            start: { line: 41, character: 0 },
            end: { line: 41, character: 0 }
        });
    });

    it('does not disturb where drilling goes', () => {
        // The whole point. `referencedSource` decides which document a
        // drill-down opens, and an authored file must not become that document
        // — a generated diagram would then try to open its own source text as a
        // diagram, which is not one.
        const node = nodeWith({
            referencedSource: { file: '/work/build/Top.fir', line: 3 },
            authoredSource: { file: '/work/src/Top.scala', line: 42 },
            referencedEntityName: 'Stage'
        });

        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBe('file:///work/build/Top.fir');
        expect(node.args[WorkflowDiagramMetadata.AUTHORED_URI]).toBe('file:///work/src/Top.scala');
    });

    it('is absent when the producer claims no separate authored file', () => {
        // Which is every existing product. An empty value here has to stay
        // empty rather than falling back to the diagram's own file, or the menu
        // would offer a third item that goes where the second one already does.
        const node = nodeWith({ source: { file: '/work/Top.py', line: 7 } });

        expect(node.args[WorkflowDiagramMetadata.AUTHORED_URI]).toBeUndefined();
        expect(node.args[WorkflowDiagramMetadata.AUTHORED_SOURCE_RANGE]).toBeUndefined();
    });

    it('needs both a file and a line to be offered at all', () => {
        // A half-populated locator is worse than none: it would navigate to the
        // top of a file the reader did not ask for.
        expect(nodeWith({ authoredSource: { file: '/work/src/Top.scala' } })
            .args[WorkflowDiagramMetadata.AUTHORED_URI]).toBeUndefined();
        expect(nodeWith({ authoredSource: { line: 42 } })
            .args[WorkflowDiagramMetadata.AUTHORED_URI]).toBeUndefined();
    });

    it('resolves a relative path the way every other locator is resolved', () => {
        // Not a new convention: the same normalisation the other two use, so a
        // producer does not have to learn a second rule for this slot.
        const node = nodeWith({ authoredSource: { file: 'src/Top.scala', line: 1 } });

        expect(node.args[WorkflowDiagramMetadata.AUTHORED_URI]).toMatch(/^file:\/\/\/.*src\/Top\.scala$/);
    });
});
