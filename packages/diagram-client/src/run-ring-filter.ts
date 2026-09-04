/**
 * The bloom the running ring glows with.
 *
 * The ring is the node's perimeter cut into slices, each stroked its own hue,
 * because SVG has no conic gradient. Slices alone read as a flat rainbow
 * outline; the glow is what makes it look like light rather than a coloured
 * border, so the filter is not decoration on top of the effect — it is most of
 * it.
 *
 * Defined once for the document rather than per node. `url(#id)` resolves
 * across the whole document, so one definition serves every diagram, and the
 * alternative — a copy inside each running node — would put the same id in the
 * document many times over.
 */
import { IDiagramStartup } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

export const RUN_RING_FILTER_ID = 'wf-run-ring-bloom';

const HOST_ELEMENT_ID = 'dialogram-run-ring-filter';

/**
 * Blur the ring, lay it under itself twice, then the ring on top.
 *
 * Twice because one pass of blur is a haze rather than a glow, and stacking the
 * same result costs nothing more to compute. `sRGB` interpolation on purpose:
 * the default linearRGB washes saturated hues towards grey, which is the whole
 * point of the ring.
 */
export function runRingFilterMarkup(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true"`
        + ` style="position:absolute">`
        + `<defs>`
        + `<filter id="${RUN_RING_FILTER_ID}" x="-40%" y="-40%" width="180%" height="180%"`
        + ` color-interpolation-filters="sRGB">`
        + `<feGaussianBlur stdDeviation="2.6" result="blurred"/>`
        + `<feMerge>`
        + `<feMergeNode in="blurred"/>`
        + `<feMergeNode in="blurred"/>`
        + `<feMergeNode in="SourceGraphic"/>`
        + `</feMerge>`
        + `</filter>`
        + `</defs>`
        + `</svg>`;
}

/** Idempotent: a reload replaces the definition rather than adding a second. */
export function installRunRingFilter(): void {
    document.getElementById(HOST_ELEMENT_ID)?.remove();
    // Parsed in an HTML context so the SVG namespace is applied for us; building
    // it element by element would mean createElementNS at every level.
    const holder = document.createElement('div');
    holder.innerHTML = runRingFilterMarkup();
    const svgElement = holder.firstElementChild;
    if (!svgElement) {
        return;
    }
    svgElement.id = HOST_ELEMENT_ID;
    document.body.appendChild(svgElement);
}

/** Installed before the first render, so a node running immediately still glows. */
@injectable()
export class WorkflowRunRingFilterStartup implements IDiagramStartup {
    rank = -100;

    preInitialize(): void {
        installRunRingFilter();
    }
}
