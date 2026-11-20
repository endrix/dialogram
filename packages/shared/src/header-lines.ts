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

/**
 * The fonts it was measured in are Linux's; a webview draws the header in
 * `--vscode-font-family`, SF Pro on macOS and Segoe UI on Windows, which
 * could not be measured here. A name is sized this much wider than the
 * table says, so a face a little wider still clears its badges.
 */
const UNMEASURED_FONT_MARGIN = 1.04;

function rawWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += charEms(char) * WorkflowDiagramConstants.HEADER_LABEL_FONT_SIZE_PX + LETTER_SPACING_PX;
    }
    return width * UNMEASURED_FONT_MARGIN;
}

/** How wide a line of a header's name is drawn, in pixels. */
export function headerTextWidth(text: string): number {
    return Math.ceil(rawWidth(text));
}

/**
 * The lines `words` take at `width`: each word on the line before it while
 * the line fits, a word wider than `width` on a line of its own. Each word
 * measured once (`widths`), a line as wide as its words and the spaces
 * between them, so a long name costs as many steps as it has words.
 */
function wrap(words: readonly string[], widths: readonly number[], space: number, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    let lineWidth = 0;
    words.forEach((word, index) => {
        const wordWidth = widths[index];
        if (!line) {
            line = word;
            lineWidth = wordWidth;
        } else if (lineWidth + space + wordWidth > width) {
            lines.push(line);
            line = word;
            lineWidth = wordWidth;
        } else {
            line = `${line} ${word}`;
            lineWidth += space + wordWidth;
        }
    });
    if (line) {
        lines.push(line);
    }
    return lines;
}

/** The narrowest whole width in [low, high] at which `fits` holds; `fits(high)` must. */
function narrowest(low: number, high: number, fits: (width: number) => boolean): number {
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (fits(mid)) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return high;
}

export function headerLines(
    text: string,
    maxWidth: number = WorkflowDiagramConstants.HEADER_WRAP_WIDTH_PX,
    maxLines: number = WorkflowDiagramConstants.HEADER_MAX_LINES
): string[] {
    const words = text.trim().split(/\s+/).filter(word => word.length > 0);
    if (words.length < 2 || maxLines < 2) {
        return [text];
    }
    const widths = words.map(rawWidth);
    const space = rawWidth(' ');
    const total = widths.reduce((sum, width) => sum + width, 0) + space * (words.length - 1);
    if (total <= maxWidth) {
        return [text];
    }
    const longest = Math.ceil(Math.max(...widths));
    const lineCount = (width: number) => wrap(words, widths, space, width).length;
    // At the cap, or wider when the name needs more than `maxLines` lines
    // there: the narrowest width that fits it in `maxLines`.
    let width = Math.max(Math.ceil(maxWidth), longest);
    if (lineCount(width) > maxLines) {
        width = narrowest(width, Math.ceil(total), w => lineCount(w) <= maxLines);
    }
    // Balanced: the narrowest width that keeps this many lines.
    const count = lineCount(width);
    return wrap(words, widths, space, narrowest(longest, width, w => lineCount(w) <= count));
}

/** A node header's height for a name of `lineCount` lines: one line's header, and a line more for each. */
export function headerHeight(lineCount: number): number {
    return WorkflowDiagramConstants.HEADER_HEIGHT_PX
        + Math.max(0, lineCount - 1) * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX;
}
