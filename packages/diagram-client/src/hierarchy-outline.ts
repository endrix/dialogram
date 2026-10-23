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
 */
import { inject, injectable, multiInject, optional } from 'inversify';
import { EditorContextService, TYPES, type IActionDispatcher, type MouseListener } from '@eclipse-glsp/client';
import { RequestModelAction } from '@eclipse-glsp/sprotty';
import { CenterAction, SelectAction } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, type HierarchyOutlineEntry } from '@dialogram/shared';
import { navigatesInPlace } from './navigation-ui';
import { clientBehavior } from './profile';
import {
    foreignFileName,
    outlineMatches,
    pathOfTrail,
    rowDetail,
    rowId,
    rowIdsTo,
    rowLabel,
    trailTo
} from './hierarchy-outline-tree';

const PANEL_ID = 'workflow-hierarchy-outline';
const BODY_ID = 'workflow-hierarchy-outline-body';
const SEARCH_ID = 'workflow-hierarchy-outline-search';
const TOGGLE_ID = 'workflow-hierarchy-outline-toggle';
const OPEN_STORAGE_KEY = 'dialogram.hierarchyOutline.open';
/** How long a click waits to find out it was the first half of a double click. */
const DOUBLE_CLICK_GRACE_MS = 220;

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

@injectable()
export class HierarchyOutlinePanel {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
    @inject(EditorContextService) protected readonly editorContext!: EditorContextService;
    /** The canvas's own double-click handling, which a node row's double click runs. */
    @multiInject(TYPES.MouseListener) @optional() protected readonly mouseListeners: MouseListener[] = [];

    private outline: HierarchyOutlineEntry | undefined;
    private renderedJson: string | undefined;
    private readonly expanded = new Set<string>(['']);
    private query = '';
    private open = storedOpen();
    private currentPath: string[] = [];
    private root: unknown;
    private wired = false;
    private clickTimer: ReturnType<typeof setTimeout> | undefined;
    /** What to select once the view containing it has loaded, and whether to open it. */
    private pendingFocus: Focus | undefined;
    /** The entry behind each rendered row, by row id: group rows have no path to look up. */
    private readonly rowEntries = new Map<string, HierarchyOutlineEntry>();

    modelRootChanged(root: unknown): void {
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
        }
        // The trail the server echoes on the root: this view's own, whichever
        // listener the model reaches first.
        this.currentPath = pathOfTrail(trailOfRoot(root));
        for (const id of this.outline ? rowIdsTo(this.outline, this.currentPath) : []) {
            this.expanded.add(id);
        }
        this.setAvailable(true);
        this.resolvePendingFocus();
        this.render();
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
                <div id="${BODY_ID}" class="workflow-hierarchy-outline-body" role="tree"></div>
            </aside>
            <button id="${TOGGLE_ID}" class="workflow-fab-btn workflow-hierarchy-outline-toggle floating" type="button"
                    title="${title} (O)" aria-label="Toggle the ${title.toLowerCase()}" hidden>
                <span class="codicon codicon-type-hierarchy"></span>
            </button>`;
        while (holder.firstChild) {
            document.body.appendChild(holder.firstChild);
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
            this.render();
        });
        document.getElementById(SEARCH_ID)?.addEventListener('input', event => {
            this.query = (event.target as HTMLInputElement).value.trim().toLowerCase();
            this.render();
        });
        const body = document.getElementById(BODY_ID);
        body?.addEventListener('click', event => this.onRowClick(event, false));
        body?.addEventListener('dblclick', event => this.onRowClick(event, true));
        window.addEventListener('resize', () => this.placeNearButton());
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
        const place = panelPlacement(rect, { width: window.innerWidth, height: window.innerHeight });
        panel.style.right = `${place.right}px`;
        panel.style.bottom = `${place.bottom}px`;
        panel.style.maxHeight = `${place.maxHeight}px`;
    }

    // ── Rows ────────────────────────────────────────────────────────────

    private render(): void {
        const body = document.getElementById(BODY_ID);
        if (!body || !this.outline || !this.open) {
            return;
        }
        this.rowEntries.clear();
        body.replaceChildren(...this.renderRows(this.outline, 0));
    }

    private renderRows(entry: HierarchyOutlineEntry, depth: number): HTMLElement[] {
        if (!outlineMatches(entry, this.query)) {
            return [];
        }
        const id = rowId(entry);
        this.rowEntries.set(id, entry);
        // A filter opens every row with a match beneath it.
        const isOpen = this.query !== '' || this.expanded.has(id);
        const row = document.createElement('div');
        row.className = 'workflow-hierarchy-outline-row';
        row.dataset.rowId = id;
        row.setAttribute('role', 'treeitem');
        row.style.paddingLeft = `${6 + depth * 14}px`;
        row.classList.toggle('current', entry.role !== 'group' && entry.role !== 'node' && id === this.currentPath.join('/'));
        if (entry.role) {
            row.classList.add(`role-${entry.role}`);
        }

        const twisty = document.createElement('span');
        twisty.className = 'workflow-hierarchy-outline-twisty codicon';
        if (entry.children.length > 0) {
            twisty.classList.add(isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right');
            twisty.dataset.toggle = id;
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

        const detail = rowDetail(entry);
        if (detail) {
            const type = document.createElement('span');
            type.className = 'workflow-hierarchy-outline-type';
            type.textContent = detail;
            row.appendChild(type);
        }
        for (const badge of entry.badges ?? []) {
            const mark = document.createElement('span');
            mark.className = `workflow-hierarchy-outline-badge badge-tone-${/^[a-z]+$/.test(badge.tone ?? '') ? badge.tone : 'neutral'}`;
            mark.textContent = badge.text;
            row.appendChild(mark);
        }
        // A row the producer labels says what it is; the file chip is for an
        // instance known only by name.
        const file = entry.role || entry.label ? undefined : foreignFileName(entry, this.outline?.sourceUri);
        if (file) {
            const chip = document.createElement('span');
            chip.className = 'workflow-hierarchy-outline-file';
            chip.textContent = file;
            row.appendChild(chip);
        }
        const meta = document.createElement('span');
        meta.className = 'workflow-hierarchy-outline-meta';
        if (entry.error) {
            meta.classList.add('error');
            meta.textContent = 'error';
            row.title = entry.error;
        } else if (entry.truncated) {
            meta.textContent = '…';
            row.title = 'Not expanded: it nests itself, or is too deep';
        } else if (entry.role === 'group') {
            meta.textContent = String(entry.children.length);
        } else if (entry.role !== 'node') {
            const nested = entry.children.filter(child => child.role !== 'node' && child.role !== 'group').length;
            const parts = [
                typeof entry.nodeCount === 'number' ? `${entry.nodeCount} nodes` : undefined,
                nested > 0 ? `${nested} nested` : undefined
            ].filter(Boolean);
            meta.textContent = parts.join(' · ');
        }
        row.appendChild(meta);

        const rows: HTMLElement[] = [row];
        if (isOpen) {
            for (const child of entry.children) {
                rows.push(...this.renderRows(child, depth + 1));
            }
        }
        return rows;
    }

    private onRowClick(event: MouseEvent, isDouble: boolean): void {
        const target = event.target as HTMLElement;
        const toggle = target.closest<HTMLElement>('[data-toggle]');
        if (toggle && !isDouble) {
            const id = toggle.dataset.toggle!;
            if (this.expanded.has(id)) {
                this.expanded.delete(id);
            } else {
                this.expanded.add(id);
            }
            this.render();
            return;
        }
        const row = target.closest<HTMLElement>('.workflow-hierarchy-outline-row');
        const entry = row ? this.rowEntries.get(row.dataset.rowId ?? '') : undefined;
        if (!entry) {
            return;
        }
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = undefined;
        }
        const act = (double: boolean): void => {
            if (entry.role === 'group') {
                this.toggle(rowId(entry));
            } else if (entry.role === 'node') {
                this.focusNode(entry, double);
            } else if (double) {
                this.openView(entry.path);
            } else {
                this.look(entry);
            }
        };
        if (isDouble) {
            act(true);
            return;
        }
        this.clickTimer = setTimeout(() => {
            this.clickTimer = undefined;
            act(false);
        }, DOUBLE_CLICK_GRACE_MS);
    }

    private toggle(id: string): void {
        if (this.expanded.has(id)) {
            this.expanded.delete(id);
        } else {
            this.expanded.add(id);
        }
        this.render();
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

/** Space between the button and the panel, and kept from the window's top edge. */
const PANEL_GAP_PX = 8;

/**
 * Where the panel opens: just left of its button, bottom-aligned with it, and
 * growing upward -- as tall as the room above the button allows. In the
 * coordinates `position: fixed` takes (`right`/`bottom` from the window edges).
 */
export function panelPlacement(
    button: { left: number; bottom: number },
    window: { width: number; height: number }
): { right: number; bottom: number; maxHeight: number } {
    return {
        right: Math.max(PANEL_GAP_PX, window.width - button.left + PANEL_GAP_PX),
        bottom: Math.max(PANEL_GAP_PX, window.height - button.bottom),
        maxHeight: Math.max(160, button.bottom - PANEL_GAP_PX * 2)
    };
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
export function findNodeIdByGraphId(root: unknown, graphId: string): string | undefined {
    const stack: any[] = [root];
    while (stack.length > 0) {
        const element = stack.pop();
        if (!element) {
            continue;
        }
        if (element.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === graphId || (element.id === graphId && element.type?.startsWith?.('node'))) {
            return element.id;
        }
        for (const child of element.children ?? []) {
            stack.push(child);
        }
    }
    return undefined;
}

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
