/**
 * What a node says, in a paragraph in its body.
 *
 * A producer gives a node a sentence (`meta.summary`): a clause's rule ("A
 * one-bit register `halted` MUST hold the halt."), a step's purpose. The name
 * in the header says what the node is called; the paragraph says what it is
 * for, which a reader otherwise opened the source to learn.
 *
 * The paragraph is drawn under the node's ports, above its lines, where the
 * family's mark would be (it takes the mark's place): in the UI font, a code
 * span (`` `halted` ``) in the editor's, without its backticks. It asks the
 * node for `SUMMARY_WIDTH_PX` unless it is shorter, breaks between words at
 * the node's width, and stops after `SUMMARY_MAX_LINES` lines, the last
 * ending in an ellipsis: the rest is for the source. A word wider than the
 * node widens it, so nothing is cut inside a word.
 *
 * The server sizes the node by the lines and hands them to the client
 * (`wf:nodeSummary`), which draws them: the paragraph drawn is the paragraph
 * sized. A line keeps its code spans in backticks (`summaryRuns` splits it).
 */
import { WorkflowDiagramConstants } from './diagram-constants';
import { charColumns, estimateTextSize, textColumns } from './port-label-geometry';

/**
 * How wide each printable ASCII character of a paragraph is drawn, in
 * hundredths of an em of the regular UI font, from the space (32) to the
 * tilde (126): measured in Chrome as header-lines.ts's bold table, each the
 * widest of Arial/Liberation, Noto Sans, Ubuntu and Cantarell. The bold
 * table sized a line a tenth wider than drawn and left a word alone on the
 * next line.
 */
const ASCII_HUNDREDTHS: readonly number[] = [
    28, 28, 42, 65, 58, 99, 73, 24, 33, 33, 55, 58, 28, 42, 28, 37, 61, 57, 57,
    57, 60, 57, 58, 57, 58, 58, 28, 28, 58, 58, 58, 56, 101, 67, 67, 72, 73, 67,
    61, 78, 74, 34, 50, 67, 56, 91, 76, 78, 67, 78, 72, 67, 61, 73, 67, 98, 67,
    67, 64, 35, 37, 35, 58, 56, 50, 56, 60, 50, 60, 56, 38, 62, 62, 26, 26, 53,
    28, 94, 62, 57, 60, 60, 41, 50, 39, 62, 51, 79, 53, 51, 50, 38, 55, 38, 58
];

/** Characters outside ASCII a sentence has, in ems: the dashes, the ellipsis. */
const WIDE_PUNCTUATION: Readonly<Record<string, number>> = { '—': 1, '–': 0.56, '…': 1 };

/** As header-lines.ts: the macOS and Windows UI fonts could not be measured here. */
const UNMEASURED_FONT_MARGIN = 1.04;

/** How wide `text` is drawn in the regular UI font at `fontSizePx`. */
export function uiTextWidth(text: string, fontSizePx: number): number {
    let ems = 0;
    for (const char of text) {
        const code = char.codePointAt(0)!;
        ems += code >= 32 && code < 127
            ? ASCII_HUNDREDTHS[code - 32] / 100
            : WIDE_PUNCTUATION[char] ?? (charColumns(char) === 2 ? 1.05 : 0.7);
    }
    return ems * fontSizePx * UNMEASURED_FONT_MARGIN;
}

/** A stretch of a line in one font: prose, or a code span. */
export interface SummaryRun {
    text: string;
    code: boolean;
}

/** A word: what is between two spaces, its stretches in their fonts. */
type Word = SummaryRun[];

const ELLIPSIS = '…';

function runWidth(run: SummaryRun): number {
    const size = WorkflowDiagramConstants.SUMMARY_FONT_SIZE_PX;
    return run.code
        ? textColumns(run.text) * estimateTextSize('x', size).width
        : uiTextWidth(run.text, size);
}

function wordWidth(word: Word): number {
    return word.reduce((sum, run) => sum + runWidth(run), 0);
}

/**
 * A line of a paragraph in its stretches: what is between a pair of
 * backticks is code, the rest prose. A backtick left without its pair is
 * drawn as it is.
 */
export function summaryRuns(line: string): SummaryRun[] {
    const parts = line.split('`');
    if (parts.length % 2 === 0) {
        // An odd number of backticks: the last one has no pair.
        const last = parts.pop()!;
        parts[parts.length - 1] = `${parts[parts.length - 1]}\`${last}`;
    }
    return parts
        .map((text, index) => ({ text, code: index % 2 === 1 }))
        .filter(run => run.text.length > 0);
}

/** The paragraph's words, each a code span or prose or both (`` `halted`, ``). */
function wordsOf(text: string): Word[] {
    const words: Word[] = [];
    let word: Word = [];
    for (const run of summaryRuns(text.replace(/\s+/g, ' ').trim())) {
        const pieces = run.text.split(' ');
        pieces.forEach((piece, index) => {
            if (index > 0 && word.length > 0) {
                words.push(word);
                word = [];
            }
            if (piece) {
                word.push({ text: piece, code: run.code });
            }
        });
    }
    if (word.length > 0) {
        words.push(word);
    }
    return words;
}

/** A line of words as text, each code stretch in its backticks. */
function lineText(words: readonly Word[]): string {
    return words.map(word => word.map(run => run.code ? `\`${run.text}\`` : run.text).join('')).join(' ');
}

const space = (): number => uiTextWidth(' ', WorkflowDiagramConstants.SUMMARY_FONT_SIZE_PX);

/**
 * The width a paragraph asks of its node: `SUMMARY_WIDTH_PX`, less when the
 * whole paragraph is shorter, more when one of its words is wider. With the
 * padding on both sides; 0 for no paragraph.
 */
export function summaryWidth(text: string | undefined): number {
    const words = text ? wordsOf(text) : [];
    if (words.length === 0) {
        return 0;
    }
    const widths = words.map(wordWidth);
    const whole = widths.reduce((sum, width) => sum + width, 0) + space() * (words.length - 1);
    const pad = 2 * WorkflowDiagramConstants.SUMMARY_PADDING_PX;
    return Math.ceil(Math.max(Math.min(whole, WorkflowDiagramConstants.SUMMARY_WIDTH_PX - pad), ...widths) + pad);
}

/**
 * `words` broken into lines at `width`, at most `maxLines` of them, and
 * whether words were left over.
 */
function wrap(words: readonly Word[], widths: readonly number[], width: number, maxLines: number): { lines: Word[][]; more: boolean } {
    const gap = space();
    const lines: Word[][] = [];
    let line: Word[] = [];
    let lineWidth = 0;
    for (let index = 0; index < words.length; index++) {
        if (line.length > 0 && lineWidth + gap + widths[index] > width) {
            lines.push(line);
            if (lines.length === maxLines) {
                return { lines, more: true };
            }
            line = [];
            lineWidth = 0;
        }
        lineWidth += (line.length > 0 ? gap : 0) + widths[index];
        line.push(words[index]);
    }
    lines.push(line);
    return { lines, more: false };
}

/**
 * `lines`, `words` broken at `width`, balanced: broken again at the
 * narrowest whole width that keeps their number. `lines` as they are when
 * no whole width under `width` keeps it.
 */
function balanced(words: readonly Word[], widths: readonly number[], width: number, lines: Word[][]): Word[][] {
    const fits = (at: number): boolean => !wrap(words, widths, at, lines.length).more;
    let low = Math.ceil(Math.max(...widths));
    let high = Math.floor(width);
    if (lines.length < 2 || low > high || !fits(high)) {
        return lines;
    }
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (fits(mid)) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return wrap(words, widths, high, lines.length).lines;
}

/** `word` as much of it from its start as fits in `room`, a character at a time. */
function clipped(word: Word, room: number): Word {
    const runs = word.map(run => ({ ...run }));
    while (wordWidth(runs) > room) {
        const last = runs[runs.length - 1];
        const chars = [...last.text];
        if (chars.length <= 1 && runs.length === 1) {
            break;
        }
        chars.pop();
        last.text = chars.join('');
        if (last.text === '') {
            runs.pop();
        }
    }
    return runs;
}

/**
 * The paragraph's lines in a node `nodeWidth` wide: broken between words,
 * at most `maxLines`, the last ending in an ellipsis when there is more. A
 * paragraph that fits is balanced, as a header's name: the narrowest width
 * that keeps its number of lines, so its last line is not one word.
 */
export function summaryLines(
    text: string,
    nodeWidth: number,
    maxLines: number = WorkflowDiagramConstants.SUMMARY_MAX_LINES
): string[] {
    const words = wordsOf(text);
    if (words.length === 0 || maxLines < 1) {
        return [];
    }
    const widths = words.map(wordWidth);
    const width = nodeWidth - 2 * WorkflowDiagramConstants.SUMMARY_PADDING_PX;
    const { lines, more } = wrap(words, widths, width, maxLines);
    if (!more) {
        return balanced(words, widths, width, lines).map(lineText);
    }
    // More than fits: the last line makes room for the ellipsis, down to
    // part of its first word.
    const gap = space();
    const last = [...lines[lines.length - 1]];
    const ellipsis = uiTextWidth(ELLIPSIS, WorkflowDiagramConstants.SUMMARY_FONT_SIZE_PX);
    const widthOf = (ws: Word[]): number => ws.reduce((sum, w, i) => sum + wordWidth(w) + (i > 0 ? gap : 0), 0);
    while (last.length > 1 && widthOf(last) + ellipsis > width) {
        last.pop();
    }
    last[0] = clipped(last[0], width - ellipsis);
    return [...lines.slice(0, -1).map(lineText), `${lineText(last)}${ELLIPSIS}`];
}

/** The height a paragraph of `lineCount` lines takes in the body, its padding with it; 0 for none. */
export function summaryHeight(lineCount: number): number {
    return lineCount === 0
        ? 0
        : lineCount * WorkflowDiagramConstants.SUMMARY_LINE_HEIGHT_PX + 2 * WorkflowDiagramConstants.SUMMARY_PADDING_PX;
}
