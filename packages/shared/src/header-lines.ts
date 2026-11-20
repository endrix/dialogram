/**
 * A node's name in its header, in lines.
 *
 * A name is one line, as wide as it is, until it is wider than
 * `HEADER_WRAP_WIDTH_PX`: then it breaks between words onto as many lines as
 * it needs, up to `HEADER_MAX_LINES`, and the header grows taller instead of
 * the node wider. A clause titled with a sentence ("Q-003: an undecoded
 * instruction hangs when ... is present") made a node three times as wide as
 * its neighbours, and the picture as wide as its longest title.
 *
 * A name that needs more lines than that at the cap widens the lines until it
 * fits, so nothing is cut. The lines are then balanced: the narrowest width
 * that keeps their number, so two lines read as two halves, not a long line
 * and a word. A name without spaces (an identifier, a module) has nowhere to
 * break and stays one line, as before.
 *
 * The server sizes the node by these lines and hands them to the client
 * (`wf:headerLines` on the name label), which draws them: one computation,
 * so the header drawn is the header sized.
 */
import { WorkflowDiagramConstants } from './diagram-constants';
import { charColumns } from './port-label-geometry';

/**
 * How wide each printable ASCII character of a header's name is drawn, in
 * hundredths of an em of its bold font, from the space (32) to the tilde
 * (126). Measured in Chrome, each the widest of the sans-serif fonts a
 * webview resolves to (Arial/Liberation, Noto Sans, Ubuntu, Cantarell), so a
 * name is sized a little wide rather than run under its badges: a capital
 * is half again as wide as a lowercase letter, and a fixed width per
 * character sized `ENABLE_REGS_DUALPORT` too narrow and a sentence too wide.
 */
const ASCII_HUNDREDTHS: readonly number[] = [
    28, 34, 48, 69, 59, 102, 75, 27, 34, 34, 55, 59, 29, 42, 29, 42, 63, 58, 58,
    58, 63, 58, 60, 58, 60, 60, 34, 34, 59, 59, 59, 62, 100, 73, 73, 73, 74, 67,
    62, 78, 77, 39, 56, 73, 62, 95, 82, 80, 67, 80, 73, 67, 62, 76, 68, 100, 67,
    67, 66, 37, 42, 37, 59, 56, 50, 61, 62, 56, 62, 56, 41, 64, 66, 31, 31, 62,
    31, 99, 66, 62, 62, 62, 46, 56, 44, 66, 57, 86, 58, 57, 50, 40, 56, 40, 59
];

/** The header's letter spacing (`.header-label`), added after every character. */
const LETTER_SPACING_PX = 0.5;

function charEms(char: string): number {
    const code = char.codePointAt(0)!;
    if (code >= 32 && code < 127) {
        return ASCII_HUNDREDTHS[code - 32] / 100;
    }
    return charColumns(char) === 2 ? 1.05 : 0.7;
}

/** How wide a line of a header's name is drawn, in pixels. */
export function headerTextWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += charEms(char) * WorkflowDiagramConstants.HEADER_LABEL_FONT_SIZE_PX + LETTER_SPACING_PX;
    }
    return Math.ceil(width);
}

function wrap(words: readonly string[], width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        if (line && headerTextWidth(`${line} ${word}`) > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

export function headerLines(
    text: string,
    maxWidth: number = WorkflowDiagramConstants.HEADER_WRAP_WIDTH_PX,
    maxLines: number = WorkflowDiagramConstants.HEADER_MAX_LINES
): string[] {
    const words = text.trim().split(/\s+/).filter(word => word.length > 0);
    if (words.length < 2 || headerTextWidth(text.trim()) <= maxWidth || maxLines < 2) {
        return [text];
    }
    let width = maxWidth;
    let lines = wrap(words, width);
    while (lines.length > maxLines) {
        width += 8;
        lines = wrap(words, width);
    }
    // The narrowest width that keeps this many lines: no line narrower than
    // the longest word, none wider than the width found.
    let low = Math.max(...words.map(headerTextWidth));
    let high = width;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (wrap(words, mid).length <= lines.length) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return wrap(words, low);
}

/** A node header's height for a name of `lineCount` lines: one line's header, and a line more for each. */
export function headerHeight(lineCount: number): number {
    return WorkflowDiagramConstants.HEADER_HEIGHT_PX
        + Math.max(0, lineCount - 1) * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX;
}
