/**
 * The view options as the palette draws them: under its tools, in its own
 * markup (`tool-group`, `group-header`, `tool-button`), so that the theme
 * that styles the palette's tools styles these too.
 *
 * A group is a heading that opens and closes (a click on it), with how many
 * of its lines are checked and, for a list of many, All and None; each line
 * a check box, the producer's colour swatch, its label and, on hover, Only
 * (Alt+click does the same). A line that cannot change says why in its
 * tooltip, and reads as one that cannot rather than as one unchecked: a
 * dashed box, its label in italics, a "no" mark at its end. A `one` group is
 * radio buttons. The lines of a long group scroll under its heading, so
 * that the palette's tools and the other groups stay in reach.
 *
 * The palette's filter box filters these lines too, by label.
 */
import type { ViewOptionChange, ViewOptionGroup, ViewOptionItem } from '@dialogram/shared';
import { settingsNamespace } from './profile';

/** The class of the element holding the groups, last in the palette's body. */
export const VIEW_OPTIONS_CLASS = 'view-options';

/** What the drawing needs besides the groups. */
export interface ViewOptionsDrawing {
    /** The palette's filter, as typed. */
    filter: string;
    isCollapsed(group: ViewOptionGroup): boolean;
    onCollapse(group: ViewOptionGroup, collapsed: boolean): void;
    onChange(change: ViewOptionChange): void;
}

/** The lines of a group a filter keeps: all when it is empty, or when the group's own label matches. */
export function linesMatching(group: ViewOptionGroup, filter: string): ViewOptionItem[] {
    const wanted = filter.trim().toLowerCase();
    if (wanted === '' || group.label.toLowerCase().includes(wanted)) {
        return group.items;
    }
    return group.items.filter(item => item.label.toLowerCase().includes(wanted));
}

/** What a group's heading says of its lines: "12 of 30" checked; nothing for a `one` group. */
export function checkedSummary(group: ViewOptionGroup): string {
    if (group.choice === 'one' || group.items.length === 0) {
        return '';
    }
    const checked = group.items.filter(item => item.checked !== false).length;
    return `${checked} of ${group.items.length}`;
}

/** A colour a swatch may be painted with: a CSS colour, a theme variable, nothing that could be more. */
export function swatchColor(color: string | undefined): string | undefined {
    if (!color) {
        return undefined;
    }
    const value = color.trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(value)
        || /^(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)$/.test(value)
        || /^var\(--[A-Za-z0-9-]+\)$/.test(value)
        || /^[a-zA-Z]+$/.test(value)
        ? value
        : undefined;
}

function icon(codicon: string, ...classes: string[]): HTMLElement {
    const element = document.createElement('i');
    element.classList.add('codicon', `codicon-${codicon}`, ...classes);
    return element;
}

/** The groups, drawn; an empty list when none has a line the filter keeps. */
export function drawViewOptionGroups(groups: ViewOptionGroup[], drawing: ViewOptionsDrawing): HTMLElement[] {
    const drawn: HTMLElement[] = [];
    const filtering = drawing.filter.trim() !== '';
    for (const group of groups) {
        const lines = linesMatching(group, drawing.filter);
        if (lines.length === 0 && (filtering || group.items.length === 0)) {
            continue;
        }
        // A filter opens what it found.
        const collapsed = !filtering && drawing.isCollapsed(group);
        const element = document.createElement('div');
        element.classList.add('tool-group', 'view-options-group');
        element.dataset.group = group.id;
        element.setAttribute('role', group.choice === 'one' ? 'radiogroup' : 'group');
        element.setAttribute('aria-label', group.label);

        const header = document.createElement('div');
        header.classList.add('group-header', 'view-options-header');
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', String(!collapsed));
        header.tabIndex = 0;
        header.title = collapsed ? `Show ${group.label}` : `Hide the lines of ${group.label}`;
        header.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down', 'view-options-twisty'));
        const title = document.createElement('span');
        title.classList.add('view-options-title');
        title.textContent = group.label;
        header.appendChild(title);
        const summary = checkedSummary(group);
        if (summary) {
            const count = document.createElement('span');
            count.classList.add('view-options-count');
            count.textContent = summary;
            header.appendChild(count);
        }
        if (group.choice !== 'one' && group.items.length > 1) {
            const actions = document.createElement('span');
            actions.classList.add('view-options-actions');
            const all = icon('check-all', 'view-options-all');
            all.title = `Check every line of ${group.label}`;
            all.setAttribute('role', 'button');
            all.setAttribute('aria-label', all.title);
            all.addEventListener('click', event => {
                event.stopPropagation();
                drawing.onChange({ group: group.id, all: true });
            });
            const none = icon('close-all', 'view-options-none');
            none.title = `Uncheck every line of ${group.label}`;
            none.setAttribute('role', 'button');
            none.setAttribute('aria-label', none.title);
            none.addEventListener('click', event => {
                event.stopPropagation();
                drawing.onChange({ group: group.id, all: false });
            });
            actions.append(all, none);
            header.appendChild(actions);
        }
        const flip = (): void => drawing.onCollapse(group, !collapsed);
        header.addEventListener('click', flip);
        header.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                flip();
            }
        });
        element.appendChild(header);

        if (!collapsed) {
            const list = document.createElement('div');
            list.classList.add('view-options-lines');
            for (const item of lines) {
                list.appendChild(drawLine(group, item, drawing));
            }
            element.appendChild(list);
        }
        drawn.push(element);
    }
    return drawn;
}

function drawLine(group: ViewOptionGroup, item: ViewOptionItem, drawing: ViewOptionsDrawing): HTMLElement {
    const one = group.choice === 'one';
    const checked = item.checked !== false;
    const row = document.createElement('div');
    row.classList.add('tool-button', 'view-option');
    row.dataset.item = item.id;
    row.setAttribute('role', one ? 'radio' : 'checkbox');
    row.setAttribute('aria-checked', String(checked));
    row.tabIndex = 0;
    if (item.disabled) {
        row.classList.add('disabled');
        row.setAttribute('aria-disabled', 'true');
        row.title = item.disabled;
    }

    const box = document.createElement('span');
    box.classList.add('view-option-box', one ? 'radio' : 'check');
    if (checked) {
        box.classList.add('checked');
        box.appendChild(icon(one ? 'circle-filled' : 'check'));
    }
    row.appendChild(box);

    const color = swatchColor(item.color);
    if (color) {
        const swatch = document.createElement('span');
        swatch.classList.add('view-option-swatch');
        swatch.style.background = color;
        row.appendChild(swatch);
    }

    const label = document.createElement('span');
    label.classList.add('view-option-label');
    label.textContent = item.label;
    row.appendChild(label);

    if (item.disabled) {
        const no = icon('circle-slash', 'view-option-locked');
        no.setAttribute('aria-hidden', 'true');
        row.appendChild(no);
    }

    if (!one && !item.disabled && group.items.length > 1) {
        const only = icon('target', 'view-option-only');
        only.title = `Only ${item.label} (Alt+click)`;
        only.setAttribute('role', 'button');
        only.setAttribute('aria-label', `Only ${item.label}`);
        only.addEventListener('click', event => {
            event.stopPropagation();
            drawing.onChange({ group: group.id, only: item.id });
        });
        row.appendChild(only);
    }

    const act = (alone: boolean): void => {
        if (item.disabled) {
            return;
        }
        if (alone && !one) {
            drawing.onChange({ group: group.id, only: item.id });
        } else {
            drawing.onChange({ group: group.id, item: item.id, checked: one ? true : !checked });
        }
    };
    row.addEventListener('click', event => act(event.altKey));
    row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            act(event.altKey);
        }
    });
    return row;
}

/**
 * Which groups the reader closed or opened, against their declared state,
 * kept in the webview's storage for the product: a heading closed stays
 * closed in the next diagram of any file.
 */
export class ViewOptionsCollapse {
    private readonly flipped: Record<string, boolean>;

    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeStorage()) {
        this.flipped = this.read();
    }

    isCollapsed(group: ViewOptionGroup): boolean {
        return this.flipped[group.id] ?? group.collapsed === true;
    }

    set(group: ViewOptionGroup, collapsed: boolean): void {
        this.flipped[group.id] = collapsed;
        try {
            this.storage?.setItem(this.key(), JSON.stringify(this.flipped));
        } catch {
            // The choice still holds while the webview lives.
        }
    }

    private key(): string {
        return `${settingsNamespace()}.viewOptions.collapsed`;
    }

    private read(): Record<string, boolean> {
        try {
            const raw = this.storage?.getItem(this.key());
            const parsed = raw ? JSON.parse(raw) : {};
            const kept: Record<string, boolean> = {};
            for (const [id, value] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
                if (typeof value === 'boolean') {
                    kept[id] = value;
                }
            }
            return kept;
        } catch {
            return {};
        }
    }
}

function safeStorage(): Storage | undefined {
    try {
        return globalThis.localStorage;
    } catch {
        return undefined;
    }
}
