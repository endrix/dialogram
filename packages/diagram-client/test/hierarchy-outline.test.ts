/**
 * The hierarchy outline: a tree of every workflow instance under the editor's
 * root, after mlir-viewer's file outline. Its helpers are pure, so the tree,
 * the filter and the trail a row opens are tested headlessly.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, type HierarchyOutlineEntry } from '@dialogram/shared';
import {
    ancestorIds,
    entryAt,
    foreignFileName,
    outlineMatches,
    pathOfTrail,
    rowId,
    rowLabel,
    trailTo
} from '../src/hierarchy-outline-tree';
import { findNodeIdByEntityName, trailOfRoot } from '../src/hierarchy-outline';

const TOP = 'file:///w/top.py';
const BLOCK = 'file:///w/layers/block.py';
const outline: HierarchyOutlineEntry = {
    path: [], workflowName: 'top', sourceUri: TOP, nodeCount: 2,
    children: [
        {
            path: ['b1'], workflowName: 'block', sourceUri: BLOCK, nodeCount: 3,
            children: [{ path: ['b1', 'leaf'], workflowName: 'stage', sourceUri: BLOCK, children: [] }]
        },
        { path: ['b2'], workflowName: 'block', sourceUri: BLOCK, error: 'ValueError: no', children: [] }
    ]
};

describe('a row', () => {
    it('is named by its instance, the root by its workflow', () => {
        expect(rowLabel(outline)).toBe('top');
        expect(rowLabel(outline.children[0])).toBe('b1');
        expect(rowId(outline.children[0].children[0])).toBe('b1/leaf');
    });

    it('shows the file defining it only when it is not the root’s', () => {
        expect(foreignFileName(outline.children[0], TOP)).toBe('block.py');
        expect(foreignFileName(outline, TOP)).toBeUndefined();
    });
});

describe('filtering the outline', () => {
    it('keeps a match and the rows on the way to it', () => {
        expect(outlineMatches(outline, 'stage')).toBe(true);
        expect(outlineMatches(outline.children[0], 'stage')).toBe(true);
        expect(outlineMatches(outline.children[1], 'stage')).toBe(false);
    });

    it('matches instance names and workflow names alike', () => {
        expect(outlineMatches(outline.children[1], 'b2')).toBe(true);
        expect(outlineMatches(outline.children[1], 'block')).toBe(true);
        expect(outlineMatches(outline.children[1], '')).toBe(true);
    });
});

describe('the view a row opens', () => {
    it('is at the trail a drill-down would give it', () => {
        expect(trailTo(outline, TOP, ['b1', 'leaf'])).toEqual([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: BLOCK, workflowName: 'block', workflowInstanceName: 'b1' },
            { sourceUri: BLOCK, workflowName: 'stage', workflowInstanceName: 'leaf' }
        ]);
        expect(trailTo(outline, TOP, [])).toEqual([{ sourceUri: TOP, workflowName: 'top' }]);
        expect(entryAt(outline, ['b9'])).toBeUndefined();
    });

    it('is highlighted, with its ancestors opened, when it is the view shown', () => {
        const shown = [
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: BLOCK, workflowName: 'block', workflowInstanceName: 'b1' },
            { sourceUri: BLOCK, workflowName: 'stage', workflowInstanceName: 'leaf' }
        ];
        expect(pathOfTrail(shown)).toEqual(['b1', 'leaf']);
        expect(ancestorIds(['b1', 'leaf'])).toEqual(['', 'b1']);
    });

    it('takes its trail from the model root the server echoes it on', () => {
        expect(pathOfTrail(trailOfRoot({ args: { 'wf:navTrail': JSON.stringify([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: BLOCK, workflowName: 'block', workflowInstanceName: 'b1' }
        ]) } }))).toEqual(['b1']);
        expect(trailOfRoot({ args: {} })).toEqual([]);
    });
});

describe('looking at an instance', () => {
    it('finds its node in the view by its entity name', () => {
        const root = {
            id: 'graph',
            children: [
                { id: 'a', args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'other' } },
                { id: 'scope', children: [{ id: 'b1-node', args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'b1' } }] }
            ]
        };
        expect(findNodeIdByEntityName(root, 'b1')).toBe('b1-node');
        expect(findNodeIdByEntityName(root, 'missing')).toBeUndefined();
    });
});
