// @vitest-environment happy-dom
/**
 * Where Center, Fit and a surface's `reveal` put the content on the canvas,
 * in screen pixels, with the palette over the canvas where GLSP's CSS puts
 * it (right 45 px, top 35 px).
 *
 * Center puts the content's middle in the middle of the largest free area.
 * Content that fits the canvas but not that area would run off the canvas's
 * edge: it stops a margin inside it instead. And a zoom the limits change
 * keeps the content's middle where the command put it.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { CenterAction, FitToScreenAction } from '@eclipse-glsp/protocol';

type Box = { x: number; y: number; width: number; height: number };

/** What the overlays cover, as `overlaysOn` measures it. */
let covered: Box[] = [];
vi.mock('../src/canvas-overlays', () => ({ overlaysOn: () => covered, CANVAS_OVERLAYS: [] }));
vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

const { SurfaceAwareCenterCommand, HiddenRenderRecord } = await import('../src/viewport-content');
const { FitClearOfOverlaysCommand } = await import('../src/fit-clear-of-overlays');
const { DiagramSurfaceHost } = await import('../src/diagram-surface-host');
const { FIT_MARGIN } = await import('../src/fit-geometry');
const { applyViewportLimits } = await import('../src/viewport-limits');

const requireSprotty = createRequire(require.resolve('@eclipse-glsp/client'));
const { SModelRootImpl } = requireSprotty('sprotty/lib/base/model/smodel');
const { viewportFeature } = requireSprotty('sprotty/lib/features/viewport/model');

const STOCK = { zoomLimits: { min: 0.1, max: 20 }, horizontalScrollLimits: { min: -100000, max: 100000 }, verticalScrollLimits: { min: -100000, max: 100000 } };

/** A viewport root of `canvas` size holding one element of `content` bounds. */
function model(canvas: { width: number; height: number }, content: Box[], zoom = 1): any {
    const root: any = Object.assign(Object.create(SModelRootImpl.prototype), {
        id: 'graph', type: 'graph', features: new Set([viewportFeature]), zoom, scroll: { x: 0, y: 0 },
        canvasBounds: { x: 0, y: 0, ...canvas }, bounds: { x: 0, y: 0, width: -1, height: -1 }
    });
    const byId = new Map<string, any>([['graph', root]]);
    content.forEach((bounds, at) => byId.set(`n${at}`, { id: `n${at}`, bounds, parent: root }));
    Object.defineProperty(root, 'index', { value: { getById: (id: string) => byId.get(id), all: () => [...byId.values()] } });
    return root;
}

function center(m: any, options: object = STOCK): { zoom: number; scroll: { x: number; y: number } } {
    const command = new SurfaceAwareCenterCommand(CenterAction.create([], { animate: false, retainZoom: false }) as never);
    Object.assign(command as any, { viewerOptions: options });
    command.initialize(m);
    return (command as any).newViewport;
}

function fit(m: any, options: object = STOCK, hidden?: InstanceType<typeof HiddenRenderRecord>): { zoom: number; scroll: { x: number; y: number } } {
    const command = new FitClearOfOverlaysCommand(FitToScreenAction.create([], { animate: false }) as never);
    Object.assign(command as any, { viewerOptions: options, hiddenRender: hidden });
    command.initialize(m);
    return (command as any).newViewport;
}

/** Where `content` is drawn on screen at `viewport`. */
function onScreen(content: Box, viewport: { zoom: number; scroll: { x: number; y: number } }): { left: number; right: number; top: number; bottom: number; middle: { x: number; y: number } } {
    const left = (content.x - viewport.scroll.x) * viewport.zoom;
    const top = (content.y - viewport.scroll.y) * viewport.zoom;
    const right = left + content.width * viewport.zoom;
    const bottom = top + content.height * viewport.zoom;
    return { left, right, top, bottom, middle: { x: (left + right) / 2, y: (top + bottom) / 2 } };
}

/** The palette where GLSP's CSS puts it, on a canvas `width` wide. */
const palette = (width: number, size: { width: number; height: number }): Box => ({ x: width - 45 - size.width, y: 35, ...size });

afterEach(() => {
    covered = [];
});

describe('Center, with the palette over the canvas', () => {
    it('A1: a 1000 × 500 diagram on a 1200 × 800 canvas stays on it, a margin in, as near the free area’s middle as it can', () => {
        covered = [palette(1200, { width: 240, height: 400 })];
        const content = { x: 0, y: 0, width: 1000, height: 500 };
        const shown = onScreen(content, center(model({ width: 1200, height: 800 }, [content])));
        // Centred in the 915 px left of the palette it was drawn from −42.5 to 957.5.
        expect(shown.left).toBeCloseTo(FIT_MARGIN);
        expect(shown.right).toBeCloseTo(1000 + FIT_MARGIN);
        expect(shown.top).toBeCloseTo(150);
        expect(shown.bottom).toBeCloseTo(650);
    });

    it('A2: a 420 × 500 diagram in a 500 × 700 editor stays on it', () => {
        covered = [palette(500, { width: 240, height: 420 })];
        const content = { x: 0, y: 0, width: 420, height: 500 };
        const shown = onScreen(content, center(model({ width: 500, height: 700 }, [content])));
        // It was drawn from −102.5 to 317.5.
        expect(shown.left).toBeCloseTo(FIT_MARGIN);
        expect(shown.right).toBeCloseTo(420 + FIT_MARGIN);
        expect(shown.top).toBeCloseTo(100);
        expect(shown.bottom).toBeCloseTo(600);
    });

    it('a diagram larger than the canvas still has its middle in the middle of the free area', () => {
        covered = [palette(1200, { width: 240, height: 400 })];
        const content = { x: 0, y: 0, width: 2000, height: 1500 };
        const shown = onScreen(content, center(model({ width: 1200, height: 800 }, [content])));
        expect(shown.middle.x).toBeCloseTo(915 / 2);
        expect(shown.middle.y).toBeCloseTo(400);
    });

    it('a diagram that fits the free area is centred in it, as before', () => {
        covered = [palette(1200, { width: 240, height: 400 })];
        const content = { x: 0, y: 0, width: 400, height: 300 };
        const shown = onScreen(content, center(model({ width: 1200, height: 800 }, [content])));
        expect(shown.middle).toEqual({ x: 915 / 2, y: 400 });
        // Nearer the canvas's edge than the margin, but on the canvas: not pushed under the palette.
        const wide = { x: 0, y: 0, width: 905, height: 300 };
        expect(onScreen(wide, center(model({ width: 1200, height: 800 }, [wide]))).left).toBeCloseTo(5);
    });

    it('a zoom the limits change keeps the content centred: at a floor of 2, the middle is the canvas’s', () => {
        const content = { x: 0, y: 0, width: 100, height: 50 };
        const viewport = center(model({ width: 800, height: 600 }, [content]), { ...STOCK, zoomLimits: { min: 2, max: 20 } });
        expect(viewport.zoom).toBe(2);
        expect(onScreen(content, viewport).middle).toEqual({ x: 400, y: 300 });
    });
});

describe('Fit, when a zoom limit applies', () => {
    it('B1: a 100 × 50 node fitted at a max of 5 is in the middle of an 800 × 600 canvas', () => {
        const content = { x: 0, y: 0, width: 100, height: 50 };
        const viewport = fit(model({ width: 800, height: 600 }, [content]), { ...STOCK, zoomLimits: { min: 0.1, max: 5 } });
        expect(viewport.zoom).toBe(5);
        // It was at (260, 195).
        expect(onScreen(content, viewport).middle).toEqual({ x: 400, y: 300 });
    });

    it('B2: a 20 000 × 10 000 diagram fitted at a floor of 0.25 is in the middle, not below the canvas', () => {
        const content = { x: 0, y: 0, width: 20_000, height: 10_000 };
        const viewport = fit(model({ width: 800, height: 600 }, [content]), { ...STOCK, zoomLimits: { min: 0.25, max: 20 } });
        expect(viewport.zoom).toBe(0.25);
        // It was at (2604, 1953): the canvas showed nothing.
        const shown = onScreen(content, viewport);
        expect(shown.middle.x).toBeCloseTo(400);
        expect(shown.middle.y).toBeCloseTo(300);
    });
});

describe('Fit and Center, with a view that draws what it holds itself', () => {
    it('frame everything when leaving out what the hidden render did not draw leaves nothing', () => {
        const a = { x: 0, y: 0, width: 100, height: 100 };
        const b = { x: 300, y: 100, width: 100, height: 100 };
        // The root's view drew the children in its own markup: only the root went through the render of each element.
        const hidden = new HiddenRenderRecord();
        hidden.decorate({}, { id: 'graph' });
        hidden.postUpdate();
        const viewport = fit(model({ width: 800, height: 600 }, [a, b]), STOCK, hidden);
        expect(viewport).toBeDefined();
        const both = { x: 0, y: 0, width: 400, height: 200 };
        expect(viewport.zoom).toBeCloseTo(Math.min((800 - 2 * FIT_MARGIN) / 400, (600 - 2 * FIT_MARGIN) / 200));
        expect(onScreen(both, viewport).middle.x).toBeCloseTo(400);
    });
});

describe('a surface’s reveal', () => {
    function hostOn(canvas: { width: number; height: number }, zoomLimits?: { min: number; max: number }) {
        document.body.innerHTML = '<div id="diagram"><svg class="sprotty-graph"></svg></div>';
        const dispatched: any[] = [];
        const host = new DiagramSurfaceHost();
        let context: any;
        const surface = { id: 'probe', mount: (c: unknown) => { context = c; return document.createElement('canvas'); }, render: () => undefined };
        Object.assign(host as any, {
            contributedSurfaces: [surface],
            actionDispatcher: { dispatch: async (action: unknown) => { dispatched.push(action); } },
            viewerOptions: { baseDiv: 'diagram', ...(zoomLimits ? { zoomLimits } : {}) }
        });
        const root = { id: 'graph', type: 'graph', scroll: { x: 0, y: 0 }, zoom: 1, canvasBounds: { x: 0, y: 0, ...canvas }, args: {}, children: [] };
        host.decorate({}, { id: 'n1', parent: root });
        host.decorate({}, root);
        host.postUpdate();
        const viewportOf = () => {
            const action = dispatched.filter(a => a.kind === 'viewport').at(-1);
            return { zoom: action.newViewport.zoom, scroll: action.newViewport.scroll };
        };
        return { reveal: (bounds: Box, options?: object) => context.reveal(bounds, options), viewportOf };
    }

    it('without fit, keeps a rectangle that fits the canvas on it (A1)', () => {
        covered = [palette(1200, { width: 240, height: 400 })];
        const { reveal, viewportOf } = hostOn({ width: 1200, height: 800 });
        const content = { x: 0, y: 0, width: 1000, height: 500 };
        reveal(content, { animate: false });
        const shown = onScreen(content, viewportOf());
        expect(shown.left).toBeCloseTo(FIT_MARGIN);
        expect(shown.top).toBeCloseTo(150);
    });

    it('with fit, fits into the whole canvas when the overlays leave no area with room for the margin, as Fit does', () => {
        covered = [{ x: 0, y: 0, width: 800, height: 600 }];
        const { reveal, viewportOf } = hostOn({ width: 800, height: 600 });
        const content = { x: 0, y: 0, width: 100, height: 50 };
        reveal(content, { fit: true, animate: false });
        const viewport = viewportOf();
        expect(viewport.zoom).toBeCloseTo((800 - 2 * FIT_MARGIN) / 100);
        expect(onScreen(content, viewport).middle).toEqual({ x: 400, y: 300 });
    });

    it('with fit, at a max of 5, puts the rectangle in the middle (B1)', () => {
        const { reveal, viewportOf } = hostOn({ width: 800, height: 600 }, { min: 0.1, max: 5 });
        const content = { x: 0, y: 0, width: 100, height: 50 };
        reveal(content, { fit: true, animate: false });
        const viewport = viewportOf();
        expect(viewport.zoom).toBe(5);
        expect(onScreen(content, viewport).middle).toEqual({ x: 400, y: 300 });
    });
});

describe('the zoom limits', () => {
    it('are the surface’s the host mounts: of A (x), B (y) and A′ (x) bound, B’s', () => {
        const viewerOptions: any = {};
        const surface = (id: string, min: number) => ({ id, mount: () => undefined, render: () => undefined, zoomLimits: { min, max: min * 10 } });
        const bound = [surface('x', 1), surface('y', 2), surface('x', 3), { id: 'z', zoomLimits: { min: 4, max: 40 } }];
        const container = { isBound: () => true, get: () => viewerOptions, getAll: () => bound };
        applyViewportLimits(container, 'viewer', 'surface', undefined);
        expect(viewerOptions.zoomLimits).toEqual({ min: 2, max: 20 });
    });
});
