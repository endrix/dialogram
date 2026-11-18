/**
 * A diagram surface: something a product draws under the diagram's SVG, in the
 * diagram's own coordinates, while the platform keeps the viewport, Fit and
 * Center, the palette, the outline, the property panel and the chat.
 *
 * A product's webview module binds one:
 *
 * ```ts
 * bind(DiagramSurface).toConstantValue({
 *     id: 'my-surface',
 *     mount(context) { this.context = context; return canvas; },
 *     render(viewport) { draw(canvas, viewport); },
 *     bounds() { return dataBounds; }
 * });
 * ```
 *
 * Everything here is plain data and plain DOM: a surface never sees a Sprotty
 * or GLSP type, so it can be written, tested and bundled without either, and a
 * change of GLSP version does not reach it. The platform translates between
 * this contract and its viewer (`diagram-surface-host.ts`).
 *
 * Coordinates are the model's: the same units the graph's nodes are placed in.
 * A viewport says which model point is at the canvas's top-left corner
 * (`scrollX`, `scrollY`) and how many CSS pixels one model unit takes
 * (`zoom`), so a model point `(x, y)` is drawn at CSS pixel
 * `((x - scrollX) * zoom, (y - scrollY) * zoom)` of the element the surface
 * mounted, and at that times `devicePixelRatio` in device pixels.
 */
import type { SurfaceSelectionSummary } from '@dialogram/shared';

/** A rectangle in the model's coordinates. */
export interface SurfaceBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** What the canvas shows, as the surface draws it. */
export interface SurfaceViewport {
    /** The model point at the canvas's top-left corner. */
    readonly scrollX: number;
    readonly scrollY: number;
    /** CSS pixels per model unit. */
    readonly zoom: number;
    /** The canvas's size in CSS pixels. */
    readonly width: number;
    readonly height: number;
    /** Device pixels per CSS pixel, for a sharp backing store. */
    readonly devicePixelRatio: number;
}

/** The colour theme VS Code shows the webview in. */
export interface SurfaceTheme {
    readonly kind: 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';
}

/** The zoom range, in CSS pixels per model unit. */
export interface SurfaceZoomLimits {
    readonly min: number;
    readonly max: number;
}

/**
 * A click on the canvas where no diagram element is: the press and the
 * release a few pixels apart at most, so a pan is never a click.
 */
export interface SurfacePoint {
    /** Where, in the model's coordinates. */
    readonly x: number;
    readonly y: number;
    /** Where, in CSS pixels from the canvas's top-left corner. */
    readonly canvasX: number;
    readonly canvasY: number;
    readonly button: number;
    /** 1 for a click, 2 for the second click of a double click. */
    readonly clickCount: number;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
}

/**
 * Part of a value: text, and where it leads when it is a link. A link is the
 * surface's own string; the platform hands it back to `followLink` unread.
 */
export interface SurfaceValuePart {
    readonly text: string;
    readonly link?: string;
    /** The tooltip. */
    readonly title?: string;
}

/** What a row says: plain text, or parts of which some are links. */
export type SurfaceValue = string | number | boolean | readonly SurfaceValuePart[];

/** One labelled value, as the property panel shows a node's. */
export interface SurfaceRow {
    readonly label: string;
    readonly value: SurfaceValue;
    /** The whole value leads there: shorthand for a value of one part with this link. */
    readonly link?: string;
}

/** A titled list of rows: a section of the property panel. */
export interface SurfaceSection {
    readonly title: string;
    readonly rows: readonly SurfaceRow[];
    /** How many rows were left out: the panel says "and N more" under the rows. */
    readonly more?: number;
    /** Drawn closed, a click away. */
    readonly collapsed?: boolean;
}

/**
 * What the surface reports as selected. The platform shows it in the property
 * panel as it shows a node, puts it in the chat's selection context, and
 * clears it as it clears any selection.
 */
export interface SurfaceSelection {
    /**
     * The surface's own stable ids for what is selected. They reach the chat
     * and a profile's selection hooks; they name nothing in the graph.
     */
    readonly ids: readonly string[];
    /** What the panel's Name row and the chat call it. */
    readonly title: string;
    /** What kind of thing it is: the panel's Type row. */
    readonly kind?: string;
    /** A line under the name and kind ("1 of 2 here: click again for the one beneath"). */
    readonly note?: string;
    /** Where it is written: the panel's Opens row, which opens the file at the line. */
    readonly source?: { readonly uri: string; readonly line?: number };
    /** The panel's sections after Basic Info, in this order. */
    readonly sections?: readonly SurfaceSection[];
    /** Where it is: Center and Fit frame it while it is selected. */
    readonly bounds?: SurfaceBounds;
}

/** The model the diagram shows, as far as a surface is concerned. */
export interface SurfaceModel {
    /**
     * The producer's `graph.meta.surface`, as it sent it, or `undefined`
     * when it sent none. Plain JSON; small, since it rides on every model.
     */
    readonly data: unknown;
    /** The file the diagram shows, when the producer says so. */
    readonly sourceUri?: string;
}

/** An image of what the surface shows: PNG bytes, or a `data:image/png` URL. */
export type SurfaceImage = Blob | ArrayBuffer | Uint8Array | string;

/** A message a product's webview code exchanges with its extension host. */
export interface HostMessage {
    readonly type: string;
    readonly [key: string]: unknown;
}

/** Undo what was done: stop listening. */
export interface SurfaceDisposable {
    dispose(): void;
}

/**
 * The product's own channel to its extension host (`host-messages.ts`); the
 * host side is `DiagramProfile.onWebviewMessage` and `postToWebview`.
 */
export interface HostMessaging {
    /** Send to the host. Types starting with `dialogram.` or `chat.` are the platform's and are refused. */
    post(message: HostMessage): boolean;
    /** Hear what the host sends; never the platform's own messages. */
    onMessage(listener: (message: HostMessage) => void): SurfaceDisposable;
}

/** What the platform gives a surface when it mounts it. */
export interface DiagramSurfaceContext {
    /** Draw again at the next frame, for a change that comes with no viewport change (data arrived). */
    requestRender(): void;
    /**
     * The surface's bounds changed (data arrived): the first view, which waits
     * for the content to have bounds, looks again.
     */
    boundsChanged(): void;
    /** Report what is selected; `undefined` clears it. */
    setSelection(selection: SurfaceSelection | undefined): void;
    /** What the surface last reported as selected and the platform has not cleared. */
    selection(): SurfaceSelection | undefined;
    /** The viewport now; `undefined` until the canvas has a size. */
    viewport(): SurfaceViewport | undefined;
    /** Move the view, within the zoom limits. */
    setViewport(viewport: { scrollX: number; scrollY: number; zoom: number }, options?: { animate?: boolean }): void;
    /**
     * Bring a rectangle into view, in the middle of the free area (`freeArea`):
     * at the zoom there is, or fitted with `fit`.
     */
    reveal(bounds: SurfaceBounds, options?: { animate?: boolean; fit?: boolean }): void;
    /** What the palette's Fit does. */
    fit(options?: { animate?: boolean }): void;
    /**
     * The largest part of the canvas the platform's overlays leave free (the
     * palette, the buttons, the breadcrumb, the chat card, the outline, a
     * floating property panel), in CSS pixels from the canvas's top-left;
     * `undefined` until the canvas has a size. Fit and Center place the
     * content there.
     */
    freeArea(): { x: number; y: number; width: number; height: number } | undefined;
    /** The theme now. */
    theme(): SurfaceTheme;
    /** The product's channel to its extension host. */
    readonly host: HostMessaging;
}

/**
 * The contribution point. Bind one in a product's webview feature module:
 * `bind(DiagramSurface).toConstantValue(surface)`. One surface per diagram:
 * when several are bound, the last one wins.
 */
export const DiagramSurface = Symbol.for('dialogram.DiagramSurface');

export interface DiagramSurface {
    /** Names the surface in warnings. */
    readonly id: string;
    /**
     * The zoom range this surface needs, in CSS pixels per model unit. It wins
     * over `clientBehavior.zoomLimits`, which wins over GLSP's 0.1 to 20.
     */
    readonly zoomLimits?: SurfaceZoomLimits;
    /**
     * Make the element to draw in. The platform puts it under the diagram's
     * SVG, sized to the canvas, and calls `render` right after. Called once.
     */
    mount(context: DiagramSurfaceContext): HTMLElement;
    /**
     * Draw the viewport. Called on every viewport change (a pan, a zoom, each
     * frame of an animated Fit), the first one included, and after
     * `requestRender`. Keep it to a frame's budget.
     */
    render(viewport: SurfaceViewport): void;
    /**
     * What the surface draws, in the model's coordinates; `undefined` while
     * it has nothing. Fit and Center frame it together with the graph.
     */
    bounds?(): SurfaceBounds | undefined;
    /** A model arrived with other `graph.meta.surface` data than the last (and once at first). */
    modelChanged?(model: SurfaceModel): void;
    /** The theme changed; `render` follows. */
    themeChanged?(theme: SurfaceTheme): void;
    /** The canvas changed size or device pixel ratio; `render` follows. */
    resized?(viewport: SurfaceViewport): void;
    /**
     * A click where no diagram element is. Answer with `context.setSelection`,
     * or not at all. A double click there is the surface's alone: the
     * platform shows no root properties over a surface that has `click`.
     */
    click?(point: SurfacePoint): void;
    /** A link of the selection's rows was clicked in the property panel. */
    followLink?(link: string): void;
    /** The platform cleared the surface's selection (Escape, a click on a node). */
    selectionCleared?(): void;
    /** An image of what is drawn, for the palette's export button. Without it, the export is the SVG's. */
    exportImage?(): Promise<SurfaceImage | undefined> | SurfaceImage | undefined;
    /** The diagram is going away. */
    dispose?(): void;
}

/** Plain-number checks on what a surface or a profile hands the platform. */
export function isValidBounds(bounds: SurfaceBounds | undefined): bounds is SurfaceBounds {
    return !!bounds
        && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
        && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
        && bounds.width >= 0 && bounds.height >= 0;
}

/** A zoom range the viewer can use: positive, finite, ordered. */
export function isValidZoomLimits(limits: unknown): limits is SurfaceZoomLimits {
    const candidate = limits as Partial<SurfaceZoomLimits> | undefined;
    return !!candidate
        && typeof candidate.min === 'number' && typeof candidate.max === 'number'
        && Number.isFinite(candidate.min) && Number.isFinite(candidate.max)
        && candidate.min > 0 && candidate.max > candidate.min;
}

/** The plain text of a row's value. */
export function surfaceValueText(value: SurfaceValue): string {
    if (Array.isArray(value)) {
        return (value as readonly SurfaceValuePart[]).map(part => part.text).join('');
    }
    return String(value);
}

/** The most of a selection the chat is told: enough to say what it is, never a dump. */
const SUMMARY_IDS = 50;
const SUMMARY_ROWS = 40;
const SUMMARY_VALUE_CHARS = 200;

/**
 * A selection as the chat's context carries it: text only, its links' text
 * kept and their targets dropped (they mean something to the surface, not to
 * an agent), and capped.
 */
export function summarizeSurfaceSelection(selection: SurfaceSelection): SurfaceSelectionSummary {
    const clip = (text: string) => text.length > SUMMARY_VALUE_CHARS ? `${text.slice(0, SUMMARY_VALUE_CHARS - 1)}…` : text;
    const rows: SurfaceSelectionSummary['rows'] = [];
    for (const section of selection.sections ?? []) {
        for (const row of section.rows) {
            if (rows.length >= SUMMARY_ROWS) {
                break;
            }
            rows.push({ section: section.title, label: row.label, value: clip(surfaceValueText(row.value)) });
        }
    }
    return {
        ids: selection.ids.slice(0, SUMMARY_IDS).map(String),
        title: selection.title,
        ...(selection.kind ? { kind: selection.kind } : {}),
        rows
    };
}
