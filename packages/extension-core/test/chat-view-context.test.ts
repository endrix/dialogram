/**
 * The chat is the root's for the whole hierarchy; the agent is told which
 * nested workflow the diagram shows, so "this" and the selected nodes mean the
 * view on screen, not the root.
 */
import { describe, expect, it } from 'vitest';
import { viewContextText } from '../src/extension/chat/chat-runtime';

describe('the view on screen, in the chat’s turn context', () => {
    it('says nothing when the root is on screen', () => {
        expect(viewContextText(undefined)).toBeUndefined();
        expect(viewContextText([{ workflowName: 'top' }])).toBeUndefined();
    });

    it('names the path from the root, the instance, and the file defining it', () => {
        const text = viewContextText([
            { sourceUri: 'file:///w/top.py', workflowName: 'top' },
            { sourceUri: 'file:///w/layers/block.py', workflowName: 'block', workflowInstanceName: 'b2' }
        ]);

        expect(text).toContain('top › b2 (block)');
        expect(text).toContain('/w/layers/block.py');
        expect(text).toContain('Selected nodes belong to this view');
    });
});
