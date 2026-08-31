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
        const footer = /\.type-footer-label\s*\{([^}]*)\}/.exec(CSS);

        expect(footer, '.type-footer-label no longer exists').not.toBeNull();
        expect(footer![1]).toContain('descriptionForeground');
        expect(footer![1]).toContain('italic');
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
        expect(hit![1]).toMatch(/x:\s*0/);
        expect(hit![1]).toMatch(/width:\s*nodeWidth/);
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
