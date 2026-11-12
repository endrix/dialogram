/**
 * Double-click "go to definition" on a node whose producer named the
 * definition tells the host so: the target is opened as it is.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { buildDefinitionNavigationAction } from '../src/viewer-mouse-listener';

const RANGE = { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } };
const referenced = {
    [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/lib/actors.py',
    [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: RANGE
};
const action = (args: Record<string, unknown>): any => buildDefinitionNavigationAction({ id: 'n', args } as any, 'file:///w/top.py');

describe('the definition a double-click opens', () => {
    it('is marked as the producer\'s own when the node says so', () => {
        const named = action({ ...referenced, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true });
        expect(named.uri).toBe('file:///w/lib/actors.py');
        expect(named.args['wf:navigateTargetIsDefinition']).toBe(true);
        // What the host falls back on when the file is gone is still sent.
        expect(named.args['wf:navigatePreferDefinition']).toBe(true);
        expect(named.args['wf:navigateSourceUri']).toBe('file:///w/top.py');
    });

    it('is not marked for a target that is only a place in a file', () => {
        expect(action(referenced).args['wf:navigateTargetIsDefinition']).toBeUndefined();
    });
});
