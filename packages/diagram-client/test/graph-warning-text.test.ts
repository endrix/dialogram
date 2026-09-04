/**
 * What the warning chip claims, and what it must not.
 *
 * A graph that is incomplete and a graph that faithfully draws something faulty
 * are opposite situations, and the chip used to describe both as "Partial
 * graph". The wrong one sends a reader hunting for missing nodes rather than
 * reading the problem being reported — and that is the likelier case, since a
 * producer able to describe a fault precisely usually had no trouble drawing
 * it.
 */

import { describe, expect, it } from 'vitest';
import { graphWarningText } from '../src/navigation-ui';

describe('the graph warning chip', () => {
    it('says "partial" when the graph really is', () => {
        expect(graphWarningText(['half the nodes are missing'], true)).toBe(
            'Partial graph: half the nodes are missing'
        );
    });

    it('does not, when the graph is whole and the subject has a fault', () => {
        // The message already says what is wrong and the chip already looks
        // like a warning, so a prefix claiming the picture is incomplete only
        // adds something untrue.
        expect(graphWarningText(['detected a cycle'], false)).toBe('detected a cycle');
    });

    it('counts the rest either way', () => {
        expect(graphWarningText(['one', 'two', 'three'], false)).toBe('one (+2 more)');
        expect(graphWarningText(['one', 'two'], true)).toBe('Partial graph: one (+1 more)');
    });

    it('still says something when there is no message to show', () => {
        // Reached when the producer reports an error it cannot describe. A
        // blank chip would be worse than a vague one.
        expect(graphWarningText([], false)).toBe(
            'Graph export completed with recoverable errors.'
        );
    });
});
