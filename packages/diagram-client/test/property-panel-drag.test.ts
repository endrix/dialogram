// @vitest-environment happy-dom
/**
 * The floating property panel moves with its header while the button is held.
 * A release outside the webview never reaches it, so the drag also ends at the
 * first move with the button up, and when the webview loses focus: the panel
 * no longer follows a pointer that let go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROPERTY_PANEL_CHROME_CONFIG, PropertyPanelChrome } from '../src/property-panel-chrome';

const cfg = DEFAULT_PROPERTY_PANEL_CHROME_CONFIG;

function floatingPanel(): { panel: HTMLElement; header: HTMLElement } {
    localStorage.setItem(cfg.floatingModeStorageKey, 'true');
    const panel = document.createElement('div');
    panel.id = cfg.panelId;
    const header = document.createElement('div');
    header.className = cfg.headerSelector.replace(/^\./, '');
    panel.appendChild(header);
    document.body.appendChild(panel);
    panel.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, right: 420, bottom: 450, width: 320, height: 400, toJSON: () => ({}) }) as DOMRect;
    new PropertyPanelChrome(() => undefined, { ...cfg, enableDockedResize: false }).initialize();
    return { panel, header };
}

function mouse(type: string, x: number, y: number, buttons: number): MouseEvent {
    return new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true });
}

beforeEach(() => localStorage.clear());
afterEach(() => { document.body.innerHTML = ''; });

describe('dragging the floating property panel', () => {
    it('follows the pointer while the button is held', () => {
        const { panel, header } = floatingPanel();
        header.dispatchEvent(mouse('mousedown', 200, 60, 1));
        document.dispatchEvent(mouse('mousemove', 230, 100, 1));
        expect([panel.style.left, panel.style.top]).toEqual(['130px', '90px']);
        document.dispatchEvent(mouse('mouseup', 230, 100, 0));
        document.dispatchEvent(mouse('mousemove', 300, 300, 0));
        expect([panel.style.left, panel.style.top]).toEqual(['130px', '90px']);
    });

    it('ends at the first move with the button up, when the release happened outside the webview', () => {
        const { panel, header } = floatingPanel();
        header.dispatchEvent(mouse('mousedown', 200, 60, 1));
        document.dispatchEvent(mouse('mousemove', 230, 100, 1));
        document.dispatchEvent(mouse('mousemove', 400, 400, 0));
        expect([panel.style.left, panel.style.top]).toEqual(['130px', '90px']);
        document.dispatchEvent(mouse('mousemove', 420, 420, 1));
        expect([panel.style.left, panel.style.top]).toEqual(['130px', '90px']);
        expect(header.style.cursor).toBe('');
    });

    it('ends when the webview loses focus', () => {
        const { panel, header } = floatingPanel();
        header.dispatchEvent(mouse('mousedown', 200, 60, 1));
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(mouse('mousemove', 260, 90, 1));
        expect(panel.style.left).toBe('');
    });
});
