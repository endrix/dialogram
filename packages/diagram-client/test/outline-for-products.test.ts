// @vitest-environment happy-dom
/**
 * The outline for a product with views of its own: the panel's stylesheet and
 * its button's are sheets of their own, which such a product imports beside
 * the panel (diagram-client.css @imports them and keeps none of their rules),
 * and the floating button stack is made once, by whichever comes first.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureFloatingButtonStack, FLOATING_BUTTON_STACK_ID } from '../src/floating-panels';
import { placeInButtonStack } from '../src/hierarchy-outline';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the outline’s stylesheets', () => {
    it('hold the panel and the button stack, @imported by diagram-client.css, which keeps neither', () => {
        const outline = read('hierarchy-outline.css');
        expect(outline).toMatch(/\.workflow-hierarchy-outline\s*\{/);
        expect(outline).toMatch(/\.workflow-hierarchy-outline-badge\.badge-tone-warning/);
        const buttons = read('floating-buttons.css');
        expect(buttons).toMatch(/\.workflow-fab-stack\s*\{/);
        expect(buttons).toMatch(/\.workflow-fab-btn\s*\{/);
        expect(buttons).toMatch(/\.workflow-fab-stack \.workflow-chat-toggle-btn\s*\{/);
        const stock = read('diagram-client.css');
        expect(stock).toMatch(/@import '\.\/floating-buttons\.css';/);
        expect(stock).toMatch(/@import '\.\/hierarchy-outline\.css';/);
        expect(stock).not.toMatch(/\.workflow-hierarchy-outline|\.workflow-fab-stack|\.workflow-fab-btn\b/);
    });
});

describe('the floating button stack', () => {
    beforeEach(() => document.body.replaceChildren());

    it('is made once, and found again by whoever asks next', () => {
        const stack = ensureFloatingButtonStack();
        expect(stack.id).toBe(FLOATING_BUTTON_STACK_ID);
        expect(stack.classList.contains('workflow-fab-stack')).toBe(true);
        expect(ensureFloatingButtonStack()).toBe(stack);
        expect(document.querySelectorAll('.workflow-fab-stack')).toHaveLength(1);
    });

    it('takes the outline’s button under the chat’s once it is there', () => {
        const stack = ensureFloatingButtonStack();
        const chat = document.createElement('button');
        chat.id = 'workflow-chat-toggle-btn';
        stack.appendChild(chat);
        const toggle = document.createElement('button');
        document.body.appendChild(toggle);
        placeInButtonStack(toggle);
        expect(toggle.parentElement).toBe(stack);
        expect(toggle.nextElementSibling).toBe(chat);
        expect(toggle.classList.contains('floating')).toBe(false);
    });
});
