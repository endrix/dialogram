/**
 * A list: a group whose scope says `list`, its members drawn as the rows of a
 * table, one under another, instead of as cards side by side.
 *
 * What a list is for is many small things that each are one line of text
 * (the state variables of an actor, its helper functions): as cards, each a
 * header, a body and a caption, a few dozen of them took more room than the
 * drawing they belong to. As rows they take a line each, and still each is
 * an element of its own: selected, opened at its source, the end of a link,
 * as a card was.
 *
 * A row is its name, then its lines (`meta.lines`: a variable's type and its
 * value, a function's parameters and its kind), each in a column the list's
 * rows share, in one fixed-width font, so that the list reads as a table.
 * The producer orders the lines; the columns are worked out here, once a
 * list, from all its members.
 */
import { WorkflowDiagramConstants, type ListRow, type NodeLine } from '@dialogram/shared';

/** What of a node a row is made of. */
export interface ListMember {
    label: string;
    lines: readonly NodeLine[];
}

/** Where a list's columns start (the name's first), and the rows' width. */
export interface ListColumns {
    nameX: number;
    /** Per line, by its place in a member's lines: where its column starts. */
    cellX: number[];
    width: number;
}

/**
 * The columns of a list's rows: the name after the family's mark and the
 * padding, then a column per place in the members' lines, each as wide as
 * its widest entry (`columns` counts a text's columns in the fixed-width
 * font, `columnWidth` is one column's width), a gap between.
 */
export function listColumns(members: readonly ListMember[], columns: (text: string) => number, columnWidth: number): ListColumns {
    const k = WorkflowDiagramConstants;
    const widest = (texts: Array<string | undefined>): number => Math.max(0, ...texts.map(text => (text ? columns(text) : 0))) * columnWidth;
    const nameX = k.LIST_ROW_MARK_PX + k.LIST_ROW_PADDING_PX;
    let right = nameX + widest(members.map(member => member.label));
    const cellX: number[] = [];
    const places = Math.max(0, ...members.map(member => member.lines.length));
    for (let place = 0; place < places; place++) {
        const width = widest(members.map(member => member.lines[place]?.text));
        const x = right + k.LIST_ROW_COLUMN_GAP_PX;
        cellX.push(x);
        right = x + width;
    }
    return { nameX, cellX, width: Math.ceil(right + k.LIST_ROW_PADDING_PX) };
}

/** What a member's row shows, in its list's columns. */
export function listRowOf(member: ListMember, columns: ListColumns): ListRow {
    return {
        nameX: columns.nameX,
        cells: member.lines.flatMap((line, place) => line.text
            ? [{ text: line.text, x: columns.cellX[place], ...(line.kind ? { kind: line.kind } : {}) }]
            : [])
    };
}
