/**
 * The host's half of an outline that loads on demand (shared
 * `outline-pages.ts`): it answers the panel's requests for a lazy group's
 * rows with the profile's `outline.page`, hands a click on a row that is the
 * product's to `outline.activate`, and carries the product's "show this row"
 * to the diagrams of the file.
 *
 * The rows stay where the producer has them, in the extension host; only a
 * page at a time crosses to the webview, and only when the reader opens a
 * group or scrolls it. The answer goes to the webview that asked, and only
 * to it: another diagram of the file scrolls its own list.
 */
import { pathToFileURL } from 'node:url';
import {
    normalizeOutlinePage,
    normalizeOutlinePageRequest,
    OUTLINE_REPLY_MESSAGE,
    OUTLINE_REVEAL_MESSAGE,
    type OutlinePage,
    type OutlinePageRequest,
    type OutlineReplyPayload,
    type OutlineRowActivation,
    type OutlineRowReveal
} from '@dialogram/shared';

/** What the profile gives the host for its outline (api.ts `DiagramOutline`). */
export interface OutlineProducer {
    page(file: string, request: OutlinePageRequest): OutlinePage | Promise<OutlinePage>;
    locate?(file: string, row: { group: string; id: string; query: string }): number | undefined | Promise<number | undefined>;
    activate?(file: string, row: OutlineRowActivation): void | Promise<void>;
}

export interface OutlineHostOptions {
    outline?: OutlineProducer;
    /** The path a source URI stands for, as the profile is given it. */
    pathOf(sourceUri: string): string;
    /**
     * The editors showing a file, each once, by an id `post` takes (the
     * editor's GLSP client): a file can have two editors.
     */
    editorsOf(sourceUri: string): string[];
    /** Post to one editor's webview, named as {@link editorsOf} names it. */
    post(editor: string, message: unknown): void;
    log?(message: string): void;
}

/** A file named as a URI string or an absolute path, as a URI string. */
export function asUriString(uri: string): string {
    return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(uri) ? uri : pathToFileURL(uri).toString();
}

export class OutlineHost {
    constructor(private readonly options: OutlineHostOptions) {}

    /**
     * A request from a panel: a page of a lazy group, or where a row is in
     * one. The answer goes to `reply`, the asking webview, always, with an
     * `error` when there is none, so that the panel stops waiting.
     */
    async onWebviewRequest(raw: unknown, reply: (message: unknown) => void): Promise<void> {
        const payload = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const sourceUri = typeof payload.sourceUri === 'string' ? payload.sourceUri : '';
        if (requestId === '') {
            return;
        }
        const answer = (body: Omit<OutlineReplyPayload, 'requestId'>): void =>
            reply({ type: OUTLINE_REPLY_MESSAGE, payload: { requestId, ...body } });
        const outline = this.options.outline;
        if (!outline) {
            answer({ error: 'This diagram has no outline to load.' });
            return;
        }
        const file = this.options.pathOf(sourceUri);
        const started = Date.now();
        try {
            if (payload.op === 'locate') {
                const group = typeof payload.group === 'string' ? payload.group : '';
                const id = typeof payload.id === 'string' ? payload.id : '';
                const query = typeof payload.query === 'string' ? payload.query.trim() : '';
                const index = outline.locate ? await outline.locate(file, { group, id, query }) : undefined;
                answer({
                    index: Number.isInteger(index) && (index as number) >= 0 ? (index as number) : undefined,
                    ms: Date.now() - started
                });
                return;
            }
            const request = normalizeOutlinePageRequest(payload as Partial<OutlinePageRequest>);
            const page = normalizeOutlinePage(await outline.page(file, request), request);
            answer({ page, ms: Date.now() - started });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.log?.(`[dialogram outline] the producer could not answer for ${file}: ${message}`);
            answer({ error: message, ms: Date.now() - started });
        }
    }

    /** A click on a row that is the product's: handed to the profile with the row's id. */
    async onWebviewActivate(raw: unknown): Promise<void> {
        const payload = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const id = typeof payload.id === 'string' ? payload.id : '';
        const sourceUri = typeof payload.sourceUri === 'string' ? payload.sourceUri : '';
        if (id === '' || !this.options.outline?.activate) {
            return;
        }
        const row: OutlineRowActivation = { id, open: payload.open === true };
        if (typeof payload.group === 'string' && payload.group !== '') {
            row.group = payload.group;
        }
        try {
            await this.options.outline.activate(this.options.pathOf(sourceUri), row);
        } catch (error) {
            this.options.log?.(`[dialogram outline] the product's row action failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Show a row in the outline of every diagram of the file: its group
     * opened, its page fetched, the row selected and scrolled into view.
     * Returns how many diagrams were told (none: no diagram of it is open).
     */
    reveal(uri: string, row: OutlineRowReveal): number {
        if (!row || typeof row.id !== 'string' || row.id === '') {
            return 0;
        }
        const sourceUri = asUriString(uri);
        const payload: OutlineRowReveal & { sourceUri: string } = { sourceUri, id: row.id };
        if (typeof row.group === 'string' && row.group !== '') {
            payload.group = row.group;
        }
        if (Number.isInteger(row.index) && (row.index as number) >= 0) {
            payload.index = row.index;
        }
        if (row.show === true) {
            payload.show = true;
        }
        const editors = this.options.editorsOf(sourceUri);
        for (const editor of editors) {
            this.options.post(editor, { type: OUTLINE_REVEAL_MESSAGE, payload });
        }
        return editors.length;
    }
}
