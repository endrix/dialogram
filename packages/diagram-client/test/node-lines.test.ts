/**
 * The drawing of the lines a producer puts in a node: a band per line across
 * the bottom of the body, always drawn and carrying the line's kind for a
 * product to colour, and the line's text, which is detail and so drawn only
 * close in.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { nodeLinesHeight, nodeLinesOf, renderNodeLines } from '../src/node-lines';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const CSS = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');

// The GLSP `svg` helper gives `{tag, props, children}` here, snabbdom vnodes in a browser.
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const attrsOf = (vnode: any): Record<string, any> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? {};
const textOf = (vnode: any): string => (vnode?.children ?? []).map((c: any) => typeof c === 'string' ? c : c?.text ?? '').join('') || vnode?.text || '';

const LINE = WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX;

describe('the lines of a node', () => {
    it('are read from its argument, and nothing else is taken for one', () => {
        const lines = [{ text: 'x > 3', kind: 'guard' }, { text: 'In 1' }];
        expect(nodeLinesOf({ args: { [WorkflowDiagramMetadata.NODE_LINES]: lines } })).toEqual(lines);
        expect(nodeLinesOf({ args: { [WorkflowDiagramMetadata.NODE_LINES]: [null, 'x', { kind: 'guard' }, { text: 'kept' }] } })).toEqual([{ text: 'kept' }]);
        expect(nodeLinesOf({ args: { [WorkflowDiagramMetadata.NODE_LINES]: 'x > 3' } })).toEqual([]);
        expect(nodeLinesOf({})).toEqual([]);
    });

    it('are a band and a text each, stacked at the bottom of the body', () => {
        const drawn = renderNodeLines([{ text: 'x > 3', kind: 'guard' }, { text: 'In 1 → Out 2' }], 200, 92);

        expect(drawn).toHaveLength(4);
        const [band1, text1, band2, text2] = drawn;
        expect(classesOf(band1)).toMatchObject({ 'node-line': true, 'node-line-guard': true });
        expect(classesOf(band2)).toEqual({ 'node-line': true });
        // Two lines take the last 32 px of a 92 px body.
        expect(attrsOf(band1).d.startsWith(`M1,${92 - 2 * LINE} H199`)).toBe(true);
        expect(attrsOf(band2).d.startsWith(`M1,${92 - LINE} H199`)).toBe(true);
        expect(attrsOf(text1).y).toBe(92 - 2 * LINE + LINE / 2);
        expect(attrsOf(text2).y).toBe(92 - LINE + LINE / 2);
        expect(textOf(text1)).toBe('x > 3');
        expect(textOf(text2)).toBe('In 1 → Out 2');
        expect(nodeLinesHeight([{ text: 'a' }, { text: 'b' }])).toBe(2 * LINE);
    });

    it('round only the last band, to the body’s corners, inside its outline', () => {
        const [first, , last] = renderNodeLines([{ text: 'a' }, { text: 'b' }], 140, 92);

        expect(attrsOf(first).d).not.toContain('A');
        expect(attrsOf(last).d.match(/A/g)).toHaveLength(2);
        // The last band stops a pixel short of the body's bottom edge.
        expect(attrsOf(last).d).toContain(`,${92 - 1}`);
        expect(attrsOf(last).d).not.toContain(`,${92} `);
    });

    it('round a single line, which is the first band and the last', () => {
        const [band, text, ...rest] = renderNodeLines([{ text: 'only' }], 140, 76);

        expect(rest).toEqual([]);
        expect(attrsOf(band).d.startsWith(`M1,${76 - LINE} H139`)).toBe(true);
        expect(attrsOf(band).d.match(/A/g)).toHaveLength(2);
        expect(attrsOf(text).y).toBe(76 - LINE / 2);
    });

    it('give a line of no kind no class of a kind', () => {
        const [band, text] = renderNodeLines([{ text: 'plain' }], 140, 76);

        expect(Object.keys(classesOf(band))).toEqual(['node-line']);
        expect(Object.keys(classesOf(text)).sort()).toEqual(['node-line-text', 'zoom-detail']);
    });

    it('draw the band always and the text only close in', () => {
        const [band, text] = renderNodeLines([{ text: 'x > 3', kind: 'guard' }], 140, 76);

        expect(classesOf(band)['zoom-detail']).toBeUndefined();
        expect(classesOf(text)).toMatchObject({ 'node-line-text': true, 'zoom-detail': true, 'node-line-guard': true });
        expect(CSS).toMatch(/\.detail-mid \.zoom-detail\s*\{[^}]*display: none/);
    });

    it('draw nothing for a node without lines', () => {
        expect(renderNodeLines([], 140, 60)).toEqual([]);
    });

    it('are drawn by the node view, the family’s mark centred in the body above them', () => {
        expect(VIEWS).toContain('const openHeight = bodyHeight - nodeLinesHeight(lines);');
        expect(VIEWS).toContain('renderNodeCenterIcon(family, width, openHeight)');
        expect(VIEWS).toContain('...renderNodeLines(lines, width, bodyHeight)');
    });

    it('have a quiet look of their own, for a product to colour by kind', () => {
        expect(CSS).toMatch(/\.sprotty path\.node-line\s*\{[^}]*fill/);
        expect(CSS).toMatch(/\.sprotty text\.node-line-text\s*\{[^}]*font-size: 10px/);
        // Set by rule: the diagram's own rule centres every text, and outranks the attribute.
        expect(CSS).toMatch(/\.sprotty text\.node-line-text\s*\{[^}]*text-anchor: start/);
    });
});
