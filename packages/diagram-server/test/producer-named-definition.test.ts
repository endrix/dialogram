/**
 * A producer that resolved a node's type itself (`meta.referencedSource`)
 * names its definition: the node says so, and "Go to Source" tells the host,
 * which then opens the target without asking the language tooling.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';

function nodeWith(meta: Record<string, unknown>): any {
    const doc: PyGraphDocument = {
        version: '1',
        graph: { id: 'root', nodes: [{ id: 'node:a', kind: 'instance', label: 'a', scope: 'root', ports: [], meta }], edges: [] }
    };
    return (new GraphGModelSource().transform(doc).graph.children ?? []).find((child: any) => child.id === 'a');
}

function goToSource(args: Record<string, unknown>): any {
    const root: any = { id: 'root', type: 'graph', args: {} };
    const node: any = { id: 'n', type: WorkflowDiagramTypes.NODE_ACTOR, args, parent: root };
    const provider: any = new WorkflowContextMenuItemProvider();
    provider.modelState = { sourceUri: 'file:///w/top.py', root, index: { find: () => node } };
    return provider.getItems(['n'], { x: 0, y: 0 }).find((item: any) => item.id === 'dialogram.goToSource')?.actions[0];
}

describe('a node whose producer named its definition', () => {
    it('says the referenced target is the definition', () => {
        const node = nodeWith({ source: { file: '/w/top.py', line: 9 }, referencedSource: { file: '/w/lib/actors.py', line: 4 } });
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBe('file:///w/lib/actors.py');
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]).toBe(true);
    });

    it('does not say so when it only knows where the node is written', () => {
        const node = nodeWith({ source: { file: '/w/top.py', line: 9 } });
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_URI]).toBe('file:///w/top.py');
        expect(node.args[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]).toBeUndefined();
    });

    it('sends that on with Go to Source, and not for a target that is only a place in the file', () => {
        const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } };
        const referenced = {
            [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/lib/actors.py',
            [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: range
        };
        const named = goToSource({ ...referenced, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true });
        expect(named.target.uri).toBe('file:///w/lib/actors.py');
        expect(named.target.args['wf:navigateTargetIsDefinition']).toBe(true);
        expect(goToSource(referenced).target.args['wf:navigateTargetIsDefinition']).toBeUndefined();
    });
});
