/**
 * The type line must not take the name's colour.
 *
 * This shipped wrong once, and the reason is worth pinning rather than the
 * pixel. The type label carries BOTH `boundary-label` and
 * `boundary-type-label`, so `.boundary-input .boundary-label` — the rule that
 * tints a name green — matches it too. Its own rule was written as
 * `.boundary-node .boundary-type-label`, which is the SAME specificity (two
 * classes), so the winner came down to document order, and the direction rules
 * came later. The type rendered green on inputs and blue on outputs, exactly
 * like the name beside it.
 *
 * A colour assertion would not have caught it — the declaration was always
 * there and always correct. What was wrong was whether it applied. So these
 * assert the two things that decide that: the selector outranks the direction
 * rules on specificity, and it is not relying on order to do it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/diagram-client.css'),
    'utf8'
);

/**
 * Comments stripped, because the comments here DISCUSS the selectors they
 * explain — an order check against the raw file matched the prose above the
 * rule and failed on it. Only what the browser sees is scanned.
 */
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

/** The selector list of the rule that sets the type colour. */
function typeColourRule(): { selector: string; index: number } {
    const match = /([^}]*?)\{[^}]*?fill:\s*#a8a8a2[^}]*?\}/s.exec(CSS);
    expect(match, 'no rule sets the type label colour').not.toBeNull();
    return { selector: match![1].trim(), index: match!.index };
}

describe('boundary type label colour', () => {
    it('is set at all', () => {
        expect(typeColourRule().selector).toContain('boundary-type-label');
    });

    /**
     * Two classes on the same element is a tie, and a tie is decided by order —
     * which is how this broke. Qualifying with both classes makes it three, so
     * it wins outright.
     */
    it('outranks the direction rules on specificity, not on order', () => {
        const { selector } = typeColourRule();

        expect(
            selector,
            'must qualify both classes so it beats `.boundary-input .boundary-label`'
        ).toMatch(/\.boundary-label\.boundary-type-label|\.boundary-type-label\.boundary-label/);
    });

    /**
     * Belt and braces: even with the specificity fixed, sitting after the rules
     * it competes with means a future reorder cannot quietly recreate the tie.
     */
    it('also sits after the rules that tint the name', () => {
        const { index } = typeColourRule();
        const directionRules = [...CSS.matchAll(/\.boundary-(input|output) \.boundary-label/g)];

        expect(directionRules.length, 'the direction rules moved or vanished').toBeGreaterThan(0);
        for (const rule of directionRules) {
            expect(rule.index).toBeLessThan(index);
        }
    });

    it('leaves the name tinted by direction', () => {
        expect(CSS).toMatch(/\.boundary-input \.boundary-glyph,\s*\.boundary-input \.boundary-label/);
        expect(CSS).toMatch(/\.boundary-output \.boundary-glyph,\s*\.boundary-output \.boundary-label/);
    });
});
