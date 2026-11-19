/**
 * What a run left on an edge (`edge-tokens.ts`), one rule for the canvas's
 * overlay and the node list: the run's final token by AST path, overridden
 * by a signature match; at a trace step, the token the step had, or none for
 * an edge the trace knows and had none then.
 */
import { describe, expect, it } from 'vitest';
import { edgeTokensOf, type EdgeTokenSources } from '../src/server/edge-tokens';

const sources = (more: Partial<EdgeTokenSources> = {}): EdgeTokenSources => ({
    overlayEdges: { 'ast:1': { lastToken: 'by-path' }, 'ast:3': {} },
    overlayBySignature: new Map([['a>b', 'by-signature']]),
    queueByAstPath: new Map(),
    queueBySignature: new Map(),
    queueTokenByAstPath: new Map(),
    queueTokenBySignature: new Map(),
    atTrace: false,
    astPathCandidates: args => (typeof args?.['ast'] === 'string' ? [args['ast'] as string] : []),
    signatureCandidates: args => (args?.['from'] ? [`${args['from']}>${args['to']}`] : []),
    ...more
});

describe('the token on an edge', () => {
    it('is the run\'s final token at its AST path, overridden by its signature\'s', () => {
        const tokens = edgeTokensOf(sources());

        expect(tokens({ ast: 'ast:1' })).toEqual({ shown: { token: 'by-path' } });
        expect(tokens({ ast: 'ast:1', from: 'a', to: 'b' })).toEqual({ shown: { token: 'by-signature' } });
        expect(tokens({ ast: 'ast:2' })).toEqual({});
        // A record with no token is none.
        expect(tokens({ ast: 'ast:3' })).toEqual({});
    });

    it('is the step\'s token at a trace step, and none for an edge the trace knows that had none then', () => {
        const tokens = edgeTokensOf(sources({
            atTrace: true,
            queueByAstPath: new Map([['ast:1', 2], ['ast:9', 0]]),
            queueTokenByAstPath: new Map([['ast:1', 'at-step']])
        }));

        expect(tokens({ ast: 'ast:1' })).toEqual({ shown: { token: 'at-step' }, queueSize: 2 });
        expect(tokens({ ast: 'ast:9' })).toEqual({ queueSize: 0 });
    });

    it('keeps the final token at a trace step for an edge the trace does not know', () => {
        const tokens = edgeTokensOf(sources({ atTrace: true, queueByAstPath: new Map([['ast:9', 0]]) }));

        expect(tokens({ ast: 'ast:1' })).toEqual({ shown: { token: 'by-path' } });
    });

    it('finds a step\'s queue by signature as the final token is', () => {
        const tokens = edgeTokensOf(sources({
            atTrace: true,
            queueBySignature: new Map([['c>d', 1]]),
            queueTokenBySignature: new Map([['c>d', 'q']])
        }));

        expect(tokens({ from: 'c', to: 'd' })).toEqual({ shown: { token: 'q' }, queueSize: 1 });
    });
});
