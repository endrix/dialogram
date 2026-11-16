/**
 * What a prompt offers, read off the diagram: the port type its ports have
 * most (one the producer accepts), and a kind's name with its article.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata as M, WorkflowDiagramTypes as T, portTypesUsed, withArticle } from '@dialogram/shared';

const port = (type: string) => ({ type: T.PORT_INPUT, args: { [M.PORT_TYPE]: type } });

describe('the words of a prompt', () => {
    it('offer the port type the diagram uses most, nothing when it has none', () => {
        const root = { children: [
            { type: T.NODE_ACTOR, children: [port('Int(8)'), port('Int(16)')] },
            { type: T.NODE_ACTOR, children: [port('Int(8)'), { type: 'label', args: { [M.PORT_TYPE]: 'Bool' } }] }
        ] };
        expect(portTypesUsed(root)).toEqual(['Int(8)', 'Int(16)']);
        expect(portTypesUsed({ children: [] })).toEqual([]);
    });

    it('count the network\'s own ports, not the copies a group frame draws', () => {
        const boundary = (type: string) => ({ type: T.NODE_BOUNDARY_INPUT, args: { [M.PORT_TYPE]: type } });
        const mirror = (type: string) => ({ type: T.PORT_GROUP_BOUNDARY, args: { [M.PORT_TYPE]: type } });
        expect(portTypesUsed({ children: [boundary('Int(13)'), mirror('Bool'), mirror('Bool'), mirror('Bool')] })).toEqual(['Int(13)']);
    });

    it('put the article a word takes before it', () => {
        expect(withArticle('actor')).toBe('an actor');
        expect(withArticle('network')).toBe('a network');
        expect(withArticle('Agent')).toBe('an Agent');
    });
});
