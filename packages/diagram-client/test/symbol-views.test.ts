/**
 * A symbol's body and its stubs (symbol-views.ts): every pin's stub ends on
 * the body's back where the server put the pin, an OR's on its curve.
 */
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
        expect(pins).toEqual({ west: [13.5], east: [23.5] });
    });

    it('show an operator’s glyph and a register’s name', () => {
        const texts = (nodes: Drawn[]) => nodes.filter(n => n.tag === 'text').flatMap(n => n.children);
        const op = renderSymbolBody('operator', SymbolGeometry.size('operator', 2, 1), { west: [], east: [] }, '==') as unknown as Drawn[];
        expect(texts(op)).toEqual(['==']);
        const reg = renderSymbolBody('register', SymbolGeometry.size('register', 2, 1), { west: [], east: [] }, undefined, 'count') as unknown as Drawn[];
        expect(texts(reg)).toEqual(['count']);
    });
});
