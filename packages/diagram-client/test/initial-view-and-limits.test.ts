/**
 * The first view of a diagram, done once and when it can be right, and the
 * zoom range a profile or a surface sets.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitialViewportService, initialViewAction } from '../src/initial-viewport-service';
import { applyViewportLimits, resolveViewportLimits } from '../src/viewport-limits';

type Listener = (root: any) => void;

/** The host as the service hears it: renders, the surface's bounds changing, whether it is ready. */
function fakeHost(ready = true) {
    const renders: Listener[] = [];
    const bounds: Array<() => void> = [];
    let current: any;
    const host = {
        ready,
        onRender: (listener: Listener) => { renders.push(listener); return { dispose: () => undefined }; },
        onBoundsChanged: (listener: () => void) => { bounds.push(listener); return { dispose: () => undefined }; },
        currentRoot: () => current,
        surfaceReady: () => host.ready,
        render(root: any) { current = root; renders.forEach(listener => listener(root)); },
        boundsChanged() { bounds.forEach(listener => listener()); }
    };
    return host;
}

function service(host: ReturnType<typeof fakeHost> | undefined) {
    const dispatched: any[] = [];
    const s = new InitialViewportService();
    Object.assign(s as any, { actionDispatcher: { dispatch: async (a: unknown) => { dispatched.push(a); } }, surfaceHost: host });
    (s as any).listen();
    return { s, dispatched };
}

const root = (over: Partial<{ type: string; zoom: number; x: number; y: number; width: number }> = {}) => ({
    id: 'graph',
    type: over.type ?? 'graph',
    zoom: over.zoom ?? 1,
    scroll: { x: over.x ?? 0, y: over.y ?? 0 },
    canvasBounds: { x: 0, y: 0, width: over.width ?? 800, height: 600 }
});

let initialView: string | undefined;
beforeEach(() => {
    initialView = undefined;
    (globalThis as any).diagramIdentifier = { get clientBehavior() { return { initialView }; } };
});
afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the first view', () => {
    it('is a centre by default, a fit when the profile asks for one', () => {
        expect(initialViewAction(undefined)).toMatchObject({ kind: 'center', animate: false, retainZoom: false });
        expect(initialViewAction('fit')).toMatchObject({ kind: 'fit', animate: false });
    });

    it('is done once, at the first render with a canvas, however many renders follow', () => {
        initialView = 'fit';
        const host = fakeHost();
        const { s, dispatched } = service(host);
        const r = root();
        s.arm(r);
        host.render(root({ width: 0 })); // no canvas size yet
        expect(dispatched).toEqual([]);
        host.render(r);
        host.render(r);
        host.render(r);
        expect(dispatched.map(a => a.kind)).toEqual(['fit']);
        expect(s.shown).toBe(1);
        expect(s.waiting()).toBe(false);
    });

    it('is not armed by Sprotty\'s empty placeholder, the cause of the double centre', () => {
        const host = fakeHost();
        const { s, dispatched } = service(host);
        s.arm(root({ type: 'NONE' }));
        host.render(root({ type: 'NONE' }));
        expect(s.waiting()).toBe(false);
        expect(dispatched).toEqual([]);
    });

    it('waits for a surface\'s bounds, and goes when they come', () => {
        const host = fakeHost(false);
        const { s, dispatched } = service(host);
        const r = root();
        s.arm(r);
        host.render(r);
        expect(dispatched).toEqual([]);
        host.ready = true;
        host.boundsChanged();
        expect(dispatched.map(a => a.kind)).toEqual(['center']);
        host.boundsChanged();
        expect(dispatched).toHaveLength(1);
    });

    it('is given up when the reader moves the view first', () => {
        const host = fakeHost(false);
        const { s, dispatched } = service(host);
        s.arm(root());
        host.render(root({ zoom: 2 }));
        host.ready = true;
        host.boundsChanged();
        expect(dispatched).toEqual([]);
        expect(s.waiting()).toBe(false);
    });

    describe('when the canvas takes another size before the reader moves the view', () => {
        // A webview that draws its first model before VS Code sized its frame: 300 × 150.
        const early = (over: Parameters<typeof root>[0] = {}) => ({ ...root(over), canvasBounds: { x: 0, y: 0, width: 300, height: 150 } });

        it('is done again on the canvas it then has, once', () => {
            initialView = 'fit';
            const host = fakeHost();
            const { s, dispatched } = service(host);
            s.arm(early());
            host.render(early());
            expect(dispatched.map(a => a.kind)).toEqual(['fit']);
            host.render(early({ zoom: 0.05, x: -2900 })); // the fit, drawn on the small canvas
            host.render(root({ zoom: 0.05, x: -2900 })); // the frame sized
            expect(dispatched.map(a => a.kind)).toEqual(['fit', 'fit']);
            host.render(root({ zoom: 1, x: -150 })); // the second fit, drawn
            host.render(root({ zoom: 1, x: -150 }));
            expect(dispatched).toHaveLength(2);
            expect(s.shown).toBe(2);
        });

        it('is done again also when the canvas changes before the first view is drawn', () => {
            const host = fakeHost();
            const { s, dispatched } = service(host);
            s.arm(early());
            host.render(early());
            host.render(root());
            expect(dispatched.map(a => a.kind)).toEqual(['center', 'center']);
            expect(s.shown).toBe(2);
        });

        it('is left alone once the reader has moved the view', () => {
            initialView = 'fit';
            const host = fakeHost();
            const { s, dispatched } = service(host);
            s.arm(early());
            host.render(early());
            host.render(early({ zoom: 0.05 })); // the fit, drawn
            host.render(early({ zoom: 0.3 })); // the reader zooms
            host.render(root({ zoom: 0.3 }));
            expect(dispatched).toHaveLength(1);
        });

        it('is forgotten when another view is armed', () => {
            const host = fakeHost();
            const { s, dispatched } = service(host);
            s.arm(early());
            host.render(early());
            s.arm(root({ x: 40 }));
            host.render(root({ x: 40 }));
            host.render(root({ x: 40, width: 900 }));
            // One first view each, and the second view's canvas change follows its own.
            expect(dispatched).toHaveLength(3);
        });
    });

    it('without the host, comes two frames after the model, as before', async () => {
        const { s, dispatched } = service(undefined);
        s.arm(root());
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(dispatched.map(a => a.kind)).toEqual(['center']);
    });
});

describe('the zoom range', () => {
    it('stays GLSP\'s when nobody asks', () => {
        expect(resolveViewportLimits(undefined, undefined)).toBeUndefined();
    });

    it('is the profile\'s, and the surface\'s over it', () => {
        expect(resolveViewportLimits({ min: 0.5, max: 50 }, undefined)!.zoomLimits).toEqual({ min: 0.5, max: 50 });
        expect(resolveViewportLimits({ min: 0.5, max: 50 }, { min: 0.01, max: 5000 })!.zoomLimits).toEqual({ min: 0.01, max: 5000 });
    });

    it('widens the scroll range so a low floor can be reached, and only then', () => {
        expect(resolveViewportLimits({ min: 0.5, max: 50 }, undefined)!.horizontalScrollLimits).toEqual({ min: -100000, max: 100000 });
        expect(resolveViewportLimits(undefined, { min: 0.01, max: 5000 })!.verticalScrollLimits).toEqual({ min: -1e6, max: 1e6 });
    });

    it('ignores a range that is not one, with a warning', () => {
        const warn = vi.fn();
        expect(resolveViewportLimits({ min: 5, max: 1 }, { min: 0, max: 10 }, warn)).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('is set on the container\'s viewer options, the last surface bound speaking', () => {
        const options: any = { zoomLimits: { min: 0.1, max: 20 }, baseDiv: 'diagram' };
        const VIEWER = Symbol('viewer');
        const SURFACE = Symbol('surface');
        const container = {
            isBound: (id: unknown) => id === VIEWER || id === SURFACE,
            get: () => options,
            // Surfaces the host can mount (`mount`, `render`), as it chooses them.
            getAll: () => [
                { id: 'a', mount: () => undefined, render: () => undefined, zoomLimits: { min: 1, max: 2 } },
                { id: 'b', mount: () => undefined, render: () => undefined, zoomLimits: { min: 0.05, max: 4000 } }
            ]
        };
        applyViewportLimits(container, VIEWER, SURFACE, { min: 0.5, max: 50 });
        expect(options.zoomLimits).toEqual({ min: 0.05, max: 4000 });
        expect(options.baseDiv).toBe('diagram');
    });
});
