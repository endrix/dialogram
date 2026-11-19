/**
 * The platform's side of a diagram surface (`diagram-surface.ts`): it mounts
 * the surface under the SVG, tells it every viewport, gives Fit and Center its
 * bounds, carries its clicks in and its selection out, and disposes it.
 *
 * It is the main viewer's postprocessor: Sprotty renders on every viewport
 * change, each frame of an animation included, and calls `postUpdate` after
 * each, with the root it rendered seen in `decorate` just before. That is the
 * one place where the viewport the reader sees is known as soon as it is
 * drawn, so the surface draws in the same frame as the SVG.
 *
 * Without a surface bound it only remembers the root it saw, for the first
 * view (`initial-viewport-service.ts`); nothing in the page changes.
 */
import { TYPES, MouseListener, type IActionDispatcher, type ISelectionListener } from '@eclipse-glsp/client';
import { FitToScreenAction, SelectAction, SetViewportAction } from '@eclipse-glsp/protocol';
import { inject, injectable, multiInject, optional } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import {
    DiagramSurface,
    isValidBounds,
    surfacesBound,
    type DiagramSurfaceContext,
    type SurfaceBounds,
    type SurfacePoint,
    type SurfaceRow,
    type SurfaceSection,
    type SurfaceSelection,
    type SurfaceTheme,
    type SurfaceViewport,
    type SurfaceValue,
    type SurfaceDisposable
} from './diagram-surface';
import { hostMessaging } from './host-messages';
import { FIT_MARGIN, keepOnCanvas, largestFreeArea, viewportCentredIn, viewportClearOf, withinZoomLimits } from './fit-geometry';
import { overlaysOn } from './canvas-overlays';

/** The body class while a surface is mounted: what the platform's CSS keys on. */
export const SURFACE_BODY_CLASS = 'dialogram-has-surface';
/** The base div's class while it holds a surface. */
export const SURFACE_HOST_CLASS = 'dialogram-surface-host';
/** The element the surface's own is put in. */
export const SURFACE_PANE_CLASS = 'dialogram-surface';
/**
 * Fired on the document once a surface is mounted: what the page drew
 * before it (the palette's export button, its tooltip) says so again.
 */
export const SURFACE_MOUNTED_EVENT = 'dialogram-surface-mounted';

/**
 * Why the surface's selection changed: the surface said so, a node was
 * selected, Escape, or a click on nothing for a surface that hears no clicks.
 */
export type SurfaceSelectionCause = 'surface' | 'graph' | 'escape' | 'click';

/** The root as the host reads it: plain fields of Sprotty's viewport root. */
export interface ViewportRoot {
    id: string;
    type: string;
    scroll: { x: number; y: number };
    zoom: number;
    canvasBounds: { x: number; y: number; width: number; height: number };
    args?: Record<string, unknown>;
    index?: unknown;
}

/**
 * Whether an element is the root being rendered. Cheap, since `decorate` sees
 * every element: only a viewport root has a zoom, so the first test settles
 * it for every other element (a child's `index` walks up to the root; it is
 * not read).
 */
export function asViewportRoot(element: unknown): ViewportRoot | undefined {
    const candidate = element as Partial<ViewportRoot> | undefined;
    return candidate && typeof candidate.zoom === 'number' && candidate.scroll && candidate.canvasBounds
        ? candidate as ViewportRoot
        : undefined;
}

/** The viewport of a root, as a surface draws it; nothing while the canvas has no size. */
export function surfaceViewportOf(root: ViewportRoot | undefined, devicePixelRatio = 1): SurfaceViewport | undefined {
    const canvas = root?.canvasBounds;
    if (!root || !canvas || !(canvas.width > 0 && canvas.height > 0) || !(root.zoom > 0)) {
        return undefined;
    }
    return {
        scrollX: root.scroll.x,
        scrollY: root.scroll.y,
        zoom: root.zoom,
        width: canvas.width,
        height: canvas.height,
        devicePixelRatio: devicePixelRatio > 0 ? devicePixelRatio : 1
    };
}

function sameViewport(a: SurfaceViewport | undefined, b: SurfaceViewport | undefined): boolean {
    return !!a && !!b && a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom
        && a.width === b.width && a.height === b.height && a.devicePixelRatio === b.devicePixelRatio;
}

/** VS Code's theme, from the classes it puts on the webview's body. */
export function themeOf(body: { classList: { contains(name: string): boolean } } | undefined): SurfaceTheme {
    const has = (name: string): boolean => !!body?.classList.contains(name);
    if (has('vscode-high-contrast-light')) {
        return { kind: 'high-contrast-light' };
    }
    if (has('vscode-high-contrast')) {
        return { kind: 'high-contrast' };
    }
    return { kind: has('vscode-light') ? 'light' : 'dark' };
}

/**
 * A selection as the platform keeps it: copied, so the surface changing its
 * object later changes nothing, and checked, so a malformed one is refused
 * here rather than half-drawn in the panel.
 */
export function normalizeSurfaceSelection(selection: SurfaceSelection): SurfaceSelection | undefined {
    if (!selection || typeof selection !== 'object' || typeof selection.title !== 'string' || !Array.isArray(selection.ids)) {
        return undefined;
    }
    const value = (raw: SurfaceValue): SurfaceValue => Array.isArray(raw)
        ? raw.filter(part => part && typeof part.text === 'string').map(part => ({
            text: part.text,
            ...(typeof part.link === 'string' ? { link: part.link } : {}),
            ...(typeof part.title === 'string' ? { title: part.title } : {})
        }))
        : typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw ?? '');
    // A row's `link` is shorthand for a value of one part that leads there.
    const rowValue = (row: SurfaceRow): SurfaceValue => typeof row.link === 'string' && !Array.isArray(row.value)
        ? [{ text: String(row.value ?? ''), link: row.link }]
        : value(row.value);
    const sections: SurfaceSection[] = Array.isArray(selection.sections)
        ? selection.sections.filter((section: SurfaceSection) => section && typeof section.title === 'string' && Array.isArray(section.rows)).map((section: SurfaceSection) => ({
            title: section.title,
            rows: section.rows.filter(row => row && typeof row.label === 'string').map(row => ({ label: row.label, value: rowValue(row) })),
            ...(typeof section.more === 'number' && section.more > 0 ? { more: Math.floor(section.more) } : {}),
            ...(section.collapsed ? { collapsed: true } : {})
        }))
        : [];
    const source = selection.source;
    return {
        ids: selection.ids.map(String),
        title: selection.title,
        ...(typeof selection.kind === 'string' && selection.kind !== '' ? { kind: selection.kind } : {}),
        ...(typeof selection.note === 'string' && selection.note !== '' ? { note: selection.note } : {}),
        ...(source && typeof source.uri === 'string' && source.uri !== ''
            ? { source: { uri: source.uri, ...(typeof source.line === 'number' && source.line > 0 ? { line: Math.floor(source.line) } : {}) } }
            : {}),
        sections,
        ...(isValidBounds(selection.bounds) ? { bounds: { ...selection.bounds } } : {})
    };
}

/** A key a person types into: Escape there is the field's, not the diagram's. */
function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element || typeof element.closest !== 'function') {
        return false;
    }
    return element.isContentEditable
        || !!element.closest('input, textarea, select, [contenteditable="true"], .workflow-chat-panel, .monaco-editor');
}

/** The host of the one diagram in this webview, for the palette's export button. */
let activeHost: DiagramSurfaceHost | undefined;

/** The surface host of this webview's diagram, once a surface is mounted. */
export function mountedSurfaceHost(): DiagramSurfaceHost | undefined {
    return activeHost?.mounted() ? activeHost : undefined;
}

@injectable()
export class DiagramSurfaceHost implements ISelectionListener {
    @multiInject(DiagramSurface) @optional()
    protected readonly contributedSurfaces: readonly DiagramSurface[] | undefined;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    @inject(TYPES.ViewerOptions) @optional()
    protected readonly viewerOptions?: { baseDiv?: string; zoomLimits?: { min: number; max: number } };

    private resolved = false;
    private bound: DiagramSurface | undefined;

    /** The root of the last render, and the one before it, to tell a new model. */
    private root: ViewportRoot | undefined;
    private modelRoot: ViewportRoot | undefined;
    private modelKey: string | undefined;

    private pane: HTMLElement | undefined;
    private element: HTMLElement | undefined;
    private lastViewport: SurfaceViewport | undefined;
    private lastSize: string | undefined;
    private renderQueued = false;
    private theme: SurfaceTheme = { kind: 'dark' };
    private disposed = false;
    private readonly teardown: Array<() => void> = [];

    private selection: SurfaceSelection | undefined;
    private graphSelectionSize = 0;
    private readonly selectionListeners = new Set<(selection: SurfaceSelection | undefined, cause: SurfaceSelectionCause) => void>();
    private readonly renderListeners = new Set<(root: ViewportRoot) => void>();
    private readonly boundsListeners = new Set<() => void>();

    /** The surface bound, if any: the last one, when a product bound several. */
    surface(): DiagramSurface | undefined {
        if (!this.resolved) {
            this.resolved = true;
            const surfaces = surfacesBound(this.contributedSurfaces);
            if (surfaces.length > 1) {
                // eslint-disable-next-line no-console
                console.warn(`[dialogram] ${surfaces.length} diagram surfaces are bound (${surfaces.map(s => s.id).join(', ')}); the last one, ${surfaces.at(-1)!.id}, is used`);
            }
            this.bound = surfaces.at(-1);
        }
        return this.bound;
    }

    /** Whether the surface's element is in the page. */
    mounted(): boolean {
        return !!this.pane && !this.disposed;
    }

    // ── The main viewer's postprocessor ─────────────────────────────────

    decorate<T>(vnode: T, element: unknown): T {
        const root = asViewportRoot(element);
        if (root) {
            this.root = root;
        }
        return vnode;
    }

    postUpdate(): void {
        const root = this.root;
        if (!root || this.disposed) {
            return;
        }
        for (const listener of [...this.renderListeners]) {
            listener(root);
        }
        const surface = this.surface();
        if (!surface || root.type === 'NONE') {
            return;
        }
        if (!this.mount(surface)) {
            return;
        }
        this.noticeModel(surface, root);
        this.draw(false);
    }

    /** The root of the last render. */
    currentRoot(): ViewportRoot | undefined {
        return this.root;
    }

    /** Hear every render, with its root: the first view waits on them. */
    onRender(listener: (root: ViewportRoot) => void): SurfaceDisposable {
        this.renderListeners.add(listener);
        return { dispose: () => this.renderListeners.delete(listener) };
    }

    /** Hear the surface say its bounds changed. */
    onBoundsChanged(listener: () => void): SurfaceDisposable {
        this.boundsListeners.add(listener);
        return { dispose: () => this.boundsListeners.delete(listener) };
    }

    /** What Fit and Center frame besides the graph (`viewport-content.ts`). */
    content(): { bounds?: SurfaceBounds; selectionBounds?: SurfaceBounds } | undefined {
        const surface = this.surface();
        if (!surface || this.disposed) {
            return undefined;
        }
        let bounds: SurfaceBounds | undefined;
        try {
            bounds = surface.bounds?.();
        } catch (error) {
            this.warn('bounds', error);
        }
        return {
            ...(isValidBounds(bounds) ? { bounds } : {}),
            ...(isValidBounds(this.selection?.bounds) ? { selectionBounds: this.selection!.bounds } : {})
        };
    }

    /**
     * Whether the content has bounds for a first view: a surface that has
     * `bounds` must have answered; without one, the graph's are enough.
     */
    surfaceReady(): boolean {
        const surface = this.surface();
        if (!surface || typeof surface.bounds !== 'function') {
            return true;
        }
        return isValidBounds(this.content()?.bounds);
    }

    // ── Mounting and drawing ─────────────────────────────────────────────

    private baseDiv(): HTMLElement | null {
        const id = this.viewerOptions?.baseDiv;
        return typeof document === 'undefined' || !id ? null : document.getElementById(id);
    }

    private mount(surface: DiagramSurface): boolean {
        const base = this.baseDiv();
        if (!base) {
            return false;
        }
        if (!this.pane) {
            const pane = document.createElement('div');
            pane.className = SURFACE_PANE_CLASS;
            pane.setAttribute('aria-hidden', 'true');
            this.pane = pane;
            this.theme = themeOf(document.body);
            activeHost = this;
            try {
                const element = surface.mount(this.context());
                if (element) {
                    this.element = element;
                    pane.appendChild(element);
                }
            } catch (error) {
                this.warn('mount', error);
            }
            this.watchPage();
            document.dispatchEvent(new Event(SURFACE_MOUNTED_EVENT));
        }
        // Sprotty replaces the placeholder it was given on its first patch: the
        // pane goes into the base div that is in the page now.
        if (this.pane.parentElement !== base) {
            base.insertBefore(this.pane, base.firstChild);
        }
        base.classList.add(SURFACE_HOST_CLASS);
        document.body.classList.add(SURFACE_BODY_CLASS);
        return true;
    }

    /** The pane exactly over the SVG: the canvas the viewport is of. */
    private place(viewport: SurfaceViewport): void {
        const pane = this.pane;
        const base = pane?.parentElement;
        if (!pane || !base) {
            return;
        }
        const svg = base.querySelector(':scope > svg') as SVGElement | null;
        let left = 0;
        let top = 0;
        if (svg) {
            const s = svg.getBoundingClientRect();
            const b = base.getBoundingClientRect();
            left = s.left - b.left + base.scrollLeft;
            top = s.top - b.top + base.scrollTop;
        }
        pane.style.left = `${left}px`;
        pane.style.top = `${top}px`;
        pane.style.width = `${viewport.width}px`;
        pane.style.height = `${viewport.height}px`;
    }

    private viewport(): SurfaceViewport | undefined {
        return surfaceViewportOf(this.root, typeof window === 'undefined' ? 1 : window.devicePixelRatio);
    }

    /** Draw when the viewport changed, or always when `force`. */
    private draw(force: boolean): void {
        const surface = this.surface();
        const viewport = this.viewport();
        if (!surface || !viewport || !this.pane || this.disposed) {
            return;
        }
        if (!force && sameViewport(viewport, this.lastViewport)) {
            return;
        }
        const size = `${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}`;
        if (size !== this.lastSize) {
            this.place(viewport);
            if (this.lastSize !== undefined) {
                try {
                    surface.resized?.(viewport);
                } catch (error) {
                    this.warn('resized', error);
                }
            }
            this.lastSize = size;
        }
        this.lastViewport = viewport;
        try {
            surface.render(viewport);
        } catch (error) {
            this.warn('render', error);
        }
    }

    private requestRender(): void {
        if (this.renderQueued || this.disposed) {
            return;
        }
        this.renderQueued = true;
        const run = () => {
            this.renderQueued = false;
            this.draw(true);
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 0);
        }
    }

    /** A new model: the surface hears its data when that changed. */
    private noticeModel(surface: DiagramSurface, root: ViewportRoot): void {
        if (root === this.modelRoot) {
            return;
        }
        this.modelRoot = root;
        const data = root.args?.[WorkflowDiagramMetadata.SURFACE];
        // The file of the view shown, as the server stamps it on the root
        // (`gmodel-convert.ts`), else the document the editor has open.
        const documentUri = (globalThis as { diagramIdentifier?: { uri?: unknown } }).diagramIdentifier?.uri;
        const sourceUri = [root.args?.sourceUri, documentUri].find((uri): uri is string => typeof uri === 'string' && uri !== '');
        let key: string;
        try {
            key = `${sourceUri ?? ''}\u0000${JSON.stringify(data) ?? ''}`;
        } catch {
            key = `${sourceUri ?? ''}\u0000${String(data)}`;
        }
        if (key === this.modelKey) {
            return;
        }
        this.modelKey = key;
        try {
            surface.modelChanged?.({ data, ...(sourceUri ? { sourceUri } : {}) });
        } catch (error) {
            this.warn('modelChanged', error);
        }
    }

    /** The theme, the device pixel ratio, Escape, and the page going away. */
    private watchPage(): void {
        if (typeof document === 'undefined') {
            return;
        }
        if (typeof MutationObserver === 'function') {
            const observer = new MutationObserver(() => {
                const theme = themeOf(document.body);
                if (theme.kind === this.theme.kind) {
                    return;
                }
                this.theme = theme;
                try {
                    this.surface()?.themeChanged?.(theme);
                } catch (error) {
                    this.warn('themeChanged', error);
                }
                this.requestRender();
            });
            observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            this.teardown.push(() => observer.disconnect());
        }
        this.watchPixelRatio();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && this.selection && !isTypingTarget(event.target)) {
                this.clearSelection('escape');
            }
        };
        document.addEventListener('keydown', onKey);
        this.teardown.push(() => document.removeEventListener('keydown', onKey));
        if (typeof window !== 'undefined') {
            const onHide = () => this.dispose();
            window.addEventListener('pagehide', onHide);
            this.teardown.push(() => window.removeEventListener('pagehide', onHide));
        }
    }

    /** A window dragged to a screen of another density: drawn again, sharp. */
    private watchPixelRatio(): void {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const onChange = () => {
            stop();
            this.requestRender();
            this.watchPixelRatio();
        };
        query.addEventListener?.('change', onChange, { once: true });
        const stop = () => query.removeEventListener?.('change', onChange);
        this.teardown.push(stop);
    }

    /** The diagram is going away: so is the surface. */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const undo of this.teardown.splice(0)) {
            try {
                undo();
            } catch {
                // Best-effort: the page is going.
            }
        }
        try {
            this.surface()?.dispose?.();
        } catch (error) {
            this.warn('dispose', error);
        }
        this.pane?.remove();
        this.pane = undefined;
        if (typeof document !== 'undefined') {
            document.body.classList.remove(SURFACE_BODY_CLASS);
        }
        if (activeHost === this) {
            activeHost = undefined;
        }
    }

    // ── What the surface is given ────────────────────────────────────────

    private context(): DiagramSurfaceContext {
        return {
            requestRender: () => this.requestRender(),
            boundsChanged: () => {
                for (const listener of [...this.boundsListeners]) {
                    listener();
                }
            },
            setSelection: selection => this.setSelectionFromSurface(selection),
            selection: () => this.selection,
            viewport: () => this.viewport(),
            setViewport: (viewport, options) => this.setViewport(viewport, options?.animate === true),
            reveal: (bounds, options) => this.reveal(bounds, options ?? {}),
            fit: options => {
                void this.actionDispatcher.dispatch(FitToScreenAction.create([], { animate: options?.animate !== false }));
            },
            freeArea: () => this.freeArea(),
            theme: () => this.theme,
            host: hostMessaging
        };
    }

    private setViewport(viewport: { scrollX: number; scrollY: number; zoom: number }, animate: boolean): void {
        const root = this.root;
        if (!root || ![viewport.scrollX, viewport.scrollY, viewport.zoom].every(Number.isFinite) || !(viewport.zoom > 0)) {
            return;
        }
        void this.actionDispatcher.dispatch(SetViewportAction.create(
            root.id,
            { scroll: { x: viewport.scrollX, y: viewport.scrollY }, zoom: viewport.zoom },
            { animate }
        ));
    }

    /** The largest part of the canvas the overlays leave free, in the canvas's CSS pixels. */
    freeArea(): { x: number; y: number; width: number; height: number } | undefined {
        const canvas = this.root?.canvasBounds;
        if (!canvas || !(canvas.width > 0 && canvas.height > 0)) {
            return undefined;
        }
        return largestFreeArea(canvas, overlaysOn(canvas));
    }

    private reveal(bounds: SurfaceBounds, options: { animate?: boolean; fit?: boolean }): void {
        const viewport = this.viewport();
        if (!viewport || !isValidBounds(bounds)) {
            return;
        }
        const animate = options.animate !== false;
        const canvas = this.root!.canvasBounds;
        // As Fit and Center do it: fitted clear of the overlays (else into the
        // whole canvas), at a zoom within the limits with the middle kept; or
        // centred in the free area at the zoom there is. On the canvas, either way.
        const fitted = options.fit
            ? viewportClearOf(bounds, canvas, overlaysOn(canvas), FIT_MARGIN) ?? viewportClearOf(bounds, canvas, [], FIT_MARGIN)
            : undefined;
        const framed = options.fit
            ? fitted && keepOnCanvas(withinZoomLimits(fitted, bounds, this.viewerOptions?.zoomLimits), bounds, canvas)
            : keepOnCanvas(viewportCentredIn(bounds, this.freeArea() ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }, viewport.zoom), bounds, canvas);
        if (framed) {
            this.setViewport({ scrollX: framed.scroll.x, scrollY: framed.scroll.y, zoom: framed.zoom }, animate);
        }
    }

    /**
     * A click where no diagram element is, from `SurfaceClickListener`. A
     * surface that hears clicks decides what one means, a clear included; one
     * that does not (it selects from a host message, say) has its selection
     * cleared by a click on nothing, as a node's is.
     */
    click(event: { clientX: number; clientY: number; button: number; detail: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): void {
        const surface = this.surface();
        const root = this.root;
        if (!surface || !root || !this.mounted()) {
            return;
        }
        if (!surface.click) {
            this.clearSelection('click');
            return;
        }
        const svg = this.pane?.parentElement?.querySelector(':scope > svg') as SVGElement | null | undefined;
        const origin = svg?.getBoundingClientRect() ?? { left: root.canvasBounds.x, top: root.canvasBounds.y };
        const canvasX = event.clientX - origin.left;
        const canvasY = event.clientY - origin.top;
        const point: SurfacePoint = {
            x: root.scroll.x + canvasX / root.zoom,
            y: root.scroll.y + canvasY / root.zoom,
            canvasX,
            canvasY,
            button: event.button,
            clickCount: Math.max(1, event.detail || 1),
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey
        };
        try {
            surface.click(point);
        } catch (error) {
            this.warn('click', error);
        }
    }

    /** A link of the selection's rows, clicked in the property panel. */
    followLink(link: string): void {
        try {
            this.surface()?.followLink?.(link);
        } catch (error) {
            this.warn('followLink', error);
        }
    }

    /** An image of the surface for the export, as PNG bytes; nothing when it offers none. */
    async exportImage(): Promise<Uint8Array | undefined> {
        const surface = this.surface();
        if (!surface?.exportImage) {
            return undefined;
        }
        return toBytes(await surface.exportImage());
    }

    /** Whether the surface offers an image for the export. */
    exportsImage(): boolean {
        return typeof this.surface()?.exportImage === 'function';
    }

    // ── Selection ────────────────────────────────────────────────────────

    /** What the surface reports as selected, until it or the platform clears it. */
    currentSelection(): SurfaceSelection | undefined {
        return this.selection;
    }

    /** Hear the surface's selection change, and why. */
    onSelectionChanged(listener: (selection: SurfaceSelection | undefined, cause: SurfaceSelectionCause) => void): SurfaceDisposable {
        this.selectionListeners.add(listener);
        return { dispose: () => this.selectionListeners.delete(listener) };
    }

    private setSelectionFromSurface(selection: SurfaceSelection | undefined): void {
        if (selection === undefined) {
            if (this.selection) {
                this.selection = undefined;
                this.notifySelection('surface');
            }
            return;
        }
        const normalized = normalizeSurfaceSelection(selection);
        if (!normalized) {
            // eslint-disable-next-line no-console
            console.warn(`[dialogram] surface ${this.surface()?.id}: a selection needs a title and an ids array; ignored`);
            return;
        }
        this.selection = normalized;
        // One selection at a time: the graph's goes when the surface's comes.
        if (this.graphSelectionSize > 0) {
            void this.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [], deselectedElementsIDs: true }));
        }
        this.notifySelection('surface');
    }

    /** Clear the surface's selection for the platform's reasons: Escape, a node selected. */
    clearSelection(cause: Exclude<SurfaceSelectionCause, 'surface'>): void {
        if (!this.selection) {
            return;
        }
        this.selection = undefined;
        try {
            this.surface()?.selectionCleared?.();
        } catch (error) {
            this.warn('selectionCleared', error);
        }
        this.notifySelection(cause);
    }

    private notifySelection(cause: SurfaceSelectionCause): void {
        for (const listener of [...this.selectionListeners]) {
            try {
                listener(this.selection, cause);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.warn('[dialogram] a surface selection listener failed:', error);
            }
        }
        this.requestRender();
    }

    /** The graph's selection: a node selected clears the surface's. */
    selectionChanged(_root: unknown, selectedElements: string[]): void {
        this.graphSelectionSize = selectedElements?.length ?? 0;
        if (this.graphSelectionSize > 0) {
            this.clearSelection('graph');
        }
    }

    private warn(hook: string, error: unknown): void {
        // eslint-disable-next-line no-console
        console.warn(`[dialogram] surface ${this.surface()?.id}: ${hook} failed:`, error);
    }
}

/** PNG bytes from what a surface's `exportImage` answered. */
export async function toBytes(image: unknown): Promise<Uint8Array | undefined> {
    if (image === undefined || image === null) {
        return undefined;
    }
    if (image instanceof Uint8Array) {
        return image;
    }
    if (image instanceof ArrayBuffer) {
        return new Uint8Array(image);
    }
    if (typeof Blob !== 'undefined' && image instanceof Blob) {
        return new Uint8Array(await image.arrayBuffer());
    }
    if (typeof image === 'string') {
        const match = /^data:[^;,]*;base64,(.*)$/s.exec(image);
        if (!match) {
            return undefined;
        }
        const binary = atob(match[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
    return undefined;
}

/**
 * A click where no diagram element is, for the surface: a press and release
 * on the root, a few pixels apart at most, so a pan is not a click.
 */
@injectable()
export class SurfaceClickListener extends MouseListener {
    @inject(DiagramSurfaceHost)
    protected readonly surfaceHost!: DiagramSurfaceHost;

    private pressed: { x: number; y: number } | undefined;

    override mouseDown(target: unknown, event: MouseEvent): never[] {
        this.pressed = this.isRoot(target) && event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
        return [];
    }

    override mouseUp(target: unknown, event: MouseEvent): never[] {
        const pressed = this.pressed;
        this.pressed = undefined;
        if (pressed && this.isRoot(target) && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 4) {
            this.surfaceHost.click(event);
        }
        return [];
    }

    private isRoot(target: unknown): boolean {
        return !!asViewportRoot(target);
    }
}
