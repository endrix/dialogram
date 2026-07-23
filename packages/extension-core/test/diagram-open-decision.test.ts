import { describe, expect, it } from 'vitest';
import { decideDiagramOpen } from '../src/extension/diagram/diagram-open-decision';

describe('decideDiagramOpen', () => {
    it('opens when the profile supplies no verdict (undefined ⇒ always-openable behavior)', () => {
        expect(decideDiagramOpen(undefined, false)).toBe('open');
        expect(decideDiagramOpen(undefined, true)).toBe('open');
    });

    it('opens when the probe is affirmative', () => {
        expect(decideDiagramOpen(true, false)).toBe('open');
        expect(decideDiagramOpen(true, true)).toBe('open');
    });

    it('falls back to a text editor on a negative verdict without a graph handoff', () => {
        expect(decideDiagramOpen(false, false)).toBe('text-fallback');
    });

    it('routes to the graph handoff on a negative verdict when one is available', () => {
        expect(decideDiagramOpen(false, true)).toBe('graph-fallback');
    });
});
