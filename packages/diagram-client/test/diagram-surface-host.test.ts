// @vitest-environment happy-dom
/**
 * The diagram surface's host (diagram-surface-host.ts) in a real DOM: the
 * surface is mounted under the SVG once there is a root, told every viewport
 * (the first included) and only a changed one, told of a new size, a new
 * theme and new surface data, handed its clicks, and its selection is kept,
 * cleared and heard. Without a surface the page is left as it was.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import {
    DiagramSurfaceHost,
    SURFACE_BODY_CLASS,
    SURFACE_MOUNTED_EVENT,
    SURFACE_PANE_CLASS,
    SurfaceClickListener,
    asViewportRoot,
    normalizeSurfaceSelection,
    themeOf,
    toBytes
} from '../src/diagram-surface-host';
import type { DiagramSurface, DiagramSurfaceContext, SurfaceSelection, SurfaceViewport } from '../src/diagram-surface';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

type Call = [hook: string, ...args: unknown[]];

/** A surface that records every call; its element is a canvas. */
function recordingSurface(extra: Partial<DiagramSurface> = {}): DiagramSurface & { calls: Call[]; context?: DiagramSurfaceContext } {
    const calls: Call[] = [];
    const surface: DiagramSurface & { calls: Call[]; context?: DiagramSurfaceContext } = {
        id: 'probe',
        calls,
        mount(context) {
            calls.push(['mount']);
            surface.context = context;
            const canvas = document.createElement('canvas');
            canvas.className = 'probe-canvas';
            return canvas;
        },
        render(viewport) {
            calls.push(['render', viewport]);
        },
        bounds: () => ({ x: 0, y: 0, width: 400, height: 200 }),
        modelChanged(model) {
            calls.push(['modelChanged', model]);
        },
        themeChanged(theme) {
            calls.push(['themeChanged', theme.kind]);
        },
        resized(viewport) {
            calls.push(['resized', viewport.width, viewport.height]);
        },
        click(point) {
            calls.push(['click', point]);
        },
        selectionCleared() {
            calls.push(['selectionCleared']);
        },
        ...extra
    };
    return surface;
}

/** A root as Sprotty renders it: a viewport, a canvas, args. */
function root(over: Partial<{ id: string; type: string; scroll: { x: number; y: number }; zoom: number; width: number; height: number; args: Record<string, unknown> }> = {}): any {
    return {
        id: over.id ?? 'graph',
        type: over.type ?? 'graph',
        scroll: over.scroll ?? { x: 0, y: 0 },
        zoom: over.zoom ?? 1,
        canvasBounds: { x: 0, y: 0, width: over.width ?? 800, height: over.height ?? 600 },
        args: over.args ?? {},
        children: []
    };
}

function hostWith(surfaces: DiagramSurface[] | undefined): { host: DiagramSurfaceHost; dispatched: any[] } {
    const dispatched: any[] = [];
    const host = new DiagramSurfaceHost();
    Object.assign(host as any, {
        contributedSurfaces: surfaces,
        actionDispatcher: { dispatch: async (action: unknown) => { dispatched.push(action); } },
        viewerOptions: { baseDiv: 'diagram' }
    });
    return { host, dispatched };
}

/** One render of `r`, as Sprotty does it: every element decorated, then `postUpdate`. */
function render(host: DiagramSurfaceHost, r: any): void {
    host.decorate({}, { id: 'n1', parent: r });
    host.decorate({}, r);
    host.postUpdate();
}

const renders = (surface: { calls: Call[] }) => surface.calls.filter(c => c[0] === 'render').map(c => c[1] as SurfaceViewport);
const frame = () => new Promise(resolve => setTimeout(resolve, 40));

beforeEach(() => {
    document.body.className = 'vscode-dark';
    document.body.innerHTML = '<div id="diagram"><svg class="sprotty-graph"></svg></div>';
});

afterEach(() => {
    document.body.className = '';
});

describe('the surface is told the viewport', () => {
    it('mounts the surface under the SVG at the first render, and draws that first viewport', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        const mountedEvents = vi.fn();
        document.addEventListener(SURFACE_MOUNTED_EVENT, mountedEvents);
        render(host, root({ scroll: { x: 10, y: 20 }, zoom: 2 }));
        render(host, root({ scroll: { x: 10, y: 20 }, zoom: 2 }));
        document.removeEventListener(SURFACE_MOUNTED_EVENT, mountedEvents);
        expect(mountedEvents).toHaveBeenCalledTimes(1);

        const base = document.getElementById('diagram')!;
        const pane = base.firstElementChild as HTMLElement;
        expect(pane.className).toBe(SURFACE_PANE_CLASS);
        expect(pane.querySelector('canvas.probe-canvas')).not.toBeNull();
        expect(base.lastElementChild!.tagName.toLowerCase()).toBe('svg');
        expect(document.body.classList.contains(SURFACE_BODY_CLASS)).toBe(true);
        expect(pane.style.width).toBe('800px');
        expect(pane.style.height).toBe('600px');
        expect(surface.calls.map(c => c[0])).toEqual(['mount', 'modelChanged', 'render']);
        expect(renders(surface)[0]).toEqual({ scrollX: 10, scrollY: 20, zoom: 2, width: 800, height: 600, devicePixelRatio: window.devicePixelRatio || 1 });
    });

    it('draws again on every viewport change, each frame of an animation included, and not when nothing moved', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        const r = root();
        render(host, r);
        render(host, r); // a hover, a selection: no viewport change
        for (const zoom of [1.5, 2, 2.5]) {
            r.zoom = zoom; // Sprotty's viewport animation mutates the root
            render(host, r);
        }
        r.scroll = { x: 100, y: 0 };
        render(host, r);
        expect(renders(surface).map(v => [v.zoom, v.scrollX])).toEqual([[1, 0], [1.5, 0], [2, 0], [2.5, 0], [2.5, 100]]);
    });

    it('says a new size before drawing it, and places the pane again', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root());
        render(host, root({ width: 1000, height: 700 }));
        const hooks = surface.calls.map(c => c[0]);
        expect(hooks.slice(-2)).toEqual(['resized', 'render']);
        expect(surface.calls.find(c => c[0] === 'resized')).toEqual(['resized', 1000, 700]);
        expect((document.querySelector(`.${SURFACE_PANE_CLASS}`) as HTMLElement).style.width).toBe('1000px');
    });

    it('draws again on request, with the viewport there is', async () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root());
        surface.context!.requestRender();
        surface.context!.requestRender(); // coalesced
        await frame();
        expect(renders(surface)).toHaveLength(2);
    });

    it('tells the theme when VS Code changes it, then draws', async () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root());
        expect(surface.context!.theme().kind).toBe('dark');
        document.body.className = 'vscode-light';
        await frame();
        expect(surface.calls.filter(c => c[0] === 'themeChanged')).toEqual([['themeChanged', 'light']]);
        expect(renders(surface)).toHaveLength(2);
    });

    it('hands the surface its data when a model brings other data, and only then', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        (globalThis as any).diagramIdentifier = { uri: 'file:///w/doc.x' };
        const data = { revision: 1 };
        render(host, root({ args: { [WorkflowDiagramMetadata.SURFACE]: data } }));
        render(host, root({ args: { [WorkflowDiagramMetadata.SURFACE]: { revision: 1 } } }));
        render(host, root({ args: { [WorkflowDiagramMetadata.SURFACE]: { revision: 2 } } }));
        // The server stamps the view's file on the root; it wins over the editor's document.
        render(host, root({ args: { [WorkflowDiagramMetadata.SURFACE]: { revision: 2 }, sourceUri: 'file:///w/other.x' } }));
        delete (globalThis as any).diagramIdentifier;
        expect(surface.calls.filter(c => c[0] === 'modelChanged').map(c => c[1])).toEqual([
            { data: { revision: 1 }, sourceUri: 'file:///w/doc.x' },
            { data: { revision: 2 }, sourceUri: 'file:///w/doc.x' },
            { data: { revision: 2 }, sourceUri: 'file:///w/other.x' }
        ]);
    });

    it('waits for a real root: Sprotty\'s empty placeholder mounts nothing', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root({ type: 'NONE', width: 0, height: 0 }));
        expect(surface.calls).toEqual([]);
        expect(document.querySelector(`.${SURFACE_PANE_CLASS}`)).toBeNull();
    });

    it('disposes the surface with the page, and takes its pane and body class away', () => {
        const dispose = vi.fn();
        const { host } = hostWith([recordingSurface({ dispose })]);
        render(host, root());
        window.dispatchEvent(new Event('pagehide'));
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(document.querySelector(`.${SURFACE_PANE_CLASS}`)).toBeNull();
        expect(document.body.classList.contains(SURFACE_BODY_CLASS)).toBe(false);
        expect(host.mounted()).toBe(false);
    });

    it('uses the last of several surfaces bound, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const first = recordingSurface({ id: 'first' });
        const second = recordingSurface({ id: 'second' });
        const { host } = hostWith([first, second]);
        render(host, root());
        expect(first.calls).toEqual([]);
        expect(second.calls[0]).toEqual(['mount']);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('without a surface', () => {
    it('leaves the page as it was, and still hears the renders', () => {
        const { host } = hostWith(undefined);
        const heard: string[] = [];
        host.onRender(r => heard.push(r.id));
        const before = document.body.innerHTML;
        render(host, root());
        expect(document.body.innerHTML).toBe(before);
        expect(document.body.classList.contains(SURFACE_BODY_CLASS)).toBe(false);
        expect(heard).toEqual(['graph']);
        expect(host.content()).toBeUndefined();
        expect(host.surfaceReady()).toBe(true);
    });
});

describe('the surface\'s selection', () => {
    const picked: SurfaceSelection = {
        ids: ['shape:7'],
        title: 'Rectangle 7',
        kind: 'Rectangle',
        sections: [{ title: 'Geometry', rows: [{ label: 'Width', value: '12' }, { label: 'Next', value: [{ text: 'Rectangle 8', link: 'shape:8' }] }] }],
        bounds: { x: 70, y: 0, width: 12, height: 9 }
    };

    it('is kept, heard with its cause, and framed by Fit and Center while it lasts', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root());
        const heard: Array<[string | undefined, string]> = [];
        host.onSelectionChanged((selection, cause) => heard.push([selection?.title, cause]));
        surface.context!.setSelection(picked);
        expect(host.currentSelection()).toEqual(picked);
        expect(surface.context!.selection()?.ids).toEqual(['shape:7']);
        expect(host.content()).toEqual({ bounds: { x: 0, y: 0, width: 400, height: 200 }, selectionBounds: picked.bounds });
        surface.context!.setSelection(undefined);
        expect(heard).toEqual([['Rectangle 7', 'surface'], [undefined, 'surface']]);
        // The surface cleared it itself: it is not told again.
        expect(surface.calls.some(c => c[0] === 'selectionCleared')).toBe(false);
    });

    it('clears the graph\'s selection when it comes, and is cleared by a node selected', () => {
        const surface = recordingSurface();
        const { host, dispatched } = hostWith([surface]);
        render(host, root());
        host.selectionChanged(undefined, ['node:a']);
        surface.context!.setSelection(picked);
        expect(dispatched.at(-1)).toMatchObject({ kind: 'elementSelected', selectedElementsIDs: [], deselectAll: true });
        const heard: string[] = [];
        host.onSelectionChanged((_selection, cause) => heard.push(cause));
        host.selectionChanged(undefined, []); // the deselection it dispatched coming back
        expect(host.currentSelection()).toBeDefined();
        host.selectionChanged(undefined, ['node:b']);
        expect(host.currentSelection()).toBeUndefined();
        expect(heard).toEqual(['graph']);
        expect(surface.calls.filter(c => c[0] === 'selectionCleared')).toHaveLength(1);
    });

    it('is cleared by Escape, but not by Escape typed into a field', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        render(host, root());
        surface.context!.setSelection(picked);
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(host.currentSelection()).toBeDefined();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(host.currentSelection()).toBeUndefined();
        expect(surface.calls.filter(c => c[0] === 'selectionCleared')).toHaveLength(1);
    });

    it('refuses a selection without a title or ids, and copies a good one', () => {
        expect(normalizeSurfaceSelection({ ids: 'x', title: 'y' } as any)).toBeUndefined();
        expect(normalizeSurfaceSelection({ ids: ['x'] } as any)).toBeUndefined();
        const copy = normalizeSurfaceSelection({ ...picked, bounds: { x: 0, y: 0, width: -1, height: 1 } })!;
        expect(copy.bounds).toBeUndefined();
        expect(copy.sections![0].rows[1].value).toEqual([{ text: 'Rectangle 8', link: 'shape:8' }]);
    });
});

describe('a click where no diagram element is', () => {
    it('reaches the surface in the model\'s coordinates; a drag does not', () => {
        const surface = recordingSurface();
        const { host } = hostWith([surface]);
        const r = root({ scroll: { x: 100, y: 50 }, zoom: 4 });
        render(host, r);
        const listener = new SurfaceClickListener();
        (listener as any).surfaceHost = host;
        const event = (x: number, y: number, detail = 1) => ({ clientX: x, clientY: y, button: 0, detail, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }) as MouseEvent;

        listener.mouseDown(r, event(40, 20));
        listener.mouseUp(r, event(42, 21));
        listener.mouseDown(r, event(40, 20));
        listener.mouseUp(r, event(140, 20)); // a pan
        listener.mouseDown({ id: 'node:a', parent: r }, event(40, 20));
        listener.mouseUp({ id: 'node:a', parent: r }, event(40, 20)); // on a node: the graph's

        const clicks = surface.calls.filter(c => c[0] === 'click').map(c => c[1] as any);
        expect(clicks).toHaveLength(1);
        expect(clicks[0]).toMatchObject({ x: 100 + 42 / 4, y: 50 + 21 / 4, canvasX: 42, canvasY: 21, clickCount: 1, shiftKey: true });
    });
});

describe('helpers', () => {
    it('tells the root from any other element without walking to it', () => {
        expect(asViewportRoot(root())).toBeDefined();
        const child = { id: 'n', get index(): never { throw new Error('walked'); } };
        expect(asViewportRoot(child)).toBeUndefined();
    });

    it('reads VS Code\'s theme from the body', () => {
        const body = (classes: string[]) => ({ classList: { contains: (c: string) => classes.includes(c) } });
        expect(themeOf(body(['vscode-light']))).toEqual({ kind: 'light' });
        expect(themeOf(body(['vscode-dark']))).toEqual({ kind: 'dark' });
        expect(themeOf(body(['vscode-high-contrast']))).toEqual({ kind: 'high-contrast' });
        expect(themeOf(body(['vscode-high-contrast', 'vscode-high-contrast-light']))).toEqual({ kind: 'high-contrast-light' });
    });

    it('takes an image as bytes, a buffer, a blob or a data URL', async () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        expect(await toBytes(png)).toBe(png);
        expect(Array.from((await toBytes(png.buffer))!)).toEqual(Array.from(png));
        expect(Array.from((await toBytes(new Blob([png])))!)).toEqual(Array.from(png));
        expect(Array.from((await toBytes('data:image/png;base64,iVBORw=='))!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(await toBytes('not a data url')).toBeUndefined();
        expect(await toBytes(undefined)).toBeUndefined();
    });
});
