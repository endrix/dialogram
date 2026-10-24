/**
 * Extracting the rendered diagram as a standalone SVG.
 *
 * Ported from the mlir-viewer (packages/client/src/svg-export.ts), whose
 * reasoning holds here unchanged. The diagram is already drawn: the browser has
 * laid out every label, resolved every theme variable and routed every edge, so
 * the honest export is the rendered SVG itself, not a second renderer that would
 * drift from it. What has to be undone is everything that made it part of a
 * webview: the styles live in a stylesheet the file will not have, the geometry
 * is relative to a viewport that scrolls and zooms, and the arrowhead defs sit
 * at the root.
 *
 * So: clone the subtree, inline the computed value of the properties that decide
 * how it looks, lift it out of the zoom/pan transform into a viewBox of its own,
 * and carry the defs and the background along. The result opens in a browser, an
 * image viewer, Inkscape or a diff.
 */

/**
 * Properties that decide how an SVG element looks. Copied from the computed style.
 *
 * A property missing here is a silent difference between the export and the
 * diagram. `svg-export-coverage.test.ts` fails when the stylesheet grows a
 * property neither list carries and NOT_EXPORTED does not excuse.
 */
export const SVG_STYLE_PROPS = [
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'opacity',
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'letter-spacing',
    'paint-order',
    'marker-start',
    'marker-mid',
    'marker-end',
    'filter',
    // A non-scaling stroke keeps borders crisp when zoomed out. The export
    // bakes the viewport zoom into its transform, so without this the borders
    // are multiplied by it.
    'vector-effect',
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-decoration-thickness',
    'text-underline-offset',
    'text-transform',
    'font-variant-numeric',
    'word-spacing',
    'writing-mode',
    'clip-path',
    'mask',
    'mix-blend-mode',
    'shape-rendering',
    'text-rendering',
    // Port circles and node corners take their geometry from the stylesheet.
    'r',
    'rx',
    'ry'
];

/**
 * HTML inside a <foreignObject> (the browser does the box layout) needs the
 * box-model properties instead.
 */
export const HTML_STYLE_PROPS = [
    'display',
    'grid-template-columns',
    'grid-auto-rows',
    'gap',
    'column-gap',
    'row-gap',
    'align-items',
    'justify-content',
    'box-sizing',
    'width',
    'height',
    'padding',
    'margin',
    'border',
    'border-radius',
    'background-color',
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'text-align',
    'white-space',
    'overflow',
    'overflow-y',
    'text-overflow',
    // `border` and `padding` shorthands compute to nothing when the sides differ,
    // so the sides are asked for individually.
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-color',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'background',
    'background-image',
    'background-position',
    'background-size',
    'box-shadow',
    'opacity',
    'letter-spacing',
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-underline-offset',
    'text-transform',
    'font-variant-numeric',
    'min-width',
    'max-width',
    'min-height',
    'max-height',
    'flex',
    'flex-direction',
    'flex-wrap',
    'word-break',
    'overflow-wrap',
    'overflow-x',
    'flex-shrink',
    'justify-self',
    'vertical-align',
    'tab-size',
    'transform'
];

/**
 * A url() in a computed style may come back absolute, `url("vscode-webview://…#arrow")`,
 * and that reference is dead in a file. The fragment is what matters; the defs
 * travel with the export.
 */
export function localizeUrls(value: string): string {
    return value.replace(/url\(["']?[^"')]*#([^"')]+)["']?\)/g, 'url(#$1)');
}

/**
 * A computed colour can come back as `color(srgb 0.89 0.94 1)`, CSS Color 4,
 * which the browser is happy to hand out and standalone SVG renderers are not
 * all happy to take back. librsvg and Inkscape do not parse it at all, and a
 * `fill` they cannot parse falls back to the SVG initial value: black. Everything
 * is normalised to rgb()/rgba(), which every renderer has understood for twenty
 * years.
 */
export function normalizeColors(value: string): string {
    return value.replace(
        /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/g,
        (_all, r: string, g: string, b: string, a: string | undefined) => {
            const to255 = (c: string) => Math.round(Math.min(1, Math.max(0, Number(c))) * 255);
            const rgb = `${to255(r)}, ${to255(g)}, ${to255(b)}`;
            return a === undefined || Number(a) >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${a})`;
        }
    );
}

/** The two properties whose initial value is a colour, not `none`. */
const PAINT_PROPS = new Set(['fill', 'stroke']);

function isHtmlElement(el: Element): boolean {
    return el.namespaceURI === 'http://www.w3.org/1999/xhtml';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The colours of a CSS colour list (`#f00, rgb(0 255 0), #00f`): split at the
 * commas that are not inside a function's parentheses.
 */
export function splitColorList(value: string): string[] {
    const colors: string[] = [];
    let depth = 0;
    let current = '';
    for (const character of value) {
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth = Math.max(0, depth - 1);
        }
        if (character === ',' && depth === 0) {
            colors.push(current.trim());
            current = '';
        } else {
            current += character;
        }
    }
    colors.push(current.trim());
    return colors.filter(color => color !== '');
}

/** Where a running node's ring goes as a plain stroke, in the node's coordinates. */
export interface RunRingStroke {
    x: number;
    y: number;
    width: number;
    height: number;
    rx: number;
    strokeWidth: number;
}

/**
 * The stroke that stands for a running node's ring in an export. The ring is
 * a band `ringWidth` wide just inside the node's edge (the foreignObject that
 * holds it reaches `bleed` past the edge on every side, for the glow), so the
 * stroke runs down the middle of that band, its corners following the band's
 * outer radius.
 */
export function runRingStroke(
    box: { x: number; y: number; width: number; height: number },
    bleed: number,
    ringWidth: number,
    outerRadius: number
): RunRingStroke {
    const half = ringWidth / 2;
    return {
        x: box.x + bleed + half,
        y: box.y + bleed + half,
        width: Math.max(0, box.width - 2 * bleed - ringWidth),
        height: Math.max(0, box.height - 2 * bleed - ringWidth),
        rx: Math.max(0, outerRadius - half),
        strokeWidth: ringWidth
    };
}

/** The numbering of the ring gradients in the export being made (reset per export). */
let runRingCount = 0;

/**
 * A colour stop's colour: a conic gradient's stop may carry positions after
 * its colour (`#0af 0 50%`), which no colour property takes.
 */
export function stopColor(stop: string): string {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const character of stop.trim()) {
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth = Math.max(0, depth - 1);
        }
        if (/\s/.test(character) && depth === 0) {
            if (current !== '') {
                parts.push(current);
            }
            current = '';
        } else {
            current += character;
        }
    }
    if (current !== '') {
        parts.push(current);
    }
    while (parts.length > 1 && /^-?[\d.]+(%|deg|grad|rad|turn|px|em|rem)?$/.test(parts[parts.length - 1])) {
        parts.pop();
    }
    return parts.join(' ');
}

let colorCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * A colour as `rgb()`/`rgba()`, as the browser resolves it, or nothing when
 * it is not one. Painted on a pixel and read back, so a colour any engine
 * takes (`oklch()`, `color-mix()`) comes out in a form every SVG renderer
 * reads; a canvas keeps such a colour as written when asked for its style.
 */
function resolveColor(stop: string): string | undefined {
    const color = stopColor(stop);
    if (colorCanvas === undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        colorCanvas = canvas.getContext('2d', { willReadFrequently: true });
    }
    const context = colorCanvas;
    if (!context) {
        return color !== '' ? normalizeColors(color) : undefined;
    }
    // A colour the canvas does not take leaves its fill as it was: try it over
    // two different fills, and only a colour neither keeps is not one.
    const takes = ['#000000', '#ffffff'].some(previous => {
        context.fillStyle = previous;
        context.fillStyle = color;
        return String(context.fillStyle) !== previous;
    });
    if (!takes) {
        return undefined;
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
}

/** What the export needs of a ring, as the browser resolved it. */
export interface RunRingLook {
    /** The band's width, the editor's padding. */
    ringWidth: number;
    /** How far the foreignObject reaches past the node's edge. */
    bleed: number;
    /** The band's outer corner radius. */
    radius: number;
    /** The ring's colours, resolved. */
    colors: string[];
}

/** The two methods of a document `runRingElement` builds with. */
type ElementFactory = { createElementNS(namespace: string, name: string): Element };

/**
 * The ring as the export draws it: a rect stroked with the ring's colours
 * (as a linear sweep, where the editor turns a conic one) down the middle of
 * the band. Nothing where the editor draws nothing: a band of no width, or
 * fewer than two colours, which is no conic gradient at all. The glow is left
 * out; the band alone says the node is running.
 */
export function runRingElement(
    doc: ElementFactory,
    box: { x: number; y: number; width: number; height: number },
    look: RunRingLook,
    gradientId: string
): Element | undefined {
    if (!(look.ringWidth > 0) || look.colors.length < 2) {
        return undefined;
    }
    const stroke = runRingStroke(box, look.bleed, look.ringWidth, look.radius);
    const group = doc.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'node-run-ring');
    const defs = doc.createElementNS(SVG_NS, 'defs');
    const gradient = doc.createElementNS(SVG_NS, 'linearGradient');
    gradient.setAttribute('id', gradientId);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '1');
    gradient.setAttribute('y2', '1');
    look.colors.forEach((color, index) => {
        const stop = doc.createElementNS(SVG_NS, 'stop');
        stop.setAttribute('offset', String(index / (look.colors.length - 1)));
        stop.setAttribute('stop-color', color);
        gradient.appendChild(stop);
    });
    defs.appendChild(gradient);
    group.appendChild(defs);
    const rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(stroke.x));
    rect.setAttribute('y', String(stroke.y));
    rect.setAttribute('width', String(stroke.width));
    rect.setAttribute('height', String(stroke.height));
    rect.setAttribute('rx', String(stroke.rx));
    rect.setAttribute('style', `fill:none;stroke:url(#${gradientId});stroke-width:${stroke.strokeWidth}`);
    group.appendChild(rect);
    return group;
}

/**
 * A running node's ring, for the export.
 *
 * In the editor the ring is HTML inside a foreignObject: a turning
 * conic-gradient square, absolutely placed and masked down to a band. A file
 * cannot carry that. Standalone SVG renderers do not draw HTML at all, and
 * even a browser would need the box placement and the mask, which the export
 * copies for no other HTML. So the ring is drawn as what it reads as, from
 * the band as the browser laid it out: its padding is the ring's width, its
 * offset the bleed, its corner the radius.
 */
function exportedRunRing(source: Element, clone: Element): Element | undefined {
    const doc = clone.ownerDocument;
    const band = source.querySelector('.node-run-ring-band');
    if (!doc || !band) {
        return undefined;
    }
    const number = (name: string) => Number(source.getAttribute(name));
    const box = { x: number('x'), y: number('y'), width: number('width'), height: number('height') };
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
        return undefined;
    }
    const style = window.getComputedStyle(band);
    const resolvedOr = (value: string, fallback: number) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const look: RunRingLook = {
        ringWidth: resolvedOr(style.paddingTop, 0),
        bleed: resolvedOr(style.top, -box.x),
        radius: resolvedOr(style.borderTopLeftRadius, 0),
        colors: splitColorList(style.getPropertyValue('--wf-ring-colors'))
            .map(resolveColor)
            .filter((color): color is string => color !== undefined)
    };
    return runRingElement(doc, box, look, `run-ring-${++runRingCount}`);
}

/**
 * Walk the rendered element and its clone in step, writing the computed look
 * onto the clone. Hidden elements are dropped rather than styled, so a file is
 * never many times larger than the picture it shows.
 */
function inlineStyles(source: Element, clone: Element): void {
    const computed = window.getComputedStyle(source);
    if (computed.display === 'none' || computed.visibility === 'hidden') {
        clone.remove();
        return;
    }
    if (source.localName === 'foreignObject' && source.classList.contains('node-run-ring')) {
        const ring = exportedRunRing(source, clone);
        if (ring) {
            clone.replaceWith(ring);
        } else {
            clone.remove();
        }
        return;
    }

    const props = isHtmlElement(source) ? HTML_STYLE_PROPS : SVG_STYLE_PROPS;
    const declarations: string[] = [];
    for (const prop of props) {
        const value = computed.getPropertyValue(prop);
        if (!value || value === 'normal' || value === 'auto') {
            continue;
        }
        // `none` is the initial value everywhere except paint, where the SVG
        // initial is black, so an unfilled shape that stays silent comes out
        // solid. Everywhere else, saying `none` is saying nothing.
        if (value === 'none' && !PAINT_PROPS.has(prop)) {
            continue;
        }
        declarations.push(`${prop}:${normalizeColors(localizeUrls(value))}`);
    }
    if (declarations.length > 0) {
        clone.setAttribute('style', declarations.join(';'));
    }

    // cloneNode(true) preserves structure, so the children line up by index,
    // until one is removed above, which is why the lists are snapshotted first.
    const sourceChildren = Array.from(source.children);
    const cloneChildren = Array.from(clone.children);
    for (let i = 0; i < sourceChildren.length && i < cloneChildren.length; i++) {
        inlineStyles(sourceChildren[i], cloneChildren[i]);
    }
}

/** The box the subtree occupies after `matrix`, in the exported document's coordinates. */
function transformedBounds(el: SVGGraphicsElement, matrix: DOMMatrix) {
    const box = el.getBBox();
    const corners = [
        new DOMPoint(box.x, box.y),
        new DOMPoint(box.x + box.width, box.y),
        new DOMPoint(box.x, box.y + box.height),
        new DOMPoint(box.x + box.width, box.y + box.height)
    ].map(p => p.matrixTransform(matrix));
    const xs = corners.map(p => p.x);
    const ys = corners.map(p => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** A file name that survives every filesystem, from whatever the diagram is called. */
export function svgFileName(rawName: string): string {
    const cleaned = rawName
        .replace(/[^\w.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 80) : 'diagram';
}

export interface ExtractedSvg {
    svg: string;
    /** Suggested base name (no extension) for the save dialog. */
    name: string;
    /** What was exported, for the confirmation message. */
    elementCount: number;
}

/**
 * The rendered diagram: sprotty's root svg and, inside it, the group that
 * carries the viewport's scale and translation with every element under it.
 */
export function renderedDiagram(): { svgRoot: SVGSVGElement; graph: SVGGraphicsElement } | undefined {
    const svgRoot = document.querySelector('.sprotty svg');
    if (!(svgRoot instanceof SVGSVGElement)) {
        return undefined;
    }
    const graph = Array.from(svgRoot.children).find(c => c instanceof SVGGElement);
    return graph instanceof SVGGraphicsElement ? { svgRoot, graph } : undefined;
}

/**
 * Extract `el` as a self-contained SVG document.
 *
 * The diagram's root group is exported at 1:1 whatever the viewport's zoom, so
 * two exports of one diagram compare, and a non-scaling stroke is right. A
 * subtree below the root keeps its place through its CTM, as in the
 * mlir-viewer, whose export is one node at the zoom it was looked at.
 */
export function extractSvg(el: SVGGraphicsElement, label: string, atScaleOne = true): ExtractedSvg | undefined {
    const svgRoot = el.ownerSVGElement;
    if (!svgRoot) {
        return undefined;
    }
    // getCTM() maps the element's own user space to the root viewport and
    // already includes the element's transform, so the clone drops its own, or
    // the placement is applied twice.
    const matrix = atScaleOne ? new DOMMatrix() : el.getCTM();
    if (!matrix) {
        return undefined;
    }
    const bounds = transformedBounds(el, matrix);
    const pad = 12;
    // Ring gradients are numbered per export, so two exports of one diagram
    // are the same text.
    runRingCount = 0;

    const clone = el.cloneNode(true) as SVGGraphicsElement;
    inlineStyles(el, clone);
    clone.removeAttribute('transform');

    const doc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null);
    const out = doc.documentElement;
    out.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    out.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    out.setAttribute('width', String(Math.ceil(bounds.width + pad * 2)));
    out.setAttribute('height', String(Math.ceil(bounds.height + pad * 2)));
    out.setAttribute(
        'viewBox',
        `${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`
    );

    // The diagram is drawn for a themed editor background; on white it can be
    // unreadable. The background travels with it.
    const background =
        window.getComputedStyle(svgRoot).backgroundColor ||
        window.getComputedStyle(document.body).backgroundColor;
    if (background && background !== 'rgba(0, 0, 0, 0)') {
        const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(bounds.x - pad));
        rect.setAttribute('y', String(bounds.y - pad));
        rect.setAttribute('width', String(bounds.width + pad * 2));
        rect.setAttribute('height', String(bounds.height + pad * 2));
        rect.setAttribute('fill', normalizeColors(background));
        out.appendChild(rect);
    }

    // Arrowheads and markers live in the root's defs, and the styles above still
    // refer to them by fragment.
    for (const defs of Array.from(svgRoot.querySelectorAll('defs'))) {
        out.appendChild(doc.importNode(defs, true));
    }

    const wrapper = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    if (!atScaleOne) {
        wrapper.setAttribute(
            'transform',
            `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`
        );
    }
    wrapper.appendChild(doc.importNode(clone, true));
    out.appendChild(wrapper);

    const serialized = new XMLSerializer().serializeToString(doc);
    return {
        svg: `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}\n`,
        name: svgFileName(label),
        elementCount: clone.querySelectorAll('*').length + 1
    };
}
