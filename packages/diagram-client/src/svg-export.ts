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
