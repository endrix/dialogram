/**
 * A running node's ring in an export: a stroke in the ring's colours on the
 * node's edge, not the editor's masked HTML square, which a file cannot carry
 * (standalone renderers draw no HTML, and the box placement and mask it needs
 * are not copied).
 */
import { describe, expect, it } from 'vitest';
import { runRingElement, runRingStroke, splitColorList, stopColor } from '../src/svg-export';

describe('the run ring in an export', () => {
    it('reads the ring colours, commas inside a function kept', () => {
        expect(splitColorList('#ff5f6d, #ffc371,#f9f871')).toEqual(['#ff5f6d', '#ffc371', '#f9f871']);
        expect(splitColorList('rgb(1, 2, 3), color(srgb 0.1 0.2 0.3 / 0.5), hsl(10 20% 30%)'))
            .toEqual(['rgb(1, 2, 3)', 'color(srgb 0.1 0.2 0.3 / 0.5)', 'hsl(10 20% 30%)']);
        expect(splitColorList('')).toEqual([]);
    });

    it('runs the stroke down the middle of the band, just inside the node’s edge', () => {
        // The foreignObject reaches 6 px past a 200 × 74 node on every side.
        const stroke = runRingStroke({ x: -6, y: -6, width: 212, height: 86 }, 6, 1.5, 4);
        expect(stroke).toEqual({ x: 0.75, y: 0.75, width: 198.5, height: 72.5, rx: 3.25, strokeWidth: 1.5 });
    });

    it('never draws a negative box or radius', () => {
        const stroke = runRingStroke({ x: -6, y: -6, width: 12, height: 12 }, 6, 2, 0);
        expect(stroke.width).toBe(0);
        expect(stroke.height).toBe(0);
        expect(stroke.rx).toBe(0);
    });

    it('takes a stop’s colour without its positions', () => {
        expect(stopColor('#0af 0 50%')).toBe('#0af');
        expect(stopColor('rgb(1 2 3) 10% 20%')).toBe('rgb(1 2 3)');
        expect(stopColor('  oklch(0.7 0.15 30)  ')).toBe('oklch(0.7 0.15 30)');
        expect(stopColor('#ff5f6d')).toBe('#ff5f6d');
    });

    /** Just enough of a document for the builder: elements with attributes and children. */
    class FakeElement {
        readonly attributes = new Map<string, string>();
        readonly children: FakeElement[] = [];
        constructor(readonly name: string) {}
        setAttribute(key: string, value: string): void {
            this.attributes.set(key, String(value));
        }
        appendChild(child: FakeElement): FakeElement {
            this.children.push(child);
            return child;
        }
        find(name: string): FakeElement[] {
            return [...this.children.filter(child => child.name === name), ...this.children.flatMap(child => child.find(name))];
        }
    }
    const doc = { createElementNS: (_namespace: string, name: string) => new FakeElement(name) as unknown as Element };
    const box = { x: -6, y: -6, width: 212, height: 86 };
    const look = { ringWidth: 1.5, bleed: 6, radius: 4, colors: ['rgb(255, 0, 0)', 'rgb(0, 255, 0)', 'rgb(0, 0, 255)'] };

    it('draws the band as a rect stroked with a sweep of the ring’s colours', () => {
        const ring = runRingElement(doc, box, look, 'run-ring-1') as unknown as FakeElement;
        expect(ring.attributes.get('class')).toBe('node-run-ring');
        const [gradient] = ring.find('linearGradient');
        expect(gradient.attributes.get('id')).toBe('run-ring-1');
        expect(gradient.find('stop').map(stop => [stop.attributes.get('offset'), stop.attributes.get('stop-color')])).toEqual([
            ['0', 'rgb(255, 0, 0)'], ['0.5', 'rgb(0, 255, 0)'], ['1', 'rgb(0, 0, 255)']
        ]);
        const [rect] = ring.find('rect');
        expect(Object.fromEntries(rect.attributes)).toEqual({
            x: '0.75', y: '0.75', width: '198.5', height: '72.5', rx: '3.25',
            style: 'fill:none;stroke:url(#run-ring-1);stroke-width:1.5'
        });
    });

    it('draws nothing where the editor draws nothing: no band width, or no gradient', () => {
        expect(runRingElement(doc, box, { ...look, ringWidth: 0 }, 'r')).toBeUndefined();
        expect(runRingElement(doc, box, { ...look, colors: ['rgb(255, 0, 0)'] }, 'r')).toBeUndefined();
        expect(runRingElement(doc, box, { ...look, colors: [] }, 'r')).toBeUndefined();
    });
});
