/**
 * The hierarchy outline: a tree of every workflow instance under the editor's
 * root, and the way to reach any of them.
 *
 * Navigating a hierarchy in one editor, double-clicking down one level at a time
 * is no way to reach an instance six levels deep, nor to see what is there.
 * Modelled on mlir-viewer's file outline, and cheap in the same way: the tree is
 * plain data on the root model's args (`wf:hierarchy`), so opening, closing and
 * filtering rows lays nothing out. Only choosing a row loads a view.
 *
 * A single click *looks*: it selects and centers the instance's node in the
 * view that contains it, opening that view first if another is shown. A double
 * click *goes*: it opens the instance's own view, at the same trail a
 * drill-down and the breadcrumb would give it. The current view's row is
 * highlighted and its ancestors opened, so the outline and the breadcrumb are
 * the same trail.
 *
 * A producer can give its units more of a shape (`HierarchyOutlineEntry.role`):
 * group rows (a folder, a layer) only open and close; node rows stand for a node
 * in the view above them, which a single click finds there and a double click
 * double-clicks, so it does what the canvas would (open its file, its first
 * view, the unit behind it). Rows carry the producer's label and detail, its
 * node family's colour and its badges.
 *
 * Rows are drawn only where the panel is scrolled to (`outline-rows.ts`): the
 * rows are one height, so which ones are in view is arithmetic, and a tree of
 * a hundred thousand rows has as many rows in the DOM as one of forty. A
 * group may be lazy (shared `outline-pages.ts`): its rows are the host's,
 * asked for a page at a time as it is opened and scrolled (`outline-pager.ts`),
 * and a filter is answered by the host for them. A row with no node of the
 * graph behind it (an `item` row, a lazy row without `nodeId`) is the
 * product's: a click hands its id to the host. And the host can point the
 * outline at a row: it opens the rows down to it, fetches its page, selects
 * it and scrolls it into view.
 */
import { inject, injectable, multiInject, optional } from 'inversify';
import { raiseFloatingPanel, stackAsFloatingPanel } from './floating-panels';
import { findNodeIdByGraphId } from './producer-ids';
import { EditorContextService, TYPES, type IActionDispatcher, type MouseListener } from '@eclipse-glsp/client';
import { RequestModelAction } from '@eclipse-glsp/sprotty';
import { CenterAction, SelectAction } from '@eclipse-glsp/protocol';
import {
    OUTLINE_ACTIVATE_MESSAGE,
    OUTLINE_REPLY_MESSAGE,
    OUTLINE_REQUEST_MESSAGE,
    OUTLINE_REVEAL_MESSAGE,
    WorkflowDiagramMetadata,
    type HierarchyOutlineEntry,
    type OutlinePageRow,
    type OutlineReplyPayload,
    type OutlineRowReveal
} from '@dialogram/shared';
import { navigatesInPlace } from './navigation-ui';
import { clientBehavior } from './profile';
import { VscodeUi } from './vscode-ui';
import {
    foreignFileName,
    itemId,
    pathOfTrail,
    rowId,
    rowIdsTo,
    rowLabel,
    rowMeta,
    shownDetail,
    trailTo
} from './hierarchy-outline-tree';
import {
    entryPath,
    indexOfEntry,
    indexOfPaged,
    lazyGroupPath,
    layOutOutline,
    OUTLINE_ROW_HEIGHT,
    rowTop,
    scrollGeometry,
    scrollTopFor,
    slotAt,
    visibleRows,
    type OutlineLayout,
    type OutlineSlot
} from './outline-rows';
import { OutlinePager } from './outline-pager';

const PANEL_ID = 'workflow-hierarchy-outline';
const BODY_ID = 'workflow-hierarchy-outline-body';
const SEARCH_ID = 'workflow-hierarchy-outline-search';
const TOGGLE_ID = 'workflow-hierarchy-outline-toggle';
const OPEN_STORAGE_KEY = 'dialogram.hierarchyOutline.open';
/** The class of a row's family colour, an existing class of the stylesheet. */
const FAMILY_COLOR_CLASS = 'workflow-hierarchy-outline-chip';
/** How long a click waits to find out it was the first half of a double click. */
const DOUBLE_CLICK_GRACE_MS = 220;
/** How long typing waits before a filter goes to the host, for an outline with lazy groups. */
const HOST_FILTER_DELAY_MS = 150;
/** How long the panel waits for the host's answer before it shows the rows as not loaded. */
const HOST_ANSWER_TIMEOUT_MS = 30_000;
/** The panel's height when it cannot be measured (it is laid out as it opens). */
const UNMEASURED_VIEW_PX = 400;

function storedOpen(): boolean {
    try {
        return globalThis.localStorage?.getItem(OPEN_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function storeOpen(open: boolean): void {
    try {
        globalThis.localStorage?.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
    } catch {
        // ignore
    }
}

/** Whether the outline has a group whose rows are the host's. */
function hasLazyGroup(entry: HierarchyOutlineEntry): boolean {
    return entry.lazy !== undefined || entry.children.some(hasLazyGroup);
}

/** The key of the row selected: a row of the outline by its id, a lazy group's row by group and id. */
function entryKey(entry: HierarchyOutlineEntry): string {
    return `e\u0000${rowId(entry)}`;
}

function pagedKey(group: string, id: string): string {
    return `p\u0000${group}\u0000${id}`;
}

/** Where the panel is to scroll to once it is drawn. */
/**
 * A row to scroll to once it is laid out, by id: an outline that comes again
 * (a reload, while the panel is closed) is new objects, and still has it.
 */
type ScrollTarget = { id: string } | { group: string; position: number };

@injectable()
export class HierarchyOutlinePanel {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
    @inject(EditorContextService) protected readonly editorContext!: EditorContextService;
    /** The canvas's own double-click handling, which a node row's double click runs. */
    @multiInject(TYPES.MouseListener) @optional() protected readonly mouseListeners: MouseListener[] = [];

    private outline: HierarchyOutlineEntry | undefined;
    private renderedJson: string | undefined;
    private readonly expanded = new Set<string>(['']);
    /** The filter, lower-cased, for the rows the webview has. */
    private query = '';
    /** The filter as typed, trimmed, for the rows the host has. */
    private hostQuery = '';
    private open = storedOpen();
    private currentPath: string[] = [];
    private root: unknown;
    private wired = false;
    private listening = false;
    private clickTimer: ReturnType<typeof setTimeout> | undefined;
    private filterTimer: ReturnType<typeof setTimeout> | undefined;
    /** What to select once the view containing it has loaded, and whether to open it. */
    private pendingFocus: Focus | undefined;
    /** A row the host asked to show before there was an outline to show it in. */
    private pendingReveal: OutlineRowReveal | undefined;
    private layout: OutlineLayout = { segments: [], total: 0 };
    private layoutStale = true;
    private drawQueued = false;
    private selected: string | undefined;
    private scrollTarget: ScrollTarget | undefined;
    private requestCount = 0;
    private readonly replies = new Map<string, (reply: OutlineReplyPayload) => void>();
    private readonly pager = new OutlinePager(
        {
            page: (group, offset, limit, query) => this.ask({ op: 'page', group, offset, limit, query }),
            locate: (group, id, query) => this.ask({ op: 'locate', group, id, query })
        },
        () => this.relayout()
    );

    modelRootChanged(root: unknown): void {
        this.listen();
        this.root = root;
        const raw = (root as { args?: Record<string, unknown> })?.args?.['wf:hierarchy'];
        if (!navigatesInPlace() || typeof raw !== 'string') {
            this.setAvailable(false);
            return;
        }
        if (raw !== this.renderedJson) {
            try {
                this.outline = JSON.parse(raw) as HierarchyOutlineEntry;
                this.renderedJson = raw;
            } catch {
                this.setAvailable(false);
                return;
            }
            // Another outline: the host's rows of the one before are not its rows.
            this.pager.reset();
            this.layoutStale = true;
        }
        // The trail the server echoes on the root: this view's own, whichever
        // listener the model reaches first.
        this.currentPath = pathOfTrail(trailOfRoot(root));
        for (const id of this.outline ? rowIdsTo(this.outline, this.currentPath) : []) {
            if (!this.expanded.has(id)) {
                this.expanded.add(id);
                this.layoutStale = true;
            }
        }
        this.setAvailable(true);
        this.resolvePendingFocus();
        this.render();
        const reveal = this.pendingReveal;
        if (reveal) {
            this.pendingReveal = undefined;
            void this.reveal(reveal);
        }
    }

    // ── Chrome ──────────────────────────────────────────────────────────

    private ensureChrome(): void {
        if (typeof document === 'undefined' || !document.body || document.getElementById(PANEL_ID)) {
            return;
        }
        const title = outlineTitle();
        const holder = document.createElement('div');
        holder.innerHTML = `
            <aside id="${PANEL_ID}" class="workflow-hierarchy-outline" aria-label="${title}" hidden>
                <div class="workflow-hierarchy-outline-header">
                    <span class="workflow-hierarchy-outline-title">${title}</span>
                    <button class="workflow-hierarchy-outline-btn" data-action="collapse" type="button" title="Collapse all rows">
                        <span class="codicon codicon-collapse-all"></span>
                    </button>
                    <button class="workflow-hierarchy-outline-btn" data-action="close" type="button" title="Close">
                        <span class="codicon codicon-close"></span>
                    </button>
                </div>
                <input id="${SEARCH_ID}" class="workflow-hierarchy-outline-search" type="text"
                       placeholder="Filter…" aria-label="Filter the ${title.toLowerCase()}" spellcheck="false" />
                <div id="${BODY_ID}" class="workflow-hierarchy-outline-body" role="tree">
                    <div class="workflow-hierarchy-outline-spacer"></div>
                </div>
            </aside>
            <button id="${TOGGLE_ID}" class="workflow-fab-btn workflow-hierarchy-outline-toggle floating" type="button"
                    title="${title} (O)" aria-label="Toggle the ${title.toLowerCase()}" hidden>
                <span class="codicon codicon-type-hierarchy"></span>
            </button>`;
        while (holder.firstChild) {
            document.body.appendChild(holder.firstChild);
        }
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
            stackAsFloatingPanel(panel);
        }
    }

    private wire(): void {
        if (this.wired || typeof document === 'undefined') {
            return;
        }
        this.wired = true;
        document.getElementById(TOGGLE_ID)?.addEventListener('click', () => this.setOpen(!this.open));
        const panel = document.getElementById(PANEL_ID);
        panel?.querySelector('[data-action="close"]')?.addEventListener('click', () => this.setOpen(false));
        panel?.querySelector('[data-action="collapse"]')?.addEventListener('click', () => {
            this.expanded.clear();
            this.expanded.add('');
            this.layoutStale = true;
            const body = document.getElementById(BODY_ID);
            if (body) {
                body.scrollTop = 0;
            }
            this.render();
        });
        document.getElementById(SEARCH_ID)?.addEventListener('input', event => {
            const typed = (event.target as HTMLInputElement).value.trim();
            if (this.filterTimer) {
                clearTimeout(this.filterTimer);
                this.filterTimer = undefined;
            }
            // Rows the host has are filtered there: a keystroke at a time would
            // be a request at a time.
            if (this.outline && hasLazyGroup(this.outline)) {
                this.filterTimer = setTimeout(() => {
                    this.filterTimer = undefined;
                    this.setFilter(typed);
                }, HOST_FILTER_DELAY_MS);
            } else {
                this.setFilter(typed);
            }
        });
        const body = document.getElementById(BODY_ID);
        body?.addEventListener('click', event => this.onRowClick(event, false));
        body?.addEventListener('dblclick', event => this.onRowClick(event, true));
        body?.addEventListener('scroll', () => this.queueDraw(), { passive: true });
        // The body changes size with no scroll (the panel placed again, its
        // limit changed): the rows in view are drawn again.
        if (body && typeof ResizeObserver === 'function') {
            new ResizeObserver(() => this.queueDraw()).observe(body);
        }
        window.addEventListener('resize', () => {
            this.placeNearButton();
            this.queueDraw();
        });
        document.addEventListener('keydown', event => {
            const target = event.target as HTMLElement | null;
            const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
            if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'o'
                && !document.getElementById(TOGGLE_ID)?.hidden) {
                event.preventDefault();
                this.setOpen(!this.open);
            }
        });
    }

    /** The host's answers, and its "show this row". */
    private listen(): void {
        if (this.listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }
        this.listening = true;
        window.addEventListener('message', (event: MessageEvent) => {
            const message = event.data as { type?: unknown; payload?: unknown } | undefined;
            if (message?.type === OUTLINE_REPLY_MESSAGE) {
                const reply = message.payload as OutlineReplyPayload | undefined;
                const answer = reply ? this.replies.get(reply.requestId) : undefined;
                if (reply && answer) {
                    this.replies.delete(reply.requestId);
                    answer(reply);
                }
            } else if (message?.type === OUTLINE_REVEAL_MESSAGE && message.payload && typeof message.payload === 'object') {
                void this.reveal(message.payload as OutlineRowReveal);
            }
        });
    }

    private setFilter(typed: string): void {
        this.hostQuery = typed;
        this.query = typed.toLowerCase();
        this.layoutStale = true;
        const body = document.getElementById(BODY_ID);
        if (body) {
            body.scrollTop = 0;
        }
        this.render();
    }

    private setAvailable(available: boolean): void {
        this.ensureChrome();
        this.wire();
        const toggle = document.getElementById(TOGGLE_ID);
        const panel = document.getElementById(PANEL_ID);
        if (toggle) {
            toggle.hidden = !available;
            placeInButtonStack(toggle);
            // The stack and the chat button may be put in place after this
            // listener runs; place it again once they are.
            requestAnimationFrame(() => placeInButtonStack(toggle));
        }
        if (panel) {
            panel.hidden = !available || !this.open;
        }
        // The button may have moved (the stack grows and shrinks): follow it.
        requestAnimationFrame(() => this.placeNearButton());
    }

    private setOpen(open: boolean): void {
        this.open = open;
        storeOpen(open);
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
            panel.hidden = !open;
        }
        document.getElementById(TOGGLE_ID)?.classList.toggle('active', open);
        if (open) {
            if (panel) {
                raiseFloatingPanel(panel);
            }
            this.placeNearButton();
            this.render();
        }
    }

    /** Open the panel beside its button, wherever the button stack put it. */
    private placeNearButton(): void {
        const panel = document.getElementById(PANEL_ID);
        const toggle = document.getElementById(TOGGLE_ID);
        if (!panel || !toggle || panel.hidden || toggle.hidden) {
            return;
        }
        const rect = toggle.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            return;
        }
        // The canvas, not the window: a docked property panel takes part of the window.
        const canvas = document.querySelector<HTMLElement>('.sprotty-container')?.getBoundingClientRect();
        const place = panelPlacement(
            rect,
            { width: window.innerWidth, height: window.innerHeight },
            canvas && canvas.width > 0 ? { left: canvas.left, width: canvas.width } : undefined
        );
        panel.style.right = `${place.right}px`;
        panel.style.bottom = `${place.bottom}px`;
        panel.style.maxHeight = `${place.maxHeight}px`;
        if (place.width !== undefined) {
            panel.style.width = `${place.width}px`;
        }
    }

    // ── Rows ────────────────────────────────────────────────────────────

    /** Lay the rows out again (the host said how many a group has, or sent a page), and draw. */
    private relayout(): void {
        this.layoutStale = true;
        this.queueDraw();
    }

    private queueDraw(): void {
        if (this.drawQueued) {
            return;
        }
        this.drawQueued = true;
        const run = (): void => {
            this.drawQueued = false;
            this.render();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 0);
        }
    }

    /** Draw the rows in view, and ask the host for the pages they are on. */
    private render(): void {
        const body = document.getElementById(BODY_ID);
        if (!body || !this.outline || !this.open) {
            return;
        }
        if (this.layoutStale) {
            this.layoutStale = false;
            this.layout = layOutOutline(this.outline, {
                expanded: this.expanded,
                query: this.query,
                lazyTotal: group => this.pager.total(group.lazy!.id, this.hostQuery)
            });
        }
        const total = this.layout.total;
        let spacer = body.querySelector<HTMLElement>(':scope > .workflow-hierarchy-outline-spacer');
        if (!spacer) {
            spacer = document.createElement('div');
            spacer.className = 'workflow-hierarchy-outline-spacer';
            body.prepend(spacer);
        }
        // The spacer's height does not depend on the view, and the body grows
        // with it up to the panel's limit: the view is measured once it is set.
        spacer.style.height = `${scrollGeometry(total, OUTLINE_ROW_HEIGHT, 0).height}px`;
        const view = body.clientHeight > 0 ? body.clientHeight : UNMEASURED_VIEW_PX;

        const target = this.scrollTarget;
        if (target) {
            const index = this.indexOfTarget(target);
            if (index >= 0) {
                this.scrollTarget = undefined;
                body.scrollTop = scrollTopFor(index, body.scrollTop, view, OUTLINE_ROW_HEIGHT, total);
            }
        }

        const { first, last, offset } = visibleRows(body.scrollTop, view, OUTLINE_ROW_HEIGHT, total);
        const rows: HTMLElement[] = [spacer];
        const shown = new Map<string, { group: string; query: string; from: number; to: number }>();
        for (let index = first; index <= last; index++) {
            const slot = slotAt(this.layout, index);
            if (!slot) {
                break;
            }
            const row = slot.kind === 'entry' ? this.entryRow(slot) : this.pagedRow(slot);
            row.dataset.index = String(index);
            row.style.top = `${rowTop(index, body.scrollTop, offset, OUTLINE_ROW_HEIGHT)}px`;
            rows.push(row);
            if (slot.kind === 'paged') {
                const group = slot.group.lazy!.id;
                const range = shown.get(group);
                shown.set(group, range
                    ? { ...range, to: slot.position }
                    : { group, query: this.hostQuery, from: slot.position, to: slot.position });
            }
        }
        body.replaceChildren(...rows);
        this.pager.want([...shown.values()]);
    }

    /** Where a row to scroll to is laid out, or -1 while it is not. */
    private indexOfTarget(target: ScrollTarget): number {
        if (!this.outline) {
            return -1;
        }
        if ('id' in target) {
            const path = entryPath(this.outline, target.id);
            return path.length > 0 ? indexOfEntry(this.layout, path[path.length - 1]) : -1;
        }
        const path = lazyGroupPath(this.outline, target.group);
        return path.length > 0 ? indexOfPaged(this.layout, path[path.length - 1], target.position) : -1;
    }

    private rowShell(depth: number, key: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'workflow-hierarchy-outline-row';
        row.setAttribute('role', 'treeitem');
        row.style.paddingLeft = `${6 + depth * 14}px`;
        if (key === this.selected) {
            row.classList.add('selected');
            row.setAttribute('aria-selected', 'true');
        }
        return row;
    }

    private entryRow(slot: Extract<OutlineSlot, { kind: 'entry' }>): HTMLElement {
        const entry = slot.entry;
        const id = rowId(entry);
        // A filter opens every row with a match beneath it.
        const isOpen = this.query !== '' || this.expanded.has(id);
        const row = this.rowShell(slot.depth, entryKey(entry));
        row.dataset.rowId = id;
        const view = entry.role !== 'group' && entry.role !== 'node' && entry.role !== 'item';
        row.classList.toggle('current', view && id === this.currentPath.join('/'));
        if (entry.role) {
            row.classList.add(`role-${entry.role}`);
        }

        const twisty = document.createElement('span');
        twisty.className = 'workflow-hierarchy-outline-twisty codicon';
        // A closed lazy group is not asked for its rows; an open one, or one
        // under a filter, has been by the layout.
        const lazyTotal = entry.lazy ? this.pager.known(entry.lazy.id, this.hostQuery) : undefined;
        const opens = entry.lazy
            ? (this.query === '' ? (entry.count ?? lazyTotal ?? 1) : (lazyTotal ?? 1)) > 0
            : entry.children.length > 0;
        if (opens) {
            twisty.classList.add(isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right');
            twisty.dataset.toggle = id;
            row.setAttribute('aria-expanded', String(isOpen));
        }
        row.appendChild(twisty);

        const color = entry.family ? familyColor(entry.family) : undefined;
        if (color) {
            const chip = document.createElement('span');
            chip.className = 'workflow-hierarchy-outline-chip';
            chip.style.background = color;
            row.appendChild(chip);
        }

        const label = document.createElement('span');
        label.className = 'workflow-hierarchy-outline-label';
        label.textContent = rowLabel(entry);
        row.appendChild(label);

        const detail = shownDetail(entry);
        if (detail) {
            const type = document.createElement('span');
            type.className = 'workflow-hierarchy-outline-type';
            type.textContent = detail;
            row.appendChild(type);
        }
        appendBadges(row, entry.badges);
        // A row the producer labels says what it is; the file chip is for an
        // instance known only by name.
        const file = entry.role || entry.label ? undefined : foreignFileName(entry, this.outline?.sourceUri);
        if (file) {
            const chip = document.createElement('span');
            chip.className = 'workflow-hierarchy-outline-file';
            chip.textContent = file;
            row.appendChild(chip);
        }
        // A lazy group says how many rows the host found (under the filter,
        // if there is one), and before it has said, the count it was given.
        const said = rowMeta(entry, lazyTotal);
        const meta = document.createElement('span');
        meta.className = 'workflow-hierarchy-outline-meta';
        meta.classList.toggle('error', said.error === true);
        meta.textContent = said.text;
        if (said.title) {
            row.title = said.title;
        }
        row.appendChild(meta);
        return row;
    }

    private pagedRow(slot: Extract<OutlineSlot, { kind: 'paged' }>): HTMLElement {
        const group = slot.group.lazy!.id;
        const found = this.pager.row(group, this.hostQuery, slot.position);
        const row = this.rowShell(slot.depth, found ? pagedKey(group, found.id) : '');
        row.classList.add('paged');
        const twisty = document.createElement('span');
        twisty.className = 'workflow-hierarchy-outline-twisty';
        row.appendChild(twisty);
        const label = document.createElement('span');
        label.className = 'workflow-hierarchy-outline-label';
        row.appendChild(label);
        if (!found) {
            const failure = this.pager.failure(group, this.hostQuery, slot.position);
            row.classList.add(failure ? 'failed' : 'loading');
            label.textContent = failure ? 'Not loaded' : 'Loading…';
            if (failure) {
                row.title = failure;
            }
            return row;
        }
        row.dataset.itemId = found.id;
        row.classList.add(found.nodeId ? 'role-node' : 'role-item');
        const color = found.family ? familyColor(found.family) : undefined;
        if (color) {
            // The family's colour, drawn as the outline's own rows draw it.
            const swatch = document.createElement('span');
            swatch.className = FAMILY_COLOR_CLASS;
            swatch.style.background = color;
            row.insertBefore(swatch, label);
        }
        label.textContent = found.label;
        if (found.detail) {
            const type = document.createElement('span');
            type.className = 'workflow-hierarchy-outline-type';
            type.textContent = found.detail;
            row.appendChild(type);
        }
        appendBadges(row, found.badges);
        return row;
    }

    private onRowClick(event: MouseEvent, isDouble: boolean): void {
        const target = event.target as HTMLElement;
        const toggle = target.closest<HTMLElement>('[data-toggle]');
        if (toggle && !isDouble) {
            this.toggle(toggle.dataset.toggle!);
            return;
        }
        const row = target.closest<HTMLElement>('.workflow-hierarchy-outline-row');
        const slot = row?.dataset.index !== undefined ? slotAt(this.layout, Number(row.dataset.index)) : undefined;
        if (!slot) {
            return;
        }
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = undefined;
        }
        let act: (double: boolean) => void;
        if (slot.kind === 'paged') {
            const group = slot.group.lazy!.id;
            const found = this.pager.row(group, this.hostQuery, slot.position);
            // A row the producer gave no id is shown and is nothing to click.
            if (!found || found.id === '') {
                return;
            }
            act = double => this.actOnPaged(group, found, slot.viewPath, double);
        } else {
            const entry = slot.entry;
            act = double => {
                if (entry.role === 'group') {
                    this.toggle(rowId(entry));
                } else if (entry.role === 'node') {
                    this.focusNode(entry, double);
                } else if (entry.role === 'item') {
                    this.select(entryKey(entry));
                    this.activate(itemId(entry), undefined, double);
                } else if (double) {
                    this.openView(entry.path);
                } else {
                    this.look(entry);
                }
            };
        }
        if (isDouble) {
            act(true);
            return;
        }
        this.clickTimer = setTimeout(() => {
            this.clickTimer = undefined;
            act(false);
        }, DOUBLE_CLICK_GRACE_MS);
    }

    /** A lazy group's row: find its node, as a node row does, or hand it to the product. */
    private actOnPaged(group: string, row: OutlinePageRow, viewPath: string[], double: boolean): void {
        this.select(pagedKey(group, row.id));
        if (row.nodeId) {
            this.focus(viewPath, { nodeId: row.nodeId, open: double });
        } else {
            this.activate(row.id, group, double);
        }
    }

    private select(key: string): void {
        this.selected = key;
        this.render();
    }

    /** Hand a row that is the product's to the host, which calls the profile's `outline.activate`. */
    private activate(id: string, group: string | undefined, open: boolean): void {
        this.postToHost({
            type: OUTLINE_ACTIVATE_MESSAGE,
            payload: { sourceUri: this.outlineSource(), id, ...(group ? { group } : {}), open }
        });
    }

    private toggle(id: string): void {
        if (this.expanded.has(id)) {
            this.expanded.delete(id);
        } else {
            this.expanded.add(id);
        }
        this.layoutStale = true;
        this.render();
    }

    // ── The host's rows ─────────────────────────────────────────────────

    /** The file the outline is of: what the host's rows are asked of. */
    private outlineSource(): string {
        return this.outline?.sourceUri ?? this.editorContext?.sourceUri ?? '';
    }

    /** What goes to the host; a test overrides it. */
    protected postToHost(message: unknown): boolean {
        return VscodeUi.instance.post(message);
    }

    /** Ask the host, and wait for its answer, or for long enough to say there is none. */
    private ask(body: Record<string, unknown>): Promise<OutlineReplyPayload> {
        const requestId = `outline-${++this.requestCount}-${Date.now()}`;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.replies.delete(requestId);
                resolve({ requestId, error: 'The host did not answer.' });
            }, HOST_ANSWER_TIMEOUT_MS);
            this.replies.set(requestId, reply => {
                clearTimeout(timer);
                resolve(reply);
            });
            const sent = this.postToHost({
                type: OUTLINE_REQUEST_MESSAGE,
                payload: { requestId, sourceUri: this.outlineSource(), ...body }
            });
            if (!sent) {
                clearTimeout(timer);
                this.replies.delete(requestId);
                resolve({ requestId, error: 'No host to ask.' });
            }
        });
    }

    /**
     * Show the row the host names: open the rows down to it, fetch the page
     * it is on, select it and scroll it into view. A filter that hides it is
     * cleared. A closed panel shows it when it is opened, or now with `show`.
     */
    async reveal(target: OutlineRowReveal): Promise<void> {
        if (!target || typeof target.id !== 'string') {
            return;
        }
        if (!this.outline) {
            this.pendingReveal = target;
            return;
        }
        if (target.show && !this.open) {
            this.setOpen(true);
        }
        if (target.group) {
            const path = lazyGroupPath(this.outline, target.group);
            const group = path[path.length - 1];
            if (!group) {
                return;
            }
            for (const entry of path) {
                this.expanded.add(rowId(entry));
            }
            let position = this.hostQuery === '' && Number.isInteger(target.index)
                ? target.index
                : await this.pager.locate(target.group, target.id, this.hostQuery);
            if (position === undefined && this.hostQuery !== '') {
                // Hidden by the filter: cleared only for a row that is there without it.
                const unfiltered = Number.isInteger(target.index) ? target.index : await this.pager.locate(target.group, target.id, '');
                if (unfiltered !== undefined) {
                    this.clearFilter();
                    position = unfiltered;
                }
            }
            if (position === undefined || position < 0) {
                this.layoutStale = true;
                this.render();
                return;
            }
            await this.pager.rowAt(target.group, this.hostQuery, position);
            this.selected = pagedKey(target.group, target.id);
            this.scrollTarget = { group: target.group, position };
        } else {
            const path = entryPath(this.outline, target.id);
            const entry = path[path.length - 1];
            if (!entry) {
                return;
            }
            for (const above of path.slice(0, -1)) {
                this.expanded.add(rowId(above));
            }
            this.selected = entryKey(entry);
            this.scrollTarget = { id: target.id };
            this.layoutStale = true;
            this.render();
            if (this.open && this.scrollTarget && this.query !== '') {
                // Still not placed: the filter hides it.
                this.clearFilter();
            }
        }
        this.layoutStale = true;
        this.render();
    }

    private clearFilter(): void {
        const input = document.getElementById(SEARCH_ID) as HTMLInputElement | null;
        if (input) {
            input.value = '';
        }
        if (this.filterTimer) {
            clearTimeout(this.filterTimer);
            this.filterTimer = undefined;
        }
        this.hostQuery = '';
        this.query = '';
        this.layoutStale = true;
    }

    // ── Navigation ──────────────────────────────────────────────────────

    /** Select and center an instance's node in the view containing it. */
    private look(entry: HierarchyOutlineEntry): void {
        if (entry.path.length === 0) {
            this.openView([]);
            return;
        }
        this.focus(entry.path.slice(0, -1), { name: entry.path[entry.path.length - 1], nodeId: entry.nodeId });
    }

    /** A node row: find its node in the view above it, and double-click it when `open`. */
    private focusNode(entry: HierarchyOutlineEntry, open: boolean): void {
        this.focus(entry.path.slice(0, -1), { name: entry.path[entry.path.length - 1], nodeId: entry.nodeId, open });
    }

    /** Act on a node of the view at `viewPath`, opening that view first when another is shown. */
    private focus(viewPath: string[], focus: Focus): void {
        if (viewPath.join('/') === this.currentPath.join('/')) {
            this.applyFocus(focus);
            return;
        }
        this.pendingFocus = focus;
        this.openView(viewPath);
    }

    /** Open the view at `path`, at the trail a drill-down would give it. */
    private openView(path: string[]): void {
        if (!this.outline) {
            return;
        }
        const rootUri = this.editorContext.sourceUri ?? this.outline.sourceUri ?? '';
        const trail = trailTo(this.outline, rootUri, path);
        if (!trail) {
            return;
        }
        const target = trail[trail.length - 1];
        void this.dispatcher.dispatch(RequestModelAction.create({
            requestId: `outline-${Date.now()}`,
            options: {
                sourceUri: target.sourceUri,
                diagramType: this.editorContext.diagramType,
                networkName: target.workflowName,
                'wf:navTrail': JSON.stringify(trail)
            }
        }) as never);
    }

    private resolvePendingFocus(): void {
        const focus = this.pendingFocus;
        if (!focus) {
            return;
        }
        this.pendingFocus = undefined;
        // After the view has rendered it.
        setTimeout(() => this.applyFocus(focus), 0);
    }

    /**
     * Select and center the node (by the producer's id when the row has one,
     * else by its instance name), then, for an open, run the canvas's own
     * double-click on it.
     */
    private applyFocus(focus: Focus): void {
        const id = (focus.nodeId ? findNodeIdByGraphId(this.root, focus.nodeId) : undefined)
            ?? (focus.name ? findNodeIdByEntityName(this.root, focus.name) : undefined);
        if (!id) {
            return;
        }
        void this.dispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [id], deselectedElementsIDs: true }) as never);
        void this.dispatcher.dispatch(CenterAction.create([id], { animate: true, retainZoom: true }) as never);
        if (!focus.open) {
            return;
        }
        const element = (this.root as { index?: { getById(id: string): unknown } } | undefined)?.index?.getById(id);
        if (!element) {
            return;
        }
        const event = new MouseEvent('dblclick');
        for (const listener of this.mouseListeners) {
            for (const action of listener.doubleClick(element as never, event)) {
                void Promise.resolve(action).then(resolved => this.dispatcher.dispatch(resolved as never));
            }
        }
    }
}

interface Focus {
    /** The node's instance name, for a row the producer gives no node id. */
    name?: string;
    /** The node's id in the producer's graph (`wf:graphNodeId`). */
    nodeId?: string;
    /** Double-click it once selected. */
    open?: boolean;
}

/** What the panel is called: the profile's word (`clientBehavior.outlineTitle`), else "Hierarchy". */
function outlineTitle(): string {
    const title = clientBehavior().outlineTitle;
    // Plain words only: it goes into markup.
    return typeof title === 'string' && /^[\p{L}\p{N} ._-]{1,40}$/u.test(title.trim()) ? title.trim() : 'Hierarchy';
}

/** A node family's colour, by its id or annotation, from the profile's families. */
function familyColor(family: string): string | undefined {
    const spec = (clientBehavior().nodeFamilies ?? []).find(candidate => (candidate.id ?? candidate.annotation) === family);
    return spec && /^#[0-9a-fA-F]{3,8}$|^[a-z]+$/.test(spec.color) ? spec.color : undefined;
}

/** A row's badges, after its label. */
function appendBadges(row: HTMLElement, badges: Array<{ text: string; tone?: string }> | undefined): void {
    for (const badge of badges ?? []) {
        const mark = document.createElement('span');
        mark.className = `workflow-hierarchy-outline-badge badge-tone-${/^[a-z]+$/.test(badge.tone ?? '') ? badge.tone : 'neutral'}`;
        mark.textContent = badge.text;
        row.appendChild(mark);
    }
}

/** Space between the button and the panel, and kept from the window's top edge. */
const PANEL_GAP_PX = 8;

/** The widest the panel is, px, and the narrowest it is made to fit a narrow canvas. */
const PANEL_MAX_WIDTH_PX = 380;
const PANEL_MIN_WIDTH_PX = 180;

/**
 * Where the panel opens: just left of its button, bottom-aligned with it, and
 * growing upward -- as tall as the room above the button allows. In the
 * coordinates `position: fixed` takes (`right`/`bottom` from the window edges).
 *
 * Given the canvas (what is left of the window beside a docked property
 * panel), it is at most half as wide as the canvas and no wider than the
 * canvas left of the button: measured against the window, a narrow editor
 * with the property panel docked had the outline cover the canvas.
 */
export function panelPlacement(
    button: { left: number; bottom: number },
    window: { width: number; height: number },
    canvas?: { left: number; width: number }
): { right: number; bottom: number; maxHeight: number; width?: number } {
    const place = {
        right: Math.max(PANEL_GAP_PX, window.width - button.left + PANEL_GAP_PX),
        bottom: Math.max(PANEL_GAP_PX, window.height - button.bottom),
        maxHeight: Math.max(160, button.bottom - PANEL_GAP_PX * 2)
    };
    if (!canvas) {
        return place;
    }
    const roomLeftOfButton = button.left - canvas.left - PANEL_GAP_PX * 2;
    const width = Math.min(PANEL_MAX_WIDTH_PX, canvas.width / 2, roomLeftOfButton);
    return { ...place, width: Math.round(Math.max(PANEL_MIN_WIDTH_PX, width)) };
}

/**
 * Put the hierarchy button in the floating button stack, directly under the
 * chat button. The stack is a reversed column -- what comes first in it sits
 * lowest -- so "under chat" is just before it. Without a stack yet, the button
 * floats on its own until one exists.
 */
export function placeInButtonStack(
    toggle: HTMLElement,
    doc: Pick<Document, 'querySelector' | 'getElementById'> = document
): void {
    const stack = doc.querySelector('.workflow-fab-stack');
    if (!stack) {
        toggle.classList.add('floating');
        return;
    }
    toggle.classList.remove('floating');
    const chat = doc.getElementById('workflow-chat-toggle-btn');
    if (chat && chat.parentElement === stack) {
        if (toggle.nextElementSibling !== chat) {
            stack.insertBefore(toggle, chat);
        }
    } else if (toggle.parentElement !== stack) {
        stack.appendChild(toggle);
    }
}

/** The navigation trail a model root carries (`wf:navTrail`, JSON or a list). */
export function trailOfRoot(root: unknown): Array<{ workflowName: string; workflowInstanceName?: string }> {
    const raw = (root as { args?: Record<string, unknown> })?.args?.['wf:navTrail'];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed.filter(c => c && typeof c.workflowName === 'string') : [];
    } catch {
        return [];
    }
}

/** The id of the node the producer calls `graphId` (`wf:graphNodeId`, or the id itself), in a model root. */
/** The id of the node whose entity (instance) name is `name`, in a model root. */
export function findNodeIdByEntityName(root: unknown, name: string): string | undefined {
    const stack: any[] = [root];
    while (stack.length > 0) {
        const element = stack.pop();
        if (!element) {
            continue;
        }
        if (element.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === name) {
            return element.id;
        }
        for (const child of element.children ?? []) {
            stack.push(child);
        }
    }
    return undefined;
}
