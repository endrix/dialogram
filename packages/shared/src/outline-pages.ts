/**
 * An outline that loads on demand.
 *
 * The outline (`HierarchyOutlineEntry`) is plain data on every model, which
 * is right for a hierarchy of views and wrong for a list of a hundred
 * thousand things: it would ride on every model, and the panel would draw
 * every row. So a group row may be lazy (`HierarchyOutlineEntry.lazy`): it
 * says how many rows it has (`count`), and the rows themselves are the
 * host's, asked for a page at a time as the group is opened and scrolled
 * (`DiagramProfile.outline.page`). A filter typed in the panel is answered
 * there too, for those rows: the producer has them, the webview does not.
 *
 * A row may stand for something that is no node of the graph (an
 * {@link OutlinePageRow} without `nodeId`, an `item` row): a click on it is
 * the product's, handed its id (`DiagramProfile.outline.activate`). And the
 * product can point the outline at a row (`DiagramProfileHandle.revealOutlineRow`):
 * the panel opens the group, fetches the page the row is on, and scrolls it
 * into view.
 *
 * The messages between the panel and the host are posted on their own, as
 * the loading messages are, and carry no `receiver` field (the platform's
 * messenger takes a message that has one as its own).
 */

/** One row of a lazy group, as the host gives it. */
export interface OutlinePageRow {
    /**
     * The product's id for it, unique in its group: what a click and a reveal
     * name it by. A row given without one keeps its place, and a click on it
     * does nothing.
     */
    id: string;
    /** What the row says. */
    label: string;
    /** Said after the label, dimmed. */
    detail?: string;
    /**
     * The graph node it stands for, by the producer's id: a click finds it
     * in the view the group is in, a double click double-clicks it, as a
     * `node` row does. Absent, a click is the product's (`activate`).
     */
    nodeId?: string;
    /** A node family's name (its `id` or annotation): the row carries its colour. */
    family?: string;
    /** Short marks after the label. */
    badges?: Array<{ text: string; tone?: string }>;
}

/** What the host is asked for: rows of a lazy group, under the panel's filter. */
export interface OutlinePageRequest {
    /** The lazy group's id (`HierarchyOutlineEntry.lazy.id`). */
    group: string;
    /** The first row wanted, from 0, of the rows under `query`. */
    offset: number;
    /** How many rows, at most. */
    limit: number;
    /** The filter as typed, trimmed; `''` for none. The producer decides what matches. */
    query: string;
}

/** The host's answer. */
export interface OutlinePage {
    /** How many rows the group has under the query: the length of the list the panel scrolls. */
    total: number;
    /** The `offset` asked for. */
    offset: number;
    /**
     * The rows from there, at most `limit` of them. Fewer, short of `total`,
     * and the panel asks for the rest from the first one missing; none, and
     * the rest of what it asked is shown as not loaded.
     */
    rows: OutlinePageRow[];
}

/** A row the product is asked to act on: clicked in the panel, with no node of the graph to find. */
export interface OutlineRowActivation {
    /** The row's id: an {@link OutlinePageRow.id}, or an `item` row's `id` (its path joined by `/` when it has none). */
    id: string;
    /** The lazy group it is in; absent for a row of the outline itself. */
    group?: string;
    /** A double click: go to it rather than look at it, as the product sees fit. */
    open: boolean;
}

/** A row the product wants shown: selected, its group opened, scrolled into view. */
export interface OutlineRowReveal {
    /** The row's id, as for {@link OutlineRowActivation.id}. */
    id: string;
    /** The lazy group it is in; absent for a row of the outline itself. */
    group?: string;
    /**
     * Where it is in its group with no filter, from 0, when the product knows:
     * the panel asks for that page at once. Absent, or with a filter typed,
     * the panel asks the host where it is (`DiagramProfile.outline.locate`).
     */
    index?: number;
    /** Open the panel too, if it is closed. Default: a closed panel stays closed and shows the row when opened. */
    show?: boolean;
}

/** Rows asked for at once. */
export const OUTLINE_PAGE_SIZE = 100;
/** The most rows a page may hold, whatever is asked. */
export const OUTLINE_PAGE_MAX = 1000;

/** Webview to host: a page of a lazy group, or where a row is in one; answered by {@link OUTLINE_REPLY_MESSAGE}. */
export const OUTLINE_REQUEST_MESSAGE = 'dialogram.outline.request';
/** Host to webview: the answer to an {@link OUTLINE_REQUEST_MESSAGE}, by its `requestId`. */
export const OUTLINE_REPLY_MESSAGE = 'dialogram.outline.reply';
/** Webview to host: the reader clicked a row that is the product's ({@link OutlineRowActivation}). */
export const OUTLINE_ACTIVATE_MESSAGE = 'dialogram.outline.activate';
/** Host to webview: show this row ({@link OutlineRowReveal}). */
export const OUTLINE_REVEAL_MESSAGE = 'dialogram.outline.reveal';

export type OutlineRequestPayload =
    | ({ requestId: string; sourceUri: string; op: 'page' } & OutlinePageRequest)
    | { requestId: string; sourceUri: string; op: 'locate'; group: string; id: string; query: string };

export interface OutlineReplyPayload {
    requestId: string;
    /** For a page. */
    page?: OutlinePage;
    /** For a locate: where the row is under the query, or absent when it is not there. */
    index?: number;
    /** Why there is no answer. */
    error?: string;
    /** How long the host took, ms. */
    ms?: number;
}

const TEXT_MAX = 300;
const BADGES_MAX = 4;

function line(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/** A request as the host may pass it on: a whole offset, a limit within bounds, a trimmed query. */
export function normalizeOutlinePageRequest(raw: Partial<OutlinePageRequest>): OutlinePageRequest {
    const offset = Number.isFinite(raw.offset) ? Math.max(0, Math.floor(raw.offset as number)) : 0;
    const limit = Number.isFinite(raw.limit) ? Math.min(OUTLINE_PAGE_MAX, Math.max(1, Math.floor(raw.limit as number))) : OUTLINE_PAGE_SIZE;
    return { group: typeof raw.group === 'string' ? raw.group : '', offset, limit, query: typeof raw.query === 'string' ? raw.query.trim() : '' };
}

/**
 * A producer's answer made safe to show: a whole, non-negative total, the
 * offset asked for, and at most `limit` rows, each with a label (its id when
 * it gave none). A row without an id keeps its place, with an empty id, so
 * that the rows after it are still where the producer put them and the rest
 * of a short page is asked from the right row.
 */
export function normalizeOutlinePage(raw: unknown, request: OutlinePageRequest): OutlinePage {
    const given = (raw && typeof raw === 'object' ? raw : {}) as Partial<OutlinePage>;
    const rows: OutlinePageRow[] = [];
    for (const candidate of Array.isArray(given.rows) ? given.rows.slice(0, request.limit) : []) {
        if (!candidate || typeof candidate !== 'object') {
            rows.push({ id: '', label: '' });
            continue;
        }
        const id = typeof candidate.id === 'string' ? candidate.id : '';
        const row: OutlinePageRow = { id, label: line(candidate.label) || id };
        const detail = line(candidate.detail);
        if (detail !== '') {
            row.detail = detail;
        }
        if (typeof candidate.nodeId === 'string' && candidate.nodeId !== '') {
            row.nodeId = candidate.nodeId;
        }
        if (typeof candidate.family === 'string' && candidate.family !== '') {
            row.family = candidate.family;
        }
        if (Array.isArray(candidate.badges)) {
            const badges = candidate.badges
                .filter(badge => badge && typeof badge.text === 'string' && badge.text.trim() !== '')
                .slice(0, BADGES_MAX)
                .map(badge => ({ text: line(badge.text), ...(typeof badge.tone === 'string' ? { tone: badge.tone } : {}) }));
            if (badges.length > 0) {
                row.badges = badges;
            }
        }
        rows.push(row);
    }
    const total = Number.isFinite(given.total) ? Math.max(0, Math.floor(given.total as number)) : request.offset + rows.length;
    return { total: Math.max(total, rows.length > 0 ? request.offset + rows.length : 0), offset: request.offset, rows };
}

/**
 * A count in words: "1 node", "113,750 nodes", or with the producer's words
 * for what it counts (`{ one: 'cell', other: 'cells' }`). A bare number when
 * there are no words.
 */
export function countInWords(count: number, noun?: { one: string; other: string }): string {
    const number = count.toLocaleString('en-US');
    if (!noun) {
        return number;
    }
    return `${number} ${count === 1 ? noun.one : noun.other}`;
}
