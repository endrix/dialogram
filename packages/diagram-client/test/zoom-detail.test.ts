/**
 * How much text the diagram draws at the zoom it is looked at: none on the
 * nodes zoomed out, their names in between, everything zoomed in. The root svg
 * says which, and the stylesheet hides the rest; the hidden render and an
 * export draw everything.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DETAIL_CLASSES, DETAIL_ZOOM, NAME_ZOOM, ZOOM_TEXT_CLASSES, detailLevel, markDetail, withFullDetail } from '../src/zoom-detail';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(path.resolve(here, '../src', name), 'utf8');

describe('the level of detail', () => {
    it('is no text far out, names in between, everything close in, and everything when the zoom is not known', () => {
        expect(NAME_ZOOM).toBeLessThan(DETAIL_ZOOM);
        expect(detailLevel(0.2)).toBe('far');
        expect(detailLevel(NAME_ZOOM - 0.01)).toBe('far');
        expect(detailLevel(NAME_ZOOM)).toBe('mid');
        expect(detailLevel(DETAIL_ZOOM - 0.01)).toBe('mid');
        expect(detailLevel(DETAIL_ZOOM)).toBe('near');
        expect(detailLevel(3)).toBe('near');
        expect(detailLevel(undefined)).toBe('near');
        expect(detailLevel(Number.NaN)).toBe('near');
    });

    it('is marked on the diagram on screen only, one class at a time, beside the classes it has', () => {
        const vnode: any = { sel: 'svg', data: { class: { 'sprotty-graph': true } } };
        markDetail(vnode, 0.3, 'main');
        expect(vnode.data.class).toEqual({ 'sprotty-graph': true, 'detail-far': true, 'detail-mid': false, 'detail-near': false });
        markDetail(vnode, 0.6, 'main');
        expect(vnode.data.class).toEqual({ 'sprotty-graph': true, 'detail-far': false, 'detail-mid': true, 'detail-near': false });
        // The hidden render measures what it draws: it is never marked.
        const hidden: any = { sel: 'svg', data: { class: { 'sprotty-graph': true } } };
        markDetail(hidden, 0.3, 'hidden');
        expect(hidden.data.class).toEqual({ 'sprotty-graph': true });
        expect(markDetail(undefined, 0.3, 'main')).toBeUndefined();
    });

    it('is lifted while an export copies the diagram, and put back after, even when the copy fails', () => {
        const classes = new Set(['sprotty-graph', 'detail-far']);
        const element: any = {
            classList: {
                contains: (name: string) => classes.has(name),
                add: (name: string) => { classes.add(name); },
                remove: (name: string) => { classes.delete(name); }
            }
        };
        expect(withFullDetail(element, () => [...classes])).toEqual(['sprotty-graph']);
        expect([...classes]).toEqual(['sprotty-graph', 'detail-far']);
        expect(() => withFullDetail(element, () => { throw new Error('copy failed'); })).toThrow('copy failed');
        expect(classes.has('detail-far')).toBe(true);
        expect(withFullDetail(undefined, () => 1)).toBe(1);
    });
});

describe('the text each level hides', () => {
    const css = source('diagram-client.css');
    const block = css.slice(css.indexOf('/* Level of detail (zoom-detail.ts)'));
    // The classes a level hides outright: a compound selector (`.header-label.label-type`,
    // `:not(...)`) hides only some of them, and is not counted.
    const rules = (level: keyof typeof DETAIL_CLASSES) =>
        [...block.matchAll(new RegExp(`\\.${DETAIL_CLASSES[level]} ([a-z]*)\\.([a-z-]+)([.:][^\\s,{]*)?`, 'g'))]
            .map(m => ({ element: m[1], name: m[2], compound: !!m[3] }));
    const hiddenAt = (level: keyof typeof DETAIL_CLASSES): Set<string> =>
        new Set(rules(level).filter(rule => !rule.compound).map(rule => rule.name));
    const far = hiddenAt('far');
    const mid = hiddenAt('mid');

    // The text the diagram draws, by the classes on each `text` element.
    const drawn = ['views.ts', 'symbol-views.ts'].flatMap(file =>
        [...source(file).matchAll(/svg\('text', \{\s*class: \{([^}]*)\}/g)].map(m =>
            [...m[1].matchAll(/'([a-z-]+)': /g)].map(c => c[1])));

    // A group's frame keeps its title far out: the structure of the view.
    const ALWAYS = new Set(['group-label']);
    // Text hidden with the group it is drawn in.
    const INSIDE: Record<string, string> = {
        'header-badge-text': 'header-badge',
        'edge-open-label': 'edge-open-button',
        'edge-queue-label': 'edge-queue-badge'
    };

    it('far out: every text a node draws, and nothing a frame needs', () => {
        expect(drawn.length).toBeGreaterThan(10);
        for (const classes of drawn) {
            const covered = classes.some(name => far.has(name) || ALWAYS.has(name) || far.has(INSIDE[name] ?? ''));
            expect(covered, `text with classes ${classes.join(', ')} is neither hidden far out nor kept on purpose`).toBe(true);
        }
        expect(far.has('group-label')).toBe(false);
    });

    it('in between: the ports’ names and the rest, but not a node’s name', () => {
        for (const detail of ['port-label', 'header-badge', 'multiplicity-badge', 'edge-carried-label', 'cal-edge-index-label', 'zoom-detail']) {
            expect(mid.has(detail), detail).toBe(true);
        }
        for (const name of ['header-label', 'sprotty-label', 'boundary-name', 'symbol-operator', 'symbol-caption', 'edge-queue-badge', 'zoom-name']) {
            expect(mid.has(name), name).toBe(false);
        }
        // A symbol's caption is its name: the type-footer rule spares it; a
        // structure's condition line is detail, its name is not.
        expect(block).toMatch(/\.detail-mid text\.type-footer-label:not\(\.symbol-caption\)/);
        expect(block).toMatch(/\.detail-mid text\.header-label\.label-type/);
    });

    it('names the element each rule hides, so no node is hidden for a class of the same name', () => {
        // A node's own group carries `symbol-<kind>` (an operator symbol is
        // `symbol-operator`, the class of its operator's text) and a label's
        // group its model's classes (`port-label`): an unqualified rule hid
        // whole nodes far out.
        expect(source('views.ts')).toMatch(/\[`symbol-\$\{symbol\}`\]: true/);
        for (const level of ['far', 'mid'] as const) {
            for (const rule of rules(level)) {
                const product = Object.values(ZOOM_TEXT_CLASSES).includes(rule.name as never);
                expect(product || rule.element === 'text' || rule.element === 'g', `.${DETAIL_CLASSES[level]} ${rule.element}.${rule.name}`).toBe(true);
            }
        }
        const groups = [...rules('far'), ...rules('mid')].filter(rule => rule.element === 'g').map(rule => rule.name);
        expect(new Set(groups)).toEqual(new Set(['edge-open-button', 'edge-queue-badge', 'header-badge']));
    });

    it('takes the classes a product tags its own text with', () => {
        expect(far.has(ZOOM_TEXT_CLASSES.name)).toBe(true);
        expect(far.has(ZOOM_TEXT_CLASSES.detail)).toBe(true);
        expect(mid.has(ZOOM_TEXT_CLASSES.detail)).toBe(true);
        expect(mid.has(ZOOM_TEXT_CLASSES.name)).toBe(false);
    });

    it('is decided by the root view the stock diagram draws its graph with', () => {
        expect(source('stock-views.module.ts')).toMatch(/configureModelElement\(context, WorkflowDiagramTypes\.GRAPH, GGraph, DetailGraphView\)/);
        expect(source('svg-export.ts')).toMatch(/withFullDetail\(el\.ownerSVGElement/);
    });
});
