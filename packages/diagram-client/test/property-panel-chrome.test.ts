/**
 * PropertyPanelChrome — parameterized ids/keys (D1 oracle).
 *
 * Proves the chrome's window-management (show/hide/pin, body-class reservation,
 * width persistence) is driven entirely by an injectable config whose defaults
 * reproduce the historical stock strings. The vitest env is `node` (no DOM), so
 * this test installs a minimal fake `document`/`window`/`localStorage`/
 * `ResizeObserver` on globalThis — just enough surface for the chrome to run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PropertyPanelChrome,
    DEFAULT_PROPERTY_PANEL_CHROME_CONFIG,
    type PropertyPanelChromeConfig
} from '../src/property-panel-chrome';

// ── Minimal fake DOM ────────────────────────────────────────────────────────

type Listener = (e: any) => void;

class FakeClassList {
    private set = new Set<string>();
    constructor(initial: string[] = []) { initial.forEach(c => this.set.add(c)); }
    add(c: string) { this.set.add(c); }
    remove(c: string) { this.set.delete(c); }
    contains(c: string) { return this.set.has(c); }
    toggle(c: string, force?: boolean) {
        const want = force === undefined ? !this.set.has(c) : force;
        if (want) this.set.add(c); else this.set.delete(c);
        return want;
    }
}

class FakeStyle {
    private props = new Map<string, string>();
    width = '';
    top = '';
    left = '';
    right = '';
    cursor = '';
    setProperty(k: string, v: string) { this.props.set(k, v); }
    getPropertyValue(k: string) { return this.props.get(k) ?? ''; }
}

class FakeEl {
    classList: FakeClassList;
    style = new FakeStyle();
    title = '';
    tagName = 'DIV';
    className = '';
    private listeners = new Map<string, Listener[]>();
    constructor(public id: string, classes: string[] = []) { this.classList = new FakeClassList(classes); }
    addEventListener(type: string, fn: Listener) {
        const arr = this.listeners.get(type) ?? [];
        arr.push(fn);
        this.listeners.set(type, arr);
    }
    removeEventListener() { /* noop for this test */ }
    dispatch(type: string, e: any = {}) { (this.listeners.get(type) ?? []).forEach(fn => fn(e)); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 320, height: 200 }; }
    querySelector() { return null; }
    setAttribute() { /* noop */ }
}

class FakeDocument {
    body = new FakeEl('body');
    documentElement = new FakeEl('html');
    activeElement: FakeEl | null = null;
    private els = new Map<string, FakeEl>();
    private headerBySelector = new Map<string, FakeEl>();
    private listeners = new Map<string, Listener[]>();
    add(el: FakeEl) { this.els.set(el.id, el); return el; }
    addHeader(selector: string, el: FakeEl) { this.headerBySelector.set(selector, el); return el; }
    getElementById(id: string) { return this.els.get(id) ?? null; }
    querySelector(sel: string) { return this.headerBySelector.get(sel) ?? null; }
    addEventListener(type: string, fn: Listener) {
        const arr = this.listeners.get(type) ?? [];
        arr.push(fn);
        this.listeners.set(type, arr);
    }
    removeEventListener() { /* noop */ }
    dispatch(type: string, e: any = {}) { (this.listeners.get(type) ?? []).forEach(fn => fn(e)); }
}

let capturedResizeCb: ((entries: any[]) => void) | undefined;

function installFakeDom(doc: FakeDocument, store: Map<string, string>) {
    capturedResizeCb = undefined;
    (globalThis as any).document = doc;
    (globalThis as any).window = {
        innerWidth: 1600,
        innerHeight: 900,
        localStorage: {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, v); },
            removeItem: (k: string) => { store.delete(k); }
        },
        addEventListener: () => {},
        dispatchEvent: () => true
    };
    (globalThis as any).ResizeObserver = class {
        constructor(cb: (entries: any[]) => void) { capturedResizeCb = cb; }
        observe() {}
        disconnect() {}
    };
    (globalThis as any).requestAnimationFrame = () => 0;
    (globalThis as any).Event = class { constructor(public type: string) {} };
    (globalThis as any).CSS = { escape: (s: string) => s };
}

function teardownFakeDom() {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).ResizeObserver;
    delete (globalThis as any).requestAnimationFrame;
    delete (globalThis as any).Event;
    delete (globalThis as any).CSS;
}

/** Build the panel DOM for a given config (panel starts visible). */
function buildDom(cfg: PropertyPanelChromeConfig) {
    const doc = new FakeDocument();
    const panel = doc.add(new FakeEl(cfg.panelId));
    const close = doc.add(new FakeEl(cfg.closeBtnId));
    const pin = doc.add(new FakeEl(cfg.pinBtnId));
    const toggle = doc.add(new FakeEl(cfg.toggleBtnId));
    doc.addHeader(cfg.headerSelector, new FakeEl('header'));
    return { doc, panel, close, pin, toggle };
}

const store = new Map<string, string>();

afterEach(() => { teardownFakeDom(); store.clear(); });

describe('PropertyPanelChrome — defaults', () => {
    it('wires the stock ids and toggles the stock body class', () => {
        const cfg = DEFAULT_PROPERTY_PANEL_CHROME_CONFIG;
        const { doc, panel, close } = buildDom(cfg);
        installFakeDom(doc, store);

        const chrome = new PropertyPanelChrome(() => undefined);
        chrome.initialize();

        // Panel starts visible → stock body class is set.
        expect(doc.body.classList.contains('workflow-properties-visible')).toBe(true);

        // Close button (stock id) hides the panel and clears the body class.
        close.dispatch('click');
        expect(panel.classList.contains('collapsed')).toBe(true);
        expect(doc.body.classList.contains('workflow-properties-visible')).toBe(false);
    });
});

describe('PropertyPanelChrome — custom (mlir-like) config', () => {
    const MLIR: PropertyPanelChromeConfig = {
        ...DEFAULT_PROPERTY_PANEL_CHROME_CONFIG,
        panelId: 'mlir-property-panel',
        closeBtnId: 'mlir-btn-close-properties',
        pinBtnId: 'mlir-btn-pin-properties',
        floatBtnId: 'mlir-btn-float-properties',
        toggleBtnId: 'mlir-btn-toggle-properties',
        headerSelector: '.mlir-property-header',
        visibleBodyClass: 'mlir-properties-visible',
        panelWidthStorageKey: 'mlir.propertyPanel.widthPx'
    };

    it('toggles the mlir panel + body class and never touches the stock ids', () => {
        const { doc, panel, close } = buildDom(MLIR);
        // A stray stock-id element must remain untouched.
        const stockPanel = doc.add(new FakeEl('property-panel'));
        installFakeDom(doc, store);

        const chrome = new PropertyPanelChrome(() => undefined, MLIR);
        chrome.initialize();

        expect(doc.body.classList.contains('mlir-properties-visible')).toBe(true);
        expect(doc.body.classList.contains('workflow-properties-visible')).toBe(false);

        close.dispatch('click');
        expect(panel.classList.contains('collapsed')).toBe(true);
        // Stock panel never received a collapse.
        expect(stockPanel.classList.contains('collapsed')).toBe(false);
    });

    it('reads and writes width through the config storage key', () => {
        const { doc } = buildDom(MLIR);
        installFakeDom(doc, store);

        const chrome = new PropertyPanelChrome(() => undefined, MLIR);
        chrome.initialize();

        // The ResizeObserver callback drives a persisted width write.
        expect(capturedResizeCb).toBeTypeOf('function');
        capturedResizeCb!([{ contentRect: { width: 420 } }]);

        expect(store.get('mlir.propertyPanel.widthPx')).toBe('420');
        expect(store.has('workflow.diagram.propertyPanel.widthPx')).toBe(false);
    });
});

describe('PropertyPanelChrome — enableDockedResize:false (CSS-width panel)', () => {
    const CSS_WIDTH: PropertyPanelChromeConfig = {
        ...DEFAULT_PROPERTY_PANEL_CHROME_CONFIG,
        panelId: 'mlir-property-panel',
        closeBtnId: 'mlir-btn-close-properties',
        pinBtnId: 'mlir-btn-pin-properties',
        toggleBtnId: 'mlir-btn-toggle-properties',
        headerSelector: '.mlir-property-header',
        visibleBodyClass: 'mlir-properties-visible',
        panelWidthStorageKey: 'mlir.propertyPanel.widthPx',
        enableDockedResize: false
    };

    it('wires no ResizeObserver, applies no inline width, and never persists width', () => {
        const { doc, panel, close } = buildDom(CSS_WIDTH);
        // A stored width must NOT be applied when docked resize is disabled.
        store.set('mlir.propertyPanel.widthPx', '500');
        installFakeDom(doc, store);

        const chrome = new PropertyPanelChrome(() => undefined, CSS_WIDTH);
        chrome.initialize();

        expect(capturedResizeCb).toBeUndefined(); // no observer wired
        expect(panel.style.width).toBe(''); // CSS width untouched
        // show/hide still work (chrome behavior otherwise intact).
        expect(doc.body.classList.contains('mlir-properties-visible')).toBe(true);
        close.dispatch('click');
        expect(panel.classList.contains('collapsed')).toBe(true);
        // Stored width preserved but never rewritten by the chrome.
        expect(store.get('mlir.propertyPanel.widthPx')).toBe('500');
    });
});
