// @vitest-environment happy-dom
/**
 * The panels floating over the diagram: the one in use is on top. The hierarchy,
 * always a step above the chat, covered the chat's send button.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { raiseFloatingPanel, stackAsFloatingPanel } from '../src/floating-panels';

function panel(id: string): HTMLElement {
    const el = document.createElement('div');
    el.id = id;
    el.appendChild(document.createElement('textarea'));
    document.body.appendChild(el);
    stackAsFloatingPanel(el);
    return el;
}

afterEach(() => {
    document.body.replaceChildren();
});

describe('the floating panels', () => {
    it('put the one opened above the others', () => {
        const chat = panel('chat');
        const hierarchy = panel('hierarchy');
        raiseFloatingPanel(hierarchy);
        expect(Number(hierarchy.style.zIndex)).toBeGreaterThan(Number(chat.style.zIndex));
        raiseFloatingPanel(chat);
        expect(Number(chat.style.zIndex)).toBeGreaterThan(Number(hierarchy.style.zIndex));
    });

    it('raise the one clicked or typed in', () => {
        const chat = panel('chat');
        const hierarchy = panel('hierarchy');
        raiseFloatingPanel(hierarchy);
        chat.querySelector('textarea')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(Number(chat.style.zIndex)).toBeGreaterThan(Number(hierarchy.style.zIndex));
        hierarchy.querySelector('textarea')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(Number(hierarchy.style.zIndex)).toBeGreaterThan(Number(chat.style.zIndex));
    });

    it('forget a panel taken out of the page', () => {
        const gone = panel('gone');
        const chat = panel('chat');
        raiseFloatingPanel(gone);
        gone.remove();
        raiseFloatingPanel(chat);
        // Left as it was: no longer one of the panels.
        expect(gone.style.zIndex).toBe('1002');
        expect(chat.style.zIndex).toBe('1002');
    });
});
