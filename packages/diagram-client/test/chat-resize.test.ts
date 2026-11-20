// @vitest-environment happy-dom
/**
 * Resizing the chat card: the top edge sets the drawer's height, a side the
 * card's width (both sides move, the card being centred), a top corner both.
 * A drag turns the drawer's height transition off while it lasts, so the
 * drawer follows the pointer, and the sizes it leaves come back on reload.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CHAT_HEIGHT_STORAGE_KEY,
    CHAT_PANEL_MIN_WIDTH_PX,
    CHAT_WIDTH_STORAGE_KEY,
    drawerHeight,
    panelWidth,
    restoreChatSize,
    startChatResize,
    type ChatResizeEdge
} from '../src/chat-resize';
import { ChatPanel } from '../src/chat-panel-integrated';

const PANEL_WIDTH = 600;
const DRAWER_HEIGHT = 200;

function box(width: number, height: number): () => DOMRect {
    return () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect;
}

/** A card like the chat's: a drawer inside, measured as the browser would. */
function card(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'workflow-chat-panel';
    const scroll = document.createElement('div');
    scroll.className = 'chat-scroll';
    panel.appendChild(scroll);
    document.body.appendChild(panel);
    measure(panel);
    return panel;
}

function measure(panel: HTMLElement): void {
    panel.getBoundingClientRect = box(PANEL_WIDTH, 300);
    const scroll = panel.querySelector<HTMLElement>('.chat-scroll');
    if (scroll) {
        scroll.getBoundingClientRect = box(PANEL_WIDTH, panel.classList.contains('drawer-closed') ? 0 : DRAWER_HEIGHT);
    }
}

function handleOn(panel: HTMLElement, edge: ChatResizeEdge): HTMLElement {
    const handle = document.createElement('div');
    handle.className = `chat-resize-handle ${edge}`;
    handle.addEventListener('pointerdown', e => startChatResize(panel, e as PointerEvent, edge));
    panel.appendChild(handle);
    return handle;
}

/** A pointer event; a move carries the main button held unless `buttons` says otherwise. */
function pointer(type: string, x: number, y: number, button = 0, buttons = type === 'pointerup' ? 0 : 1): MouseEvent {
    return new MouseEvent(type, { clientX: x, clientY: y, button, buttons, bubbles: true, cancelable: true });
}

/** Press on `handle` at (x, y), move by (dx, dy), and report what the card looked like mid-drag. */
function drag(handle: HTMLElement, dx: number, dy: number, release = true): { resizingMidDrag: boolean } {
    const panel = handle.closest<HTMLElement>('.workflow-chat-panel')!;
    handle.dispatchEvent(pointer('pointerdown', 500, 500));
    document.dispatchEvent(pointer('pointermove', 500 + dx / 2, 500 + dy / 2));
    document.dispatchEvent(pointer('pointermove', 500 + dx, 500 + dy));
    const resizingMidDrag = panel.classList.contains('resizing');
    if (release) {
        document.dispatchEvent(pointer('pointerup', 500 + dx, 500 + dy));
    }
    return { resizingMidDrag };
}

beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
});

afterEach(() => {
    document.body.innerHTML = '';
    document.body.style.cursor = '';
});

describe('the limits a drag keeps to', () => {
    it('keeps the drawer between 120 px and 60% of the window', () => {
        expect(drawerHeight(50, 1000)).toBe(120);
        expect(drawerHeight(300, 1000)).toBe(300);
        expect(drawerHeight(900, 1000)).toBe(600);
        // A window too short for both: the greatest wins, as max-height does in the CSS.
        expect(drawerHeight(300, 150)).toBe(90);
    });

    it('keeps the card between its least width and the window less 28 px', () => {
        expect(panelWidth(300, 1400)).toBe(CHAT_PANEL_MIN_WIDTH_PX);
        expect(panelWidth(700, 1400)).toBe(700);
        expect(panelWidth(2000, 1400)).toBe(1372);
        // A window narrower than the least width: the least width wins, as in the CSS.
        expect(panelWidth(600, 400)).toBe(CHAT_PANEL_MIN_WIDTH_PX);
    });
});

describe('dragging an edge', () => {
    it('the top edge sets the drawer height and turns the transition off only while it lasts', () => {
        const panel = card();
        const { resizingMidDrag } = drag(handleOn(panel, 'top'), 0, -50);
        expect(resizingMidDrag).toBe(true);
        expect(panel.classList.contains('resizing')).toBe(false);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe(`${DRAWER_HEIGHT + 50}px`);
        expect(localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY)).toBe(`${DRAWER_HEIGHT + 50}px`);
        expect(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)).toBeNull();
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe('');
    });

    it('starts from the drawer as drawn, so the first move does not jump', () => {
        const panel = card();
        panel.style.setProperty('--chat-drawer-height', '450px');
        drag(handleOn(panel, 'top'), 0, -1);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe(`${DRAWER_HEIGHT + 1}px`);
    });

    it('starts a drawer still opening from the height it was opening to', () => {
        const panel = card();
        const scroll = panel.querySelector<HTMLElement>('.chat-scroll')!;
        // Mid-transition the drawer is 60 px; with the transition off it is at its 305 px.
        scroll.getBoundingClientRect = () => box(PANEL_WIDTH, panel.classList.contains('resizing') ? 305 : 60)();
        drag(handleOn(panel, 'top'), 0, -5);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe('310px');
    });

    it('a side moves both sides, so the edge under the pointer follows it', () => {
        const panel = card();
        drag(handleOn(panel, 'right'), 40, 0);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 80}px`);
        expect(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)).toBe(`${PANEL_WIDTH + 80}px`);
        expect(localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY)).toBeNull();

        measure(panel);
        drag(handleOn(panel, 'left'), 30, 0);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH - 60}px`);
    });

    it('a top corner sets both', () => {
        const panel = card();
        drag(handleOn(panel, 'top-left'), -20, -30);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 40}px`);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe(`${DRAWER_HEIGHT + 30}px`);
    });

    it('a closed drawer keeps its saved height: the top edge does nothing, a corner sets the width only', () => {
        localStorage.setItem(CHAT_HEIGHT_STORAGE_KEY, '333px');
        const panel = card();
        panel.classList.add('drawer-closed');
        measure(panel);
        const { resizingMidDrag } = drag(handleOn(panel, 'top'), 0, -50);
        expect(resizingMidDrag).toBe(false);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe('');

        drag(handleOn(panel, 'top-right'), 10, -50);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 20}px`);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe('');
        expect(localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY)).toBe('333px');
    });

    it('ignores any button but the main one', () => {
        const panel = card();
        const handle = handleOn(panel, 'right');
        handle.dispatchEvent(pointer('pointerdown', 500, 500, 2));
        document.dispatchEvent(pointer('pointermove', 600, 500));
        expect(panel.classList.contains('resizing')).toBe(false);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe('');
    });

    it('ends at the first move with the button up, when the release happened outside the webview', () => {
        const panel = card();
        drag(handleOn(panel, 'right'), 40, 0, false);
        expect(panel.classList.contains('resizing')).toBe(true);
        document.dispatchEvent(pointer('pointermove', 400, 500, 0, 0));
        expect(panel.classList.contains('resizing')).toBe(false);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 80}px`);
        expect(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)).toBe(`${PANEL_WIDTH + 80}px`);
        document.dispatchEvent(pointer('pointermove', 300, 500));
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 80}px`);
    });

    it('ends when the webview loses focus', () => {
        const panel = card();
        drag(handleOn(panel, 'top'), 0, -40, false);
        window.dispatchEvent(new Event('blur'));
        expect(panel.classList.contains('resizing')).toBe(false);
        expect(localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY)).toBe(`${DRAWER_HEIGHT + 40}px`);
    });

    it('stops listening once released', () => {
        const panel = card();
        drag(handleOn(panel, 'right'), 40, 0);
        document.dispatchEvent(pointer('pointermove', 900, 500));
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 80}px`);
        expect(document.body.style.cursor).toBe('');
    });
});

describe('the sizes a drag leaves', () => {
    it('come back on the card', () => {
        localStorage.setItem(CHAT_HEIGHT_STORAGE_KEY, '280px');
        localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, '720px');
        const panel = card();
        restoreChatSize(panel);
        expect(panel.style.getPropertyValue('--chat-drawer-height')).toBe('280px');
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe('720px');
    });
});

describe('the chat panel', () => {
    beforeEach(() => {
        (globalThis as any).requestAnimationFrame = () => 1;
        (globalThis as any).cancelAnimationFrame = () => undefined;
        // The top bar's selects are form-associated custom elements, which happy-dom can't attach.
        const proto = HTMLElement.prototype as any;
        if (typeof proto.attachInternals !== 'function') {
            proto.attachInternals = () => new Proxy({}, { get: () => () => undefined });
        }
    });

    it('draws a handle on its top edge, both sides and both top corners, and a side drag sets its width', () => {
        localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, '700px');
        const chat = new ChatPanel();
        (chat as any).channel = { sendToHost: () => undefined };
        (chat as any).createHost();
        (chat as any).update();
        const panel = document.getElementById('workflow-chat-panel')!;
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe('700px');
        const edges = [...panel.querySelectorAll('.chat-resize-handle')].map(h => h.classList[1]);
        expect(edges).toEqual(['top', 'left', 'right', 'top-left', 'top-right']);

        measure(panel);
        drag(panel.querySelector<HTMLElement>('.chat-resize-handle.right')!, 25, 0);
        expect(panel.style.getPropertyValue('--chat-panel-width')).toBe(`${PANEL_WIDTH + 50}px`);
    });
});
