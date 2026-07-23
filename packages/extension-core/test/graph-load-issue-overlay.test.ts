import { describe, expect, it } from 'vitest';
import { computeGraphLoadIssueOverlayState } from '../../diagram-client/src/graph-load-issue-overlay';

describe('computeGraphLoadIssueOverlayState', () => {
    it('returns undefined for non-partial graphs', () => {
        const result = computeGraphLoadIssueOverlayState({
            isPartialGraph: false,
            graphErrors: [{ message: 'no @network definitions found' }],
            renderableNodeCount: 0
        });

        expect(result).toBeUndefined();
    });

    it('returns undefined when diagram still has renderable nodes', () => {
        const result = computeGraphLoadIssueOverlayState({
            isPartialGraph: true,
            graphErrors: [{ message: 'recoverable parse warning' }],
            renderableNodeCount: 3
        });

        expect(result).toBeUndefined();
    });

    it('builds center overlay content for empty partial graphs', () => {
        const result = computeGraphLoadIssueOverlayState({
            isPartialGraph: true,
            graphErrors: [
                { message: 'no @network definitions found' },
                { message: 'secondary warning' }
            ],
            renderableNodeCount: 0
        });

        expect(result).toBeDefined();
        expect(result?.title).toBe('Cannot render diagram from this file');
        expect(result?.message).toContain('no @network definitions found');
        expect(result?.message).toContain('(+1 more)');
        expect(result?.hint).toContain('top-level @network');
    });
});