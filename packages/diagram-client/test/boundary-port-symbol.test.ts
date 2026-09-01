/**
 * A boundary port is ONE object, drawn by the node's own view.
 *
 * These assert the properties that kept failing while it was assembled from
 * separate pieces: that the whole row is the object, that the text anchors the
 * way it is told to, and that the type looks like a node's type.
 *
 * On the type in particular: it must look like a node's, and must not be tinted.
 *
 * This shipped wrong once. The type label carried both `boundary-label` and
 * `boundary-type-label`, so `.boundary-input .boundary-label` — the rule that
 * tints a NAME green — matched it too, at identical specificity. Document order
 * decided, the direction rules came later, and the type rendered in the name's
 * colour on both sides. Note that a colour assertion would not have caught it:
 * the grey declaration was present and correct the whole time, and what was
 * wrong was whether it applied.
 *
 * Both halves are now structural rather than a specificity fight. The type is
 * drawn by the node's own view carrying the NODES' footer class, so it inherits
 * one definition of what a type looks like instead of maintaining a second, and
 * no selector that tints a name can reach it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowEdgeView } from '../src/views';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.resolve(here, file), 'utf8');

/** Comments stripped: they discuss the very selectors they explain, and an
 *  earlier version of this test matched a selector inside its own comment. */
const CSS = read('../src/diagram-client.css').replace(/\/\*[\s\S]*?\*\//g, '');
const VIEWS = read('../src/views.ts');

describe('boundary port symbol', () => {
    it('reuses the nodes’ own footer class rather than a second convention', () => {
        // The class the entity node views put on their type footer.
        expect(VIEWS).toMatch(/'type-footer-label':\s*true,\s*'boundary-type':\s*true/);
    });

    it('has that class actually define the shared look', () => {
        const footer = /([^}]*)\.type-footer-label\s*\{([^}]*)\}/.exec(CSS);

        expect(footer, '.type-footer-label no longer exists').not.toBeNull();
        expect(footer![2]).toContain('descriptionForeground');
        expect(footer![2]).toContain('italic');
    });

    /**
     * ...and it has to OUTRANK the framework rule, which is the part that was
     * wrong. `.sprotty text` sets a fill and is a class plus an element, so a
     * lone `.type-footer-label` loses to it and every type rendered in the body
     * colour. The node views hid that by setting fill inline at three call
     * sites; the boundary type had no such patch and came out black.
     *
     * Specificity is compared rather than the selector's exact text, so this
     * still holds if either rule is rewritten.
     */
    it('outranks the framework rule that would otherwise colour it', () => {
        // Rules parsed as selector/body pairs — a looser regex silently matched
        // `.sprotty text` as a PREFIX of `.sprotty text.type-footer-label` and
        // compared the rule against itself.
        const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .map(m => ({ selector: m[1].trim(), body: m[2] }));

        const rank = (selector: string): number => {
            const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
            const elements = (selector.replace(/\.[\w-]+/g, '').match(/[a-z]+/g) ?? []).length;
            return classes * 10 + elements;
        };

        const ours = rules.find(r => r.selector.includes('.type-footer-label') && r.body.includes('descriptionForeground'));
        const framework = rules.find(r => r.selector === '.sprotty text' && r.body.includes('fill:'));

        expect(ours, 'the type colour rule has gone').toBeDefined();
        expect(framework, 'the framework fill rule has gone — this test is moot').toBeDefined();
        expect(rank(ours!.selector)).toBeGreaterThan(rank(framework!.selector));
    });

    /** One place decides what a type looks like — no view may re-set it inline. */
    it('is not patched inline by any view', () => {
        const footers = [...VIEWS.matchAll(/'type-footer-label':\s*true[\s\S]{0,240}?attrs:/g)];

        expect(footers.length, 'no type footer is rendered any more').toBeGreaterThan(0);
        for (const footer of footers) {
            // Quoted OR bare: the views write `'fill':`, so a bare /fill:/ never
            // matched and this passed while an inline fill was sitting there.
            expect(footer[0], 'a view is setting the type fill inline again')
                .not.toMatch(/['"]?fill['"]?\s*:/);
        }
    });

    /**
     * The bug, stated as a rule: whatever tints by direction may reach the name
     * and the glyph, and nothing else. The type is not in that set.
     */
    it('is out of reach of every direction tint', () => {
        const tinted = [...CSS.matchAll(/\.boundary-(?:input|output)\s+\.([\w-]+)/g)].map(m => m[1]);

        expect(tinted.length, 'the direction rules moved or vanished').toBeGreaterThan(0);
        expect([...new Set(tinted)].sort()).toEqual(['boundary-glyph', 'boundary-name']);
    });

    /** And the name still IS tinted — otherwise the rule above passes trivially. */
    it('leaves the name tinted by direction', () => {
        expect(CSS).toMatch(/\.boundary-input\s+\.boundary-name\s*\{[^}]*charts-green/s);
        expect(CSS).toMatch(/\.boundary-output\s+\.boundary-name\s*\{[^}]*charts-blue/s);
    });

    /**
     * Anchoring has to be an inline STYLE, not only an attribute.
     *
     * A presentation attribute loses to any stylesheet rule, and upstream
     * GLSP/Sprotty styles set `text-anchor: middle`. So the name rendered
     * centred on its own glyph no matter what the attribute said — the text and
     * the arrow appeared on top of each other, twice, before this was found.
     * The port labels in the same file already carried the fix and a comment
     * explaining it.
     *
     * Asserting the style specifically is the point: an assertion that merely
     * found `text-anchor` somewhere would have passed throughout the bug.
     */
    it('forces the text anchor as a style, which CSS cannot override', () => {
        const symbol = /function boundaryPort[\s\S]*?\n\}/.exec(VIEWS);
        expect(symbol, 'boundaryPort has been renamed').not.toBeNull();

        // One per text element it draws: the name and the type.
        const styled = [...symbol![0].matchAll(/style:\s*\{\s*'text-anchor':/g)];
        expect(styled.length).toBe(2);
    });

    /**
     * The grab target is the node's whole row, which is what makes the name part
     * of the port instead of something sitting beside it.
     *
     * It began as a small box centred on the glyph — reasonable, since a 10px
     * arrow is hard to hit, but it meant a port could not be clicked or dragged
     * by its own name, and selecting one outlined the arrow while leaving the
     * name outside the outline. Asserting the WIDTH comes from the node is the
     * point: any fixed number would be a box around the arrow again.
     */
    it('makes the whole row the grab target, not a box around the arrow', () => {
        const symbol = /function boundaryPort[\s\S]*?\n\}/.exec(VIEWS);
        const hit = /'boundary-hit':\s*true[\s\S]*?attrs:\s*\{([^}]*)\}/.exec(symbol![0]);

        expect(hit, 'the hit rectangle has gone').not.toBeNull();
        // Derived from the text's reach, not from a constant and not from the
        // node box — the box is a fixed width so the glyph columns line up,
        // which says nothing about how wide any one port reads.
        expect(hit![1]).toMatch(/x:\s*hit\.x/);
        expect(hit![1]).toMatch(/width:\s*hit\.width/);
        expect(symbol![0]).toMatch(/approximateTextWidth/);
    });

    /**
     * A boundary port IS an arrow, so an edge ending at one must not draw
     * another. They do not merely duplicate: the edge's tip is nudged past its
     * endpoint to meet the stroke cap, and that endpoint is the glyph's own
     * edge, so the arrowhead came to rest inside the glyph.
     *
     * Called for real rather than grepped. The first version of this test
     * searched the source for the guard, and passed happily when the guard was
     * disabled with `false &&` — it was checking that the words were present,
     * not that they did anything.
     */
    describe('an edge ending at a boundary port', () => {
        const view = new WorkflowEdgeView();
        const segments = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
        const arrowFor = (target: unknown): { tag: string } =>
            (view as unknown as {
                renderArrow(s: typeof segments, e: unknown): { tag: string };
            }).renderArrow(segments, { target } as never);

        it('arrives as a plain line', () => {
            const arrow = arrowFor({ type: WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT });

            expect(arrow.tag).toBe('g');
        });

        it('arrives as a plain line when it ends on the port inside the node', () => {
            // Edges attach to the GPort, not the node, so the check has to walk up.
            const arrow = arrowFor({
                type: 'port:output',
                parent: { type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT }
            });

            expect(arrow.tag).toBe('g');
        });

        /** The control: an ordinary edge must still get its arrowhead. */
        it('still draws one into an ordinary node', () => {
            const arrow = arrowFor({ type: 'node:task', parent: undefined });

            expect(arrow.tag).toBe('polygon');
        });
    });

    /**
     * Clicking and highlighting are different extents, and the diagram already
     * makes that distinction: a node's type caption is clickable — it is inside
     * the node's group — but a node's hover tints only its body, leaving the
     * caption outside. The port had one rectangle doing both jobs, so hovering
     * it lit up the type as well.
     */
    it('highlights less than it lets you click', () => {
        const symbol = /function boundaryPort[\s\S]*?\n\}/.exec(VIEWS)![0];
        const heightOf = (cls: string): string =>
            new RegExp(`'${cls}':\\s*true[\\s\\S]*?height:\\s*([\\w.]+(?:\\.[\\w]+)*)`).exec(symbol)![1];

        // The grab target is the whole row; the highlight is the name's line.
        expect(heightOf('boundary-hit')).toContain('HIT_HEIGHT_PX');
        expect(heightOf('boundary-highlight')).not.toContain('HIT_HEIGHT_PX');
        expect(symbol).toMatch(/height:\s*G\.NAME_LINE_HEIGHT_PX/);
    });

    /**
     * The name and type are drawn by the node view now, so the label elements
     * must draw nothing — rendering both would double every string on screen.
     */
    it('renders nothing from the boundary label elements', () => {
        expect(VIEWS).toMatch(
            /LABEL_BOUNDARY_NAME\s*\|\|[^)]*LABEL_BOUNDARY_TYPE\)\s*\{\s*return undefined;/
        );
    });
});
