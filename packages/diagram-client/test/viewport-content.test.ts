/**
 * What Fit and Center frame (viewport-content.ts), run through Sprotty's own
 * Center and Fit commands: a surface's bounds join the graph's, its selection
 * counts as a selection, a label no view draws is left out once a hidden
 * render has said so, Center keeps the zoom when asked and puts the content
 * in the middle of the free area, and the zoom limits hold.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CenterAction, FitToScreenAction } from '@eclipse-glsp/protocol';
import { FitClearOfOverlaysCommand } from '../src/fit-clear-of-overlays';
import { HiddenRenderRecord, SurfaceAwareCenterCommand, combineBounds, viewportContentBounds } from '../src/viewport-content';
import { FIT_MARGIN, largestFreeArea, viewportCentredIn } from '../src/fit-geometry';
import { createRequire } from 'node:module';

// Sprotty's Center reads the zoom it keeps only from a real viewport root
// (`isViewport`): an `SModelRootImpl` with the viewport feature.
const requireSprotty = createRequire(require.resolve('@eclipse-glsp/client'));
const { SModelRootImpl } = requireSprotty('sprotty/lib/base/model/smodel');
const { viewportFeature } = requireSprotty('sprotty/lib/features/viewport/model');

type Box = { x: number; y: number; width: number; height: number };

/** A root as Sprotty's commands read it; children's bounds are in the root's coordinates. */
function model(elements: Array<{ id: string; bounds: Box; parent?: string; selected?: boolean }>, viewport = { zoom: 1, x: 0, y: 0 }): any {
    const root: any = Object.assign(Object.create(SModelRootImpl.prototype), {
        id: 'graph',
        type: 'graph',
        features: new Set([viewportFeature]),
        zoom: viewport.zoom,
        scroll: { x: viewport.x, y: viewport.y },
        canvasBounds: { x: 0, y: 0, width: 800, height: 600 },
        // The root is bounds-aware too, with no size until measured: Sprotty ignores it.
        bounds: { x: 0, y: 0, width: -1, height: -1 }
    });
    const byId = new Map<string, any>([['graph', root]]);
    for (const element of elements) {
        byId.set(element.id, { ...element, parent: undefined });
    }
    for (const element of elements) {
        byId.get(element.id).parent = byId.get(element.parent ?? 'graph');
    }
    Object.defineProperty(root, 'index', { value: { getById: (id: string) => byId.get(id), all: () => [...byId.values()] } });
    return root;
}

const OPTIONS = {
    zoomLimits: { min: 0.1, max: 20 },
    horizontalScrollLimits: { min: -100000, max: 100000 },
    verticalScrollLimits: { min: -100000, max: 100000 }
};

/** A hidden render that drew these ids. */
function drew(...ids: string[]): HiddenRenderRecord {
    const record = new HiddenRenderRecord();
    for (const id of ids) {
        record.decorate({}, { id });
    }
    record.postUpdate();
    return record;
}

function fit(m: any, extra: { hidden?: HiddenRenderRecord; surface?: object; options?: object } = {}): any {
    const command = new FitClearOfOverlaysCommand(FitToScreenAction.create([], { animate: false }) as never);
    Object.assign(command as any, {
        viewerOptions: extra.options ?? OPTIONS,
        hiddenRender: extra.hidden,
        surfaceHost: extra.surface ? { content: () => extra.surface } : undefined
    });
    command.initialize(m);
    return (command as any).newViewport;
}

function center(m: any, retainZoom: boolean, extra: { surface?: object } = {}): any {
    const command = new SurfaceAwareCenterCommand(CenterAction.create([], { animate: false, retainZoom }) as never);
    Object.assign(command as any, {
        viewerOptions: OPTIONS,
        surfaceHost: extra.surface ? { content: () => extra.surface } : undefined
    });
    command.initialize(m);
    return (command as any).newViewport;
}

/** The fit of `content` into the whole 800 × 600 canvas, the margin in. */
function fitted(content: Box): { zoom: number; scroll: { x: number; y: number } } {
    const zoom = Math.min((800 - 2 * FIT_MARGIN) / content.width, (600 - 2 * FIT_MARGIN) / content.height);
    return { zoom, scroll: { x: content.x + content.width / 2 - 400 / zoom, y: content.y + content.height / 2 - 300 / zoom } };
}

const node = { id: 'node', bounds: { x: 0, y: 0, width: 100, height: 50 } };
// The name label a node's view leaves out, laid out for a box it is never drawn in.
const label = { id: 'node_label', parent: 'node', bounds: { x: 500, y: 0, width: 40, height: 10 } };

describe('Fit and Center leave out what no view draws', () => {
    it('fits the node alone once the hidden render drew the node and not its label', () => {
        const viewport = fit(model([node, label]), { hidden: drew('graph', 'node') });
        expect(viewport.zoom).toBeCloseTo(fitted(node.bounds).zoom);
        expect(viewport.scroll.x).toBeCloseTo(fitted(node.bounds).scroll.x);
    });

    it('leaves out what the left-out label holds too', () => {
        const inner = { id: 'inner', parent: 'node_label', bounds: { x: 900, y: 0, width: 5, height: 5 } };
        const viewport = fit(model([node, label, inner]), { hidden: drew('graph', 'node') });
        expect(viewport.zoom).toBeCloseTo(fitted(node.bounds).zoom);
    });

    it('frames everything, as Sprotty does, before any hidden render', () => {
        const viewport = fit(model([node, label]));
        expect(viewport.zoom).toBeCloseTo(fitted({ x: 0, y: 0, width: 540, height: 50 }).zoom);
    });
});

describe('Fit and Center frame a surface\'s bounds', () => {
    const drawing = { x: 1000, y: 1000, width: 2000, height: 1000 };

    it('fits an empty graph to the surface alone', () => {
        const viewport = fit(model([]), { surface: { bounds: drawing } });
        expect(viewport.zoom).toBeCloseTo(fitted(drawing).zoom);
        expect(viewport.scroll.x).toBeCloseTo(fitted(drawing).scroll.x);
        expect(viewport.scroll.y).toBeCloseTo(fitted(drawing).scroll.y);
    });

    it('fits the graph and the surface together', () => {
        const viewport = fit(model([node]), { surface: { bounds: drawing } });
        expect(viewport.zoom).toBeCloseTo(fitted({ x: 0, y: 0, width: 3000, height: 2000 }).zoom);
    });

    it('frames the surface\'s selection, as a selected node is framed', () => {
        const part = { x: 1500, y: 1200, width: 0.2, height: 0.2 };
        const viewport = fit(model([node]), { surface: { bounds: drawing, selectionBounds: part }, options: { ...OPTIONS, zoomLimits: { min: 0.001, max: 5000 } } });
        expect(viewport.zoom).toBeCloseTo(fitted(part).zoom);
        // A selected node wins over it: the graph's selection is the one named.
        const withNode = fit(model([{ ...node, selected: true }]), { surface: { bounds: drawing, selectionBounds: part } });
        expect(withNode.zoom).toBeCloseTo(Math.min(fitted(node.bounds).zoom, 20));
    });

    it('keeps the zoom limits: a fit that wants 7.68 stops at a max of 5', () => {
        const viewport = fit(model([node]), { options: { ...OPTIONS, zoomLimits: { min: 0.1, max: 5 } } });
        expect(viewport.zoom).toBe(5);
    });

    it('centres the surface at the zoom there is when Center keeps it, at 1 when it does not', () => {
        const kept = center(model([], { zoom: 3, x: 7, y: 9 }), true, { surface: { bounds: drawing } });
        expect(kept.zoom).toBe(3);
        expect(kept.scroll).toEqual({ x: 2000 - 400 / 3, y: 1500 - 300 / 3 });
        const reset = center(model([], { zoom: 3, x: 7, y: 9 }), false, { surface: { bounds: drawing } });
        expect(reset.zoom).toBe(1);
        expect(reset.scroll).toEqual({ x: 2000 - 400, y: 1500 - 300 });
    });

    it('centres the surface\'s selection while there is one', () => {
        const viewport = center(model([], { zoom: 16, x: 0, y: 0 }), true, { surface: { bounds: drawing, selectionBounds: { x: 10, y: 20, width: 2, height: 4 } } });
        expect(viewport).toEqual({ zoom: 16, scroll: { x: 11 - 400 / 16, y: 22 - 300 / 16 } });
    });

    it('frames the elements named, whatever else there is', () => {
        const bounds = viewportContentBounds(model([node, label]), ['node_label'], e => e.bounds!, undefined, { bounds: drawing });
        expect(bounds).toEqual(label.bounds);
    });
});

describe('the free area', () => {
    it('is the whole canvas with nothing over it, and Center puts the middle there', () => {
        expect(largestFreeArea({ width: 800, height: 600 }, [])).toEqual({ x: 0, y: 0, width: 800, height: 600 });
        expect(viewportCentredIn({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 800, height: 600 }, 2))
            .toEqual({ zoom: 2, scroll: { x: 5 - 200, y: 5 - 150 } });
    });

    it('is the largest side of an open outline on the left: the content goes right of it', () => {
        const outline = { x: 0, y: 0, width: 300, height: 600 };
        const area = largestFreeArea({ width: 800, height: 600 }, [outline])!;
        expect(area).toEqual({ x: 300, y: 0, width: 500, height: 600 });
        const viewport = viewportCentredIn({ x: 0, y: 0, width: 10, height: 10 }, area, 1);
        // The content's middle (5, 5) lands at the area's middle (550, 300).
        expect((5 - viewport.scroll.x) * viewport.zoom).toBe(550);
    });
});

describe('helpers', () => {
    it('combines bounds, ignoring one with no size yet', () => {
        expect(combineBounds({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: -5, width: 1, height: 1 })).toEqual({ x: 0, y: -5, width: 6, height: 6 });
        expect(combineBounds({ x: 0, y: 0, width: -1, height: -1 }, { x: 5, y: 5, width: 1, height: 1 })).toEqual({ x: 5, y: 5, width: 1, height: 1 });
        expect(combineBounds(undefined, undefined)).toBeUndefined();
    });

    it('keeps the last hidden render that drew something', () => {
        const record = drew('a', 'b');
        record.postUpdate(); // a render that drew nothing (none happened)
        expect([...record.drawn()!]).toEqual(['a', 'b']);
    });
});
