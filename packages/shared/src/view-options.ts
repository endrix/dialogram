/**
 * What a reader can show and hide in a diagram, from the palette.
 *
 * A producer knows what its view is made of (kinds of things, the strata it
 * draws, roles of ports) and which of them a reader may want out of the way.
 * It declares them as checkable groups ({@link ViewOptionGroup}), on the
 * graph it gives (`GraphDocument.viewOptions`) or once for every graph
 * (`DiagramProfile.viewOptions.groups`). The palette draws them under its
 * tools, in its own style.
 *
 * The host holds what the reader chose, per file, beside the file's layout,
 * so that it is there after a reload and when the file is opened again, and
 * so that the host can read and set it with no diagram open (a chat tool
 * asked to hide something). A choice made in the palette is in force in the
 * webview at once ({@link ViewOptionsChangedAction}, for a product's renderer
 * that redraws without a round trip) and goes to the host
 * ({@link VIEW_OPTIONS_CHANGED_MESSAGE}); a choice made by the host goes to
 * every diagram of the file as the lines it turned
 * ({@link VIEW_OPTIONS_TURNED_MESSAGE}).
 *
 * Types, messages and the arithmetic of a change; no DOM, no VS Code.
 */

/** One checkable line of a group. */
export interface ViewOptionItem {
    /**
     * The producer's name for it, unique in its group: what a change names,
     * and what the reader's choices are kept and handed back under, exactly
     * as given.
     */
    id: string;
    /** What the row says. */
    label: string;
    /**
     * Whether it is checked before the reader chooses. Default `true`; in a
     * `one` group, see {@link ViewOptionGroup.choice}.
     */
    checked?: boolean;
    /** A CSS colour drawn as a swatch before the label: what the item looks like in the view. */
    color?: string;
    /**
     * Why it cannot be changed now ("Not drawn at this zoom"). Set, the row
     * is shown greyed with this as its tooltip, keeps the state it has, and
     * a group's All, None and Only pass it by. In a `one` group it is still
     * unchecked when the reader picks another line: one line stays checked.
     */
    disabled?: string;
}

/** A heading over checkable lines, which the reader opens and closes. */
export interface ViewOptionGroup {
    /** The producer's name for it, unique in the diagram, kept exactly as given. */
    id: string;
    /** What the heading says. */
    label: string;
    items: ViewOptionItem[];
    /**
     * `many` (the default): each line on its own, with All, None and Only.
     * `one`: exactly one line is checked, as radio buttons (a level of
     * detail). The one checked first is the first line declared
     * `checked: true`; with none, the first not declared `checked: false`.
     */
    choice?: 'many' | 'one';
    /** Drawn closed until the reader opens it. Default open. */
    collapsed?: boolean;
    /**
     * Whether the reader's choice is kept beside the file's layout, for the
     * next time it is opened. Default `true`. `false` for a choice that is
     * about how the reader is looking right now rather than about the file:
     * it lasts as long as the window does.
     */
    persist?: boolean;
    /**
     * Whether a change asks the producer for the graph again. Default
     * `false`: the webview follows on its own (a renderer reading
     * {@link ViewOptionsChangedAction}). `true` for a choice the producer
     * applies itself, leaving things out of the graph it gives: its
     * `getGraph` reads the choices from `options.viewOptions`.
     */
    reload?: boolean;
}

/**
 * What the reader chose, by group and item: `true` checked, `false` not. An
 * item it does not name is as its producer declares it. This is what is
 * kept per file and what `getGraph` is handed as `options.viewOptions`.
 */
export type ViewOptionsState = Record<string, Record<string, boolean>>;

/**
 * One change, as a reader makes it in the palette or the host asks for it:
 * a line checked or not, every line of a group (`all`), or one line alone
 * (`only`: it checked, the others of its group not).
 */
export type ViewOptionChange =
    | { group: string; item: string; checked: boolean }
    | { group: string; all: boolean }
    | { group: string; only: string };

/** One line whose state a change turned. */
export interface ViewOptionTurn {
    group: string;
    item: string;
    checked: boolean;
}

/** The root model's argument the groups ride on, as JSON, with their state applied. */
export const VIEW_OPTIONS_ARG = 'wf:viewOptions';

/** Webview to host: the reader changed what is shown. */
export const VIEW_OPTIONS_CHANGED_MESSAGE = 'dialogram.viewOptions.changed';

/**
 * Host to webview: lines of a file's groups the host turned. Lines, not the
 * whole state: a whole state computed before a reader's click reached the
 * host would undo the click in the webview.
 */
export const VIEW_OPTIONS_TURNED_MESSAGE = 'dialogram.viewOptions.turned';

export interface ViewOptionsChangedMessage {
    type: typeof VIEW_OPTIONS_CHANGED_MESSAGE;
    payload: { sourceUri: string; changes: ViewOptionChange[] };
}

export interface ViewOptionsTurnedMessage {
    type: typeof VIEW_OPTIONS_TURNED_MESSAGE;
    payload: { sourceUri: string; turns: ViewOptionTurn[] };
}

/** Whether a value posted to a webview is a {@link ViewOptionsTurnedMessage}. */
export function isViewOptionsTurnedMessage(value: unknown): value is ViewOptionsTurnedMessage {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== VIEW_OPTIONS_TURNED_MESSAGE) {
        return false;
    }
    const payload = (value as { payload?: { sourceUri?: unknown; turns?: unknown } }).payload;
    return !!payload && typeof payload.sourceUri === 'string' && Array.isArray(payload.turns)
        && payload.turns.every(turn => !!turn && typeof turn.group === 'string' && typeof turn.item === 'string' && typeof turn.checked === 'boolean');
}

/**
 * In the webview, to whatever listens: the view options of the diagram
 * shown, each time what is checked changes (the first model that has them,
 * a reader's click, the host). A product's client module binds an action
 * handler for {@link ViewOptionsChangedAction.KIND} and redraws; nothing
 * goes to the server.
 */
export namespace ViewOptionsChangedAction {
    export const KIND = 'dialogram.viewOptionsChanged';

    export interface Action {
        kind: typeof KIND;
        /** The file the view is of. */
        sourceUri: string;
        /** Every group, as it now stands. */
        groups: ViewOptionGroup[];
        /** The lines that turned; on the first model, every line. */
        changed: ViewOptionTurn[];
        /** Who turned them: the model that brought them, the reader, the host. */
        origin: 'load' | 'reader' | 'host';
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as { kind?: unknown }).kind === KIND
            && Array.isArray((action as { groups?: unknown }).groups);
    }

    export function create(options: Omit<Action, 'kind'>): Action {
        return { kind: KIND, ...options };
    }
}

const MAX_GROUPS = 64;
const MAX_ITEMS = 4096;
const MAX_TEXT = 200;

/** An id as the producer gave it, or `''` for none: never rewritten, since the producer looks its choices up by it. */
function idOf(value: unknown): string {
    return typeof value === 'string' && value.trim() !== '' ? value : '';
}

function text(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * Groups as a producer gave them, made safe to show: each with an id, a
 * label and items that have both, ids once each (the first is kept) and as
 * given, and a `one` group with exactly one line checked (its first line
 * declared checked, else its first not declared unchecked, else its first
 * line that can be). Anything else is dropped.
 */
export function normalizeViewOptionGroups(raw: unknown): ViewOptionGroup[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const groups: ViewOptionGroup[] = [];
    const groupIds = new Set<string>();
    for (const candidate of raw.slice(0, MAX_GROUPS)) {
        if (!candidate || typeof candidate !== 'object') {
            continue;
        }
        const id = idOf((candidate as ViewOptionGroup).id);
        const label = text((candidate as ViewOptionGroup).label) || text(id);
        if (id === '' || groupIds.has(id) || !Array.isArray((candidate as ViewOptionGroup).items)) {
            continue;
        }
        groupIds.add(id);
        const itemIds = new Set<string>();
        const items: ViewOptionItem[] = [];
        /** The first line declared `checked: true`, which a `one` group checks. */
        let declaredChecked: ViewOptionItem | undefined;
        for (const rawItem of (candidate as ViewOptionGroup).items.slice(0, MAX_ITEMS)) {
            if (!rawItem || typeof rawItem !== 'object') {
                continue;
            }
            const itemId = idOf(rawItem.id);
            if (itemId === '' || itemIds.has(itemId)) {
                continue;
            }
            itemIds.add(itemId);
            const item: ViewOptionItem = { id: itemId, label: text(rawItem.label) || text(itemId), checked: rawItem.checked !== false };
            if (rawItem.checked === true && !declaredChecked) {
                declaredChecked = item;
            }
            const color = text(rawItem.color);
            if (color !== '') {
                item.color = color;
            }
            const disabled = text(rawItem.disabled);
            if (disabled !== '') {
                item.disabled = disabled;
            }
            items.push(item);
        }
        const group: ViewOptionGroup = { id, label, items };
        const source = candidate as ViewOptionGroup;
        if (source.choice === 'one') {
            group.choice = 'one';
            settleOne(group, declaredChecked);
        }
        if (source.collapsed === true) {
            group.collapsed = true;
        }
        if (source.persist === false) {
            group.persist = false;
        }
        if (source.reload === true) {
            group.reload = true;
        }
        groups.push(group);
    }
    return groups;
}

/** A `one` group with exactly one line checked: `first` if given, else the first that is, else the first that can be. */
function settleOne(group: ViewOptionGroup, first?: ViewOptionItem): void {
    const chosen = first
        ?? group.items.find(item => item.checked !== false)
        ?? group.items.find(item => !item.disabled)
        ?? group.items[0];
    for (const item of group.items) {
        item.checked = item === chosen;
    }
}

/** Whether a line is checked: the reader's choice, else as declared. */
export function isViewOptionChecked(item: ViewOptionItem, groupId: string, state: ViewOptionsState | undefined): boolean {
    const chosen = state?.[groupId]?.[item.id];
    return typeof chosen === 'boolean' ? chosen : item.checked !== false;
}

/**
 * The groups with the reader's choices applied: what the palette shows. A
 * `one` group whose choice names no line it has keeps its declared one.
 */
export function applyViewOptionsState(groups: ViewOptionGroup[], state: ViewOptionsState | undefined): ViewOptionGroup[] {
    return groups.map(group => {
        const resolved: ViewOptionGroup = {
            ...group,
            items: group.items.map(item => ({ ...item, checked: isViewOptionChecked(item, group.id, state) }))
        };
        if (resolved.choice === 'one' && resolved.items.filter(item => item.checked).length !== 1) {
            // A choice of none, or of several: the one declared stands.
            resolved.items = group.items.map(item => ({ ...item }));
            settleOne(resolved);
        }
        return resolved;
    });
}

/**
 * What `change` turns in `groups` (as they stand, state applied): the lines
 * whose state it changes, none when it changes nothing or names nothing
 * there is. A disabled line is never checked, and is unchecked only in a
 * `one` group, which keeps exactly one line: checking a line there unchecks
 * the other, disabled or not; unchecking its only line and All and None do
 * nothing.
 */
export function turnsOf(groups: ViewOptionGroup[], change: ViewOptionChange): ViewOptionTurn[] {
    const group = groups.find(candidate => candidate.id === change.group);
    if (!group) {
        return [];
    }
    const want = new Map<string, boolean>();
    const one = group.choice === 'one';
    if ('item' in change) {
        const item = group.items.find(candidate => candidate.id === change.item);
        if (!item || item.disabled) {
            return [];
        }
        if (one) {
            if (!change.checked) {
                return [];
            }
            for (const other of group.items) {
                want.set(other.id, other === item);
            }
        } else {
            want.set(item.id, change.checked);
        }
    } else if ('all' in change) {
        if (one) {
            return [];
        }
        for (const item of group.items) {
            want.set(item.id, change.all);
        }
    } else if ('only' in change) {
        const target = group.items.find(candidate => candidate.id === change.only);
        if (!target || target.disabled) {
            return [];
        }
        for (const item of group.items) {
            want.set(item.id, item === target);
        }
    }
    const turns: ViewOptionTurn[] = [];
    for (const item of group.items) {
        const checked = want.get(item.id);
        // In a `one` group the line checked before is let go of even when
        // it is disabled: else two lines would be checked.
        const fixed = item.disabled && !(one && !checked);
        if (checked === undefined || fixed || (item.checked !== false) === checked) {
            continue;
        }
        turns.push({ group: group.id, item: item.id, checked });
    }
    return turns;
}

/** The groups after `turns`, as new objects; the input is left alone. */
export function applyViewOptionTurns(groups: ViewOptionGroup[], turns: ViewOptionTurn[]): ViewOptionGroup[] {
    if (turns.length === 0) {
        return groups;
    }
    const byGroup = new Map<string, Map<string, boolean>>();
    for (const turn of turns) {
        let items = byGroup.get(turn.group);
        if (!items) {
            items = new Map();
            byGroup.set(turn.group, items);
        }
        items.set(turn.item, turn.checked);
    }
    return groups.map(group => {
        const items = byGroup.get(group.id);
        if (!items) {
            return group;
        }
        return { ...group, items: group.items.map(item => (items.has(item.id) ? { ...item, checked: items.get(item.id) } : item)) };
    });
}

/** The lines whose state differs between two sets of groups (a line new in `after` counts as turned). */
export function viewOptionTurnsBetween(before: ViewOptionGroup[], after: ViewOptionGroup[]): ViewOptionTurn[] {
    const was = new Map<string, boolean>();
    for (const group of before) {
        for (const item of group.items) {
            was.set(`${group.id}\u0000${item.id}`, item.checked !== false);
        }
    }
    const turns: ViewOptionTurn[] = [];
    for (const group of after) {
        for (const item of group.items) {
            const checked = item.checked !== false;
            if (was.get(`${group.id}\u0000${item.id}`) !== checked) {
                turns.push({ group: group.id, item: item.id, checked });
            }
        }
    }
    return turns;
}

/** The state with `turns` recorded as the reader's choices. */
export function recordViewOptionTurns(state: ViewOptionsState, turns: ViewOptionTurn[]): ViewOptionsState {
    const next: ViewOptionsState = {};
    for (const [group, items] of Object.entries(state)) {
        next[group] = { ...items };
    }
    for (const turn of turns) {
        next[turn.group] = { ...(next[turn.group] ?? {}), [turn.item]: turn.checked };
    }
    return next;
}

/** A state read from a file or a message: groups of booleans, nothing else. */
export function normalizeViewOptionsState(raw: unknown): ViewOptionsState {
    const state: ViewOptionsState = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return state;
    }
    for (const [group, items] of Object.entries(raw as Record<string, unknown>)) {
        if (group === '' || !items || typeof items !== 'object' || Array.isArray(items)) {
            continue;
        }
        const kept: Record<string, boolean> = {};
        for (const [item, checked] of Object.entries(items as Record<string, unknown>)) {
            if (item !== '' && typeof checked === 'boolean') {
                kept[item] = checked;
            }
        }
        if (Object.keys(kept).length > 0) {
            state[group] = kept;
        }
    }
    return state;
}

/** Whether a value is a {@link ViewOptionChange}. */
export function isViewOptionChange(value: unknown): value is ViewOptionChange {
    if (!value || typeof value !== 'object' || typeof (value as { group?: unknown }).group !== 'string') {
        return false;
    }
    const change = value as Record<string, unknown>;
    return (typeof change.item === 'string' && typeof change.checked === 'boolean')
        || typeof change.all === 'boolean'
        || typeof change.only === 'string';
}

/**
 * Whether a line is checked, from a producer's side: `getGraph` is handed the
 * reader's choices and knows its own defaults.
 */
export function viewOptionChosen(state: ViewOptionsState | undefined, group: string, item: string, byDefault: boolean): boolean {
    const chosen = state?.[group]?.[item];
    return typeof chosen === 'boolean' ? chosen : byDefault;
}
