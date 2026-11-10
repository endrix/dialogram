/**
 * A symbol's body and its stubs (symbol-views.ts): every pin's stub ends on
 * the body's back where the server put the pin, an OR's on its curve.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SymbolGeometry } from '@dialogram/shared';
import { renderSymbolBody, symbolPath, symbolPinsOf } from '../src/symbol-views';

/** What the test stub's `svg` returns (test/glsp-stub.ts). */
interface Drawn {
    tag: string;
    props: any;
    children: unknown[];
}

describe('symbol views', () => {
    it('draw every kind as a closed outline inside the box', () => {
        for (const kind of SymbolGeometry.KINDS) {
            const { width, height } = SymbolGeometry.size(kind, 2, 1);
            const d = symbolPath(kind, width, SymbolGeometry.bodyHeight(kind, height));
            expect(d.startsWith('M ')).toBe(true);
            expect(d.trim().endsWith('Z')).toBe(true);
            const xs = [...d.matchAll(/-?\d+(\.\d+)?/g)].map(m => Number(m[0]));
            expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
            expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(width, height));
        }
    });

    it('end each input stub on the back, curved for an OR', () => {
        const size = SymbolGeometry.size('or', 2, 1);
        const pins = { west: [0, 1].map(k => SymbolGeometry.pinY(size.height, 2, k)), east: [size.height / 2] };
        const nodes = renderSymbolBody('or', size, pins) as unknown as Drawn[];
        const stubs = nodes.filter(n => n.props?.class?.['symbol-stub']).map(n => n.props.attrs);
        expect(stubs).toHaveLength(3);
        for (const y of pins.west) {
            const stub = stubs.find(a => a.y1 === y && a.x1 === 0);
            expect(stub.x2).toBeCloseTo(SymbolGeometry.backX('or', size.height, y));
            expect(stub.x2).toBeGreaterThan(SymbolGeometry.STUB_PX);  // the curve bulges in
        }
    });

    it('read the pins off the node’s ports, by side', () => {
        const pins = symbolPinsOf([
            { type: 'port:input', position: { x: -4.5, y: 10 }, size: { width: 9, height: 7 } },
            { type: 'port:output', position: { x: 45.5, y: 20 }, size: { width: 9, height: 7 } },
            { type: 'comp:header', position: { x: 0, y: 0 } }
        ], 50);
        // An output's wire begins on its port's outer rim, half a box outside the node.
        expect(pins).toEqual({ west: [13.5], east: [23.5], eastEnds: [54.5] });
        // Each by its own port: a wider one (a bus's) moves no other.
        expect(symbolPinsOf([
            { type: 'port:output', position: { x: 45.5, y: 0 }, size: { width: 9, height: 7 } },
            { type: 'port:output', position: { x: 45, y: 20 }, size: { width: 10, height: 10 } }
        ], 50).eastEnds).toEqual([54.5, 55]);
    });

    it('carry each wire on into the symbol: an output’s out to where its wire begins, an input’s from the border its arrow points at', () => {
        const size = SymbolGeometry.size('register', 2, 1);
        const pins = { west: [10, 20], east: [15], eastEnds: [size.width + 4.5] };
        const stubs = (renderSymbolBody('register', size, pins) as unknown as Drawn[])
            .filter(n => n.props?.class?.['symbol-stub']).map(n => n.props.attrs);
        expect(stubs.filter(a => a.x1 === 0).map(a => a.y1)).toEqual([10, 20]);
        expect(stubs.filter(a => a.x2 === size.width + 4.5).map(a => a.y1)).toEqual([15]);
        // Without the ends, at the border.
        const bare = (renderSymbolBody('register', size, { west: [], east: [15] }) as unknown as Drawn[])
            .filter(n => n.props?.class?.['symbol-stub']).map(n => n.props.attrs);
        expect(bare[0].x2).toBe(size.width);
        // As wide as a wire: the same variable the edges are drawn with.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const css = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');
        expect(css).toMatch(/\.symbol-node \.symbol-stub \{[^}]*stroke-width: var\(--workflow-edge-width, 3\.5px\)/);
        // Square ends: a round cap would cover an input arrow's point.
        expect(css).toMatch(/\.symbol-node \.symbol-stub \{[^}]*stroke-linecap: butt/);
        expect(css).toMatch(/\.workflow-edge \.edge-line \{[^}]*stroke-width: var\(--workflow-edge-width, 3\.5px\)/);
    });

    it('show an operator’s glyph and a register’s name', () => {
        const texts = (nodes: Drawn[]) => nodes.filter(n => n.tag === 'text').flatMap(n => n.children);
        const op = renderSymbolBody('operator', SymbolGeometry.size('operator', 2, 1), { west: [], east: [] }, '==') as unknown as Drawn[];
        expect(texts(op)).toEqual(['==']);
        const reg = renderSymbolBody('register', SymbolGeometry.size('register', 2, 1), { west: [], east: [] }, undefined, 'count') as unknown as Drawn[];
        expect(texts(reg)).toEqual(['count']);
    });

    it('draw a captioned mux’s body above its caption', () => {
        const size = SymbolGeometry.size('mux', 2, 1, undefined, true);
        const nodes = renderSymbolBody('mux', size, { west: [], east: [] }, undefined, 'u_mux') as unknown as Drawn[];
        const body = SymbolGeometry.bodyHeight('mux', size.height, true);
        expect(body).toBe(size.height - SymbolGeometry.CAPTION_HEIGHT_PX);
        const hit = nodes.find(n => n.props?.class?.['symbol-hit']);
        expect(hit?.props.attrs.height).toBe(body);
        const caption = nodes.find(n => n.props?.class?.['symbol-caption']);
        expect(caption?.children).toEqual(['u_mux']);
        expect(caption?.props.attrs.y).toBe(body + 3);
        // Without one, the body is the whole box.
        const bare = renderSymbolBody('mux', SymbolGeometry.size('mux', 2, 1), { west: [], east: [] }) as unknown as Drawn[];
        expect(bare.find(n => n.props?.class?.['symbol-hit'])?.props.attrs.height).toBe(SymbolGeometry.size('mux', 2, 1).height);
    });
});
