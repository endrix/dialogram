import { describe, expect, it } from 'vitest';
import { headerHeight, headerLines, headerTextWidth, WorkflowDiagramConstants } from '@dialogram/shared';

const widest = (lines: string[]): number => Math.max(...lines.map(headerTextWidth));

describe('a node name in its header', () => {
    it('is one line while it is short', () => {
        expect(headerLines('A trap is a halt')).toEqual(['A trap is a halt']);
    });

    it('breaks between words past the cap, into balanced lines', () => {
        expect(headerLines('Three conditions, each with two outcomes')).toEqual(['Three conditions, each', 'with two outcomes']);
        expect(headerLines('The eight CPU states and their transitions')).toEqual(['The eight CPU states', 'and their transitions']);
    });

    it('takes at most three lines, widening them rather than cutting', () => {
        const title = 'Q-003: an undecoded instruction hangs when `CATCH_ILLINSN` is off and a co-processor is present';
        const lines = headerLines(title);
        expect(lines).toHaveLength(WorkflowDiagramConstants.HEADER_MAX_LINES);
        expect(lines.join(' ')).toBe(title);
        expect(widest(lines)).toBeGreaterThan(WorkflowDiagramConstants.HEADER_WRAP_WIDTH_PX);
        expect(widest(lines)).toBeLessThan(headerTextWidth(title) / 2);
    });

    it('keeps a name with nowhere to break on one line', () => {
        const name = 'picorv32_axi_adapter_with_a_very_long_name';
        expect(headerLines(name)).toEqual([name]);
    });

    it('keeps a word longer than the cap whole on its own line', () => {
        const lines = headerLines('`ENABLE_REGS_DUALPORT_AND_MORE_THAN_THIRTY` removes it');
        expect(lines[0]).toBe('`ENABLE_REGS_DUALPORT_AND_MORE_THAN_THIRTY`');
        expect(lines.join(' ')).toBe('`ENABLE_REGS_DUALPORT_AND_MORE_THAN_THIRTY` removes it');
    });

    it('is as wide as its letters: a capital wider than a lowercase letter, a space narrower', () => {
        // Chrome, bold 12px with 0.5px spacing: 180.7px and 252.4px.
        expect(headerTextWidth('`BARREL_SHIFTER` removes')).toBeGreaterThanOrEqual(181);
        expect(headerTextWidth('the eight cpu states and their transitions')).toBeLessThan(42 * 7);
        expect(headerTextWidth('ABC')).toBeGreaterThan(headerTextWidth('abc'));
    });

    it('grows the header by a line height per line', () => {
        expect(headerHeight(1)).toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX);
        expect(headerHeight(3)).toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX + 2 * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX);
    });
});
