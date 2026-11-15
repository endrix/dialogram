/**
 * The states a reader placed in a view that nothing is written of yet
 * (unwritten-states.ts): held by the editor with the view's layout, drawn
 * among the producer's states where they were placed, and not drawn twice
 * once the producer has written one.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { UNWRITTEN_STATE_ID_PREFIX, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { placeHeldStates, withUnwrittenStates } from '../src/model/unwritten-states';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';
import { WorkflowDiagramConfiguration } from '../src/server/diagram-configuration';

function view(meta: Record<string, unknown> = { readOnly: true, edits: ['state', 'transition'] }): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            meta,
            nodes: [
                { id: 'state:idle', kind: 'state', label: 'idle', scope: 'scope:root', ports: [], meta: { state: 'idle' } },
                { id: 'state:run', kind: 'state', label: 'run', scope: 'scope:root', ports: [], meta: { state: 'run' } }
            ],
            edges: []
        }
    } as PyGraphDocument;
}

const held = new Map([['waiting', { x: 300, y: 80 }], ['run', { x: 10, y: 10 }]]);

describe('a state the editor holds', () => {
    it('is drawn among the producer\'s states, as a state of that name the producer has not written', () => {
        const nodes = withUnwrittenStates(view(), held).graph.nodes;
        expect(nodes.map(node => [node.id, node.meta?.['state'], node.meta?.['unwritten']])).toEqual([
            ['state:idle', 'idle', undefined],
            ['state:run', 'run', undefined],
            [UNWRITTEN_STATE_ID_PREFIX + 'waiting', 'waiting', true]
        ]);
        const graph: any = new GraphGModelSource({} as any).transform(withUnwrittenStates(view(), held)).graph;
        const waiting = graph.children.find((child: any) => child.args?.[WorkflowDiagramMetadata.STATE_NAME] === 'waiting');
        expect(waiting.type).toBe(WorkflowDiagramTypes.NODE_STATE);
        expect(waiting.args[WorkflowDiagramMetadata.STATE_UNWRITTEN]).toBe(true);
    });

    it('is not drawn in a view that takes no states', () => {
        for (const meta of [{ readOnly: true, edits: ['transition'] }, { edits: ['state'] }]) {
            expect(withUnwrittenStates(view(meta), held).graph.nodes).toHaveLength(2);
        }
    });

    it('is drawn where it was placed, and a written one it held too, unless the view has a place for it', () => {
        const graph: any = new GraphGModelSource({} as any).transform(withUnwrittenStates(view(), held)).graph;
        const keyOf = (name: string) => graph.children.find((child: any) => child.args?.[WorkflowDiagramMetadata.STATE_NAME] === name)
            .args[WorkflowDiagramMetadata.AST_PATH];
        const positions = new Map([[keyOf('idle'), { x: 0, y: 0 }]]);
        placeHeldStates(graph, held, positions);
        expect(positions.get(keyOf('waiting'))).toEqual({ x: 300, y: 80 });
        expect(positions.get(keyOf('run'))).toEqual({ x: 10, y: 10 });
        const placed = new Map([[keyOf('run'), { x: 50, y: 50 }]]);
        placeHeldStates(graph, held, placed);
        expect(placed.get(keyOf('run'))).toEqual({ x: 50, y: 50 });
    });

    it('can be picked for a delete, as any state can: what a delete of one does is the server\'s to say', () => {
        // The client leaves out of a delete what its type hint says is not deletable.
        const hint = new WorkflowDiagramConfiguration().shapeTypeHints.find(h => h.elementTypeId === WorkflowDiagramTypes.NODE_STATE);
        expect(hint?.deletable).toBe(true);
        expect(hint?.repositionable).toBe(true);
    });

    it('is kept with the view\'s layout, per view, and a save of positions keeps it', async () => {
        const file = path.join(mkdtempSync(path.join(tmpdir(), 'unwritten-states-')), 'counter.py');
        const store = new LayoutPersistenceService(0);
        expect(await store.loadUnwrittenStates(file, 'Counter@actor')).toEqual(new Map());
        await store.saveUnwrittenStates(file, 'Counter@actor', held);
        await store.saveLayout(file, 'Counter@actor', new Map([['state:idle', { x: 1, y: 2 }]]));
        await store.flush();
        const again = new LayoutPersistenceService(0);
        expect(await again.loadUnwrittenStates(file, 'Counter@actor')).toEqual(held);
        expect(await again.loadUnwrittenStates(file, 'Counter@network')).toEqual(new Map());
        expect((await again.loadLayout(file, 'Counter@actor'))?.get('state:idle')).toEqual({ x: 1, y: 2 });
        await again.saveUnwrittenStates(file, 'Counter@actor', new Map());
        expect(await new LayoutPersistenceService(0).loadUnwrittenStates(file, 'Counter@actor')).toEqual(new Map());
    });
});
