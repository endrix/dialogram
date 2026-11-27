// @vitest-environment happy-dom
/**
 * What a product asks of an export: by default all the text, whatever the
 * zoom draws; what is on screen, when it offers that; and without what its
 * structural picture leaves out.
 */
import { describe, expect, it } from 'vitest';
import { extractSvg } from '../src/svg-export';

// happy-dom's createDocument leaves out the root element it is asked for; a
// browser's does not.
const createDocument = document.implementation.createDocument.bind(document.implementation);
document.implementation.createDocument = ((namespace: string | null, name: string | null, type?: DocumentType | null) => {
    const doc = createDocument(namespace, name, type);
    if (!doc.documentElement && name) {
        doc.appendChild(doc.createElementNS(namespace, name));
    }
    return doc;
}) as typeof document.implementation.createDocument;

/** A diagram drawn far out: the node's name is hidden by the level of detail. */
function drawnFarOut(): SVGGraphicsElement {
    document.head.innerHTML = '<style>.detail-far .zoom-name { display: none; }</style>';
    document.body.innerHTML = `
        <div class="sprotty"><svg class="sprotty-graph detail-far"><g id="root">
            <g class="node"><rect width="40" height="20"></rect><text class="zoom-name">Aligner</text>
                <g class="port"><circle r="2"></circle></g><g class="port"><circle r="2"></circle></g>
            </g>
        </g></svg></div>`;
    const root = document.getElementById('root') as unknown as SVGGraphicsElement & Record<string, unknown>;
    // happy-dom lays nothing out: the box and the placement are the test's.
    root.getBBox = () => ({ x: 0, y: 0, width: 40, height: 20 });
    root.getCTM = () => new DOMMatrix();
    return root;
}

const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);

describe('extractSvg, as a product asks', () => {
    it('carries all the text by default, and puts the level of detail back', () => {
        const root = drawnFarOut();
        const extracted = extractSvg(root, 'Aligner');
        expect(texts(extracted!.svg)).toEqual(['Aligner']);
        expect(root.ownerSVGElement!.classList.contains('detail-far')).toBe(true);
    });

    it('carries only what the view draws at its zoom when asked for what is displayed', () => {
        const extracted = extractSvg(drawnFarOut(), 'Aligner', { asDisplayed: true });
        expect(texts(extracted!.svg)).toEqual([]);
    });

    it('leaves out what the product names, and keeps the rest', () => {
        const extracted = extractSvg(drawnFarOut(), 'Aligner', { leaveOut: '.port' });
        expect(extracted!.svg).not.toMatch(/class="port"/);
        expect(extracted!.svg).toMatch(/<rect/);
        expect(texts(extracted!.svg)).toEqual(['Aligner']);
    });
});
