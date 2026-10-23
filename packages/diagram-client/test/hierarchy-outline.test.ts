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
    rowDetail,
    rowId,
    rowIdsTo,
    rowLabel,
    trailTo
} from '../src/hierarchy-outline-tree';
import { findNodeIdByEntityName, findNodeIdByGraphId, trailOfRoot } from '../src/hierarchy-outline';

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

/**
 * A producer's richer outline: folders and layers as group rows, transparent
 * to paths; documents as views by their title; clauses as node rows, found by
 * the producer's node id in the document's view.
 */
describe('an outline with group and node rows', () => {
    const PROJECT = 'file:///w/ndf.yaml';
    const PIPELINE = 'file:///w/arch/pipeline.md';
    const clause = (doc: string, id: string, title: string): HierarchyOutlineEntry => ({
        path: [doc, id], workflowName: id, sourceUri: PIPELINE, role: 'node', nodeId: `node:scope:root:${id}`,
        label: id, detail: title, family: 'requirement', badges: [{ text: 'MUST', tone: 'info' }], children: []
    });
    const rich: HierarchyOutlineEntry = {
        path: [], workflowName: 'proj', sourceUri: PROJECT, nodeCount: 1,
        children: [{
            path: ['dir:arch'], workflowName: 'arch', role: 'group', label: 'arch',
            children: [{
                path: ['DOC-PIPE'], workflowName: 'DOC-PIPE', sourceUri: PIPELINE, nodeCount: 2, label: 'Pipeline', detail: 'DOC-PIPE',
                children: [{
                    path: ['DOC-PIPE', 'layer:L1'], workflowName: 'L1', role: 'group', label: 'L1',
                    children: [clause('DOC-PIPE', 'PIPE-001', 'Issue contract'), clause('DOC-PIPE', 'PIPE-002', 'Issue rate')]
                }]
            }]
        }]
    };

    it('finds a document and its clauses through the groups, by their own paths', () => {
        expect(entryAt(rich, ['DOC-PIPE'])?.label).toBe('Pipeline');
        expect(entryAt(rich, ['DOC-PIPE', 'PIPE-002'])?.detail).toBe('Issue rate');
        expect(entryAt(rich, ['dir:arch'])).toBeUndefined();
    });

    it('opens a document at the trail a drill-down gives, the folder no crumb of it', () => {
        expect(trailTo(rich, PROJECT, ['DOC-PIPE'])).toEqual([
            { sourceUri: PROJECT, workflowName: 'proj' },
            { sourceUri: PIPELINE, workflowName: 'DOC-PIPE', workflowInstanceName: 'DOC-PIPE' }
        ]);
    });

    it('opens the rows down to the current view, groups and the view itself included', () => {
        expect(rowIdsTo(rich, ['DOC-PIPE'])).toEqual(['', 'dir:arch', 'DOC-PIPE']);
        expect(rowIdsTo(rich, ['NOPE'])).toEqual([]);
    });

    it('says the producer’s label and detail, and filters by either', () => {
        const pipeline = entryAt(rich, ['DOC-PIPE'])!;
        expect(rowLabel(pipeline)).toBe('Pipeline');
        expect(rowDetail(pipeline)).toBe('DOC-PIPE');
        expect(rowDetail(rich.children[0])).toBeUndefined();
        // An instance the producer says nothing more about keeps its workflow as the detail.
        expect(rowDetail(outline.children[0])).toBe('block');
        expect(outlineMatches(rich, 'issue rate')).toBe(true);
        expect(outlineMatches(rich, 'pipe-001')).toBe(true);
        expect(outlineMatches(rich, 'nothing like it')).toBe(false);
    });

    it('finds a node row’s node by the producer’s id, whatever the diagram named it', () => {
        const root = { id: 'g', children: [{ id: 'Issue contract', type: 'node:actor', args: { [WorkflowDiagramMetadata.GRAPH_NODE_ID]: 'node:scope:root:PIPE-001' }, children: [] }] };
        expect(findNodeIdByGraphId(root, 'node:scope:root:PIPE-001')).toBe('Issue contract');
        expect(findNodeIdByGraphId(root, 'node:scope:root:PIPE-404')).toBeUndefined();
    });
});
