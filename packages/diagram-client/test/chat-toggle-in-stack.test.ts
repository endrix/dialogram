// @vitest-environment happy-dom
/**
 * The chat's button sits at the top of the floating stack. The navigation
 * moved it there only when it drew after the button was made; made after the
 * last draw, the button stayed on its own, fixed where the stack's lowest
 * button is, over it. The button now joins a stack that is already there.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';
import { placeInButtonStack } from '../src/hierarchy-outline';

afterEach(() => document.body.replaceChildren());

function stackWith(...ids: string[]): HTMLElement {
    const stack = document.createElement('div');
    stack.className = 'workflow-fab-stack';
    for (const id of ids) {
        stack.appendChild(Object.assign(document.createElement('button'), { id }));
    }
    document.body.appendChild(stack);
    return stack;
}

describe('the chat\'s button', () => {
    it('joins the top of a stack the navigation made before it', () => {
        const stack = stackWith('run-history', 'workflow-hierarchy-outline-toggle');
        (new ChatPanel() as any).createToggleButton();
        expect(document.getElementById('workflow-chat-toggle-btn')?.parentElement).toBe(stack);
        expect(stack.lastElementChild?.id).toBe('workflow-chat-toggle-btn');
    });

    it('sits on its own when there is no stack yet, for the navigation to move', () => {
        (new ChatPanel() as any).createToggleButton();
        expect(document.getElementById('workflow-chat-toggle-btn')?.parentElement).toBe(document.body);
    });

    it('stays above the node list\'s, which then goes under it', () => {
        const stack = stackWith('run-history', 'workflow-hierarchy-outline-toggle', 'workflow-node-list-outline-toggle');
        (new ChatPanel() as any).createToggleButton();
        // The node list places its button again a frame later.
        placeInButtonStack(document.getElementById('workflow-node-list-outline-toggle')!, document, ['workflow-chat-toggle-btn']);
        expect(Array.from(stack.children).map(button => button.id))
            .toEqual(['run-history', 'workflow-hierarchy-outline-toggle', 'workflow-node-list-outline-toggle', 'workflow-chat-toggle-btn']);
    });
});
