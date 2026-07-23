// Guards the caller/callee detection in analyzeWorkflowRelationships.
//
// The per-callee call-site regex is now compiled once up front rather than rebuilt inside the
// caller loop (an O(callers × callees) → O(callees) change on the cold-open critical path). These
// assertions pin that the detected relationships are unchanged: same callers-by-workflow map and
// same entry (uncalled) workflows.
import { describe, expect, it } from 'vitest';
import { analyzeWorkflowRelationships } from '../src/server/source-analysis';

const SOURCE = [
    '@workflow',
    'def parent():',
    '    child()',
    '    grandchild()',
    '',
    '@workflow',
    'def child():',
    '    grandchild()',
    '',
    '@workflow',
    'def grandchild():',
    '    pass',
    ''
].join('\n');

describe('analyzeWorkflowRelationships caller/callee detection', () => {
    it('maps callers per workflow and reports uncalled workflows as entry points', () => {
        const info = analyzeWorkflowRelationships(SOURCE);

        expect(info.workflowNames.sort()).toEqual(['child', 'grandchild', 'parent']);
        expect(info.callersByWorkflow.parent).toEqual([]);
        expect(info.callersByWorkflow.child).toEqual(['parent']);
        expect(info.callersByWorkflow.grandchild).toEqual(['parent', 'child']);
        expect(info.entryWorkflowNames).toEqual(['parent']);
    });

    it('returns empty relationships when the source defines no workflows', () => {
        const info = analyzeWorkflowRelationships('def plain():\n    return 1\n');
        expect(info.workflowNames).toEqual([]);
        expect(info.entryWorkflowNames).toEqual([]);
        expect(info.callersByWorkflow).toEqual({});
    });
});
