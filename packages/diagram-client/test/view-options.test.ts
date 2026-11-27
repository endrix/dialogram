// @vitest-environment happy-dom
/**
 * The view options in the webview: the groups a model declares, drawn under
 * the palette's tools in the palette's own markup, a reader's click in force
 * at once for a product's renderer, and the host's changes followed.
 *
 * Also what the palette says when it has nothing to show: GLSP's "No results
 * found." belongs to a filter that matched nothing, not to a product that
 * creates nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applyViewOptionsState,
    applyViewOptionTurns,
    normalizeViewOptionGroups,
    turnsOf,
    VIEW_OPTIONS_ARG,
    VIEW_OPTIONS_CHANGED_MESSAGE,
    VIEW_OPTIONS_TURNED_MESSAGE,
    ViewOptionsChangedAction,
    viewOptionTurnsBetween,
    type ViewOptionGroup
} from '@dialogram/shared';
import { keepShownState, sameSource, ViewOptionsService } from '../src/view-options';
import { checkedSummary, drawViewOptionGroups, linesMatching, swatchColor, ViewOptionsCollapse } from '../src/view-options-palette';
import { EMPTY_PALETTE_BODY_CLASS, ViewToolPalette } from '../src/view-tool-palette';

const FILE = 'file:///w/top.sv';
const thirty = Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, label: `Kind ${i}`, color: `hsl(${i * 12}, 60%, 50%)` }));
const kinds: ViewOptionGroup = { id: 'kinds', label: 'Kinds', items: [...thirty, { id: 'off', label: 'Hidden kind', disabled: 'Not drawn at this zoom' }] };
const detail: ViewOptionGroup = { id: 'detail', label: 'Detail', choice: 'one', items: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', checked: false }] };

const rootOf = (groups: ViewOptionGroup[] | undefined, sourceUri = FILE): unknown => ({
    id: 'root',
    args: { sourceUri, ...(groups ? { [VIEW_OPTIONS_ARG]: JSON.stringify(groups) } : {}) }
});

const states = (groups: ViewOptionGroup[], group: string): Record<string, boolean> =>
    Object.fromEntries(groups.find(g => g.id === group)!.items.map(item => [item.id, item.checked !== false]));

class TestService extends ViewOptionsService {
    readonly sent: any[] = [];
    readonly dispatched: any[] = [];
    constructor() {
        super();
        (this as any).dispatcher = { dispatch: (action: unknown) => { this.dispatched.push(action); return Promise.resolve(); } };
    }
    protected override postToHost(message: unknown): void {
        this.sent.push(message);
    }
}

describe('the groups a producer declares', () => {
    it('are made safe: ids once each, labels, one line of a one-of group checked', () => {
        const groups = normalizeViewOptionGroups([
            { id: 'g', label: '  Spaced   label ', items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'again' }, { id: '', label: 'no id' }, { id: 'b' }] },
            { id: 'g', label: 'twice', items: [] },
            { id: 'one', label: 'One', choice: 'one', items: [{ id: 'x', label: 'X', checked: false }, { id: 'y', label: 'Y', checked: false }] },
            { label: 'no id', items: [] },
            'junk'
        ]);
        expect(groups.map(g => g.id)).toEqual(['g', 'one']);
        expect(groups[0].label).toBe('Spaced label');
        expect(groups[0].items.map(i => [i.id, i.label])).toEqual([['a', 'A'], ['b', 'b']]);
        expect(states(groups, 'one')).toEqual({ x: true, y: false });
    });

    it('keep ids exactly as given, so that a producer finds its choices under them', () => {
        const long = 'x'.repeat(250);
        const groups = normalizeViewOptionGroups([
            { id: ' a  b ', label: 'Spaced', items: [{ id: ` ${long}1`, label: 'One' }, { id: ` ${long}2`, label: 'Two' }, { id: '   ', label: 'blank' }, { id: 7, label: 'number' }] }
        ]);
        expect(groups[0].id).toBe(' a  b ');
        expect(groups[0].items.map(item => item.id)).toEqual([` ${long}1`, ` ${long}2`]);
    });

    it('check the line of a one-of group declared checked, wherever it is', () => {
        const [lod] = normalizeViewOptionGroups([{ id: 'lod', label: 'Detail', choice: 'one', items: [{ id: 'coarse', label: 'Coarse' }, { id: 'fine', label: 'Fine', checked: true }] }]);
        expect(states([lod], 'lod')).toEqual({ coarse: false, fine: true });
    });

    it('show the reader’s choices over the declared state', () => {
        expect(states(applyViewOptionsState([kinds], { kinds: { k0: false } }), 'kinds').k0).toBe(false);
        // A one-of choice naming two lines is no choice: the declared one stands.
        expect(states(applyViewOptionsState([detail], { detail: { low: true, high: true } }), 'detail')).toEqual({ low: true, high: false });
    });
});

describe('all, none and only', () => {
    it('turn every line, no line, or one line alone, passing a disabled line by', () => {
        const none = turnsOf([kinds], { group: 'kinds', all: false });
        expect(none).toHaveLength(30);
        expect(none.every(turn => !turn.checked && turn.item !== 'off')).toBe(true);
        const after = applyViewOptionTurns([kinds], none);
        expect(turnsOf(after, { group: 'kinds', all: true })).toHaveLength(30);
        const only = turnsOf([kinds], { group: 'kinds', only: 'k3' });
        expect(only.map(turn => turn.item)).toEqual(thirty.filter(item => item.id !== 'k3').map(item => item.id));
        expect(turnsOf([kinds], { group: 'kinds', only: 'off' })).toEqual([]);
        expect(turnsOf([kinds], { group: 'kinds', item: 'off', checked: false })).toEqual([]);
    });

    it('let go of a one-of group’s disabled line when another is picked: one line stays checked', () => {
        const lod: ViewOptionGroup = {
            id: 'lod', label: 'Detail', choice: 'one',
            items: [{ id: 'coarse', label: 'Coarse', disabled: 'Not drawn at this zoom' }, { id: 'fine', label: 'Fine', checked: false }]
        };
        const turns = turnsOf(normalizeViewOptionGroups([lod]), { group: 'lod', item: 'fine', checked: true });
        expect(turns).toEqual([{ group: 'lod', item: 'coarse', checked: false }, { group: 'lod', item: 'fine', checked: true }]);
        // It is still never checked by a change.
        expect(turnsOf(applyViewOptionTurns(normalizeViewOptionGroups([lod]), turns), { group: 'lod', item: 'coarse', checked: true })).toEqual([]);
    });

    it('keep exactly one line of a one-of group', () => {
        expect(turnsOf([detail], { group: 'detail', item: 'high', checked: true })).toEqual([
            { group: 'detail', item: 'low', checked: false },
            { group: 'detail', item: 'high', checked: true }
        ]);
        expect(turnsOf([detail], { group: 'detail', item: 'low', checked: false })).toEqual([]);
        expect(turnsOf([detail], { group: 'detail', all: true })).toEqual([]);
    });
});

describe('the webview’s copy', () => {
    it('tells a product’s client modules of every line on the first model', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds, detail]));

        expect(service.dispatched).toHaveLength(1);
        const action = service.dispatched[0];
        expect(ViewOptionsChangedAction.is(action)).toBe(true);
        expect(action.origin).toBe('load');
        expect(action.changed).toHaveLength(33);
        expect(service.sent).toEqual([]);
    });

    it('puts a reader’s click in force before the host hears of it', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        const order: string[] = [];
        (service as any).dispatcher.dispatch = () => { order.push('client'); return Promise.resolve(); };
        (service as any).postToHost = (message: unknown) => { order.push('host'); service.sent.push(message); };

        service.change({ group: 'kinds', item: 'k1', checked: false });

        expect(order).toEqual(['client', 'host']);
        expect(service.isChecked('kinds', 'k1')).toBe(false);
        expect(service.sent).toEqual([{ type: VIEW_OPTIONS_CHANGED_MESSAGE, payload: { sourceUri: FILE, changes: [{ group: 'kinds', item: 'k1', checked: false }] } }]);
    });

    it('sends nothing for a click that turns nothing', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.change({ group: 'kinds', item: 'off', checked: false });
        service.change({ group: 'kinds', item: 'k1', checked: true });
        expect(service.sent).toEqual([]);
        expect(service.dispatched).toHaveLength(1);
    });

    it('follows the lines the host turned, for its own file only, from the window’s messages', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: 'file:///w/other.sv', turns: [{ group: 'kinds', item: 'k2', checked: false }] } }
        }));
        expect(service.isChecked('kinds', 'k2')).toBe(true);
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: FILE, turns: [{ group: 'kinds', item: 'k2', checked: false }] } }
        }));
        expect(service.isChecked('kinds', 'k2')).toBe(false);
        expect(service.dispatched.at(-1).origin).toBe('host');
        expect(service.dispatched.at(-1).changed).toEqual([{ group: 'kinds', item: 'k2', checked: false }]);
    });

    it('keeps what it shows over a model of the same file made before the last click, and takes a new line from it', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.change({ group: 'kinds', item: 'k1', checked: false });
        const stale = { ...kinds, items: [...kinds.items, { id: 'new', label: 'New', checked: false }] };

        service.modelRootChanged(rootOf([stale]));

        expect(service.isChecked('kinds', 'k1')).toBe(false);
        expect(service.isChecked('kinds', 'new')).toBe(false);
    });

    it('hears the host from the start: a line turned while the first model was laid out is applied over it', () => {
        const service = new TestService();
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: FILE, turns: [{ group: 'kinds', item: 'k2', checked: false }] } }
        }));
        // The model was made before the host turned it.
        service.modelRootChanged(rootOf([kinds]));
        expect(service.isChecked('kinds', 'k2')).toBe(false);
        expect(service.dispatched[0].changed).toContainEqual({ group: 'kinds', item: 'k2', checked: false });
    });

    it('agrees with a later model that carries the host’s state', () => {
        const service = new TestService();
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: FILE, turns: [{ group: 'kinds', item: 'k2', checked: false }] } }
        }));
        service.modelRootChanged(rootOf([kinds]));
        const held = { ...kinds, items: kinds.items.map(item => (item.id === 'k2' ? { ...item, checked: false } : item)) };
        service.modelRootChanged(rootOf([held]));
        expect(service.isChecked('kinds', 'k2')).toBe(false);
    });

    it('keeps a line the host turned that the view shown does not have, for the model that has it', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.hostTurned(FILE, [{ group: 'detail', item: 'high', checked: true }, { group: 'detail', item: 'low', checked: false }]);
        // A view of the file that declares the group, made before the host turned it.
        service.modelRootChanged(rootOf([kinds, detail]));
        expect(service.isChecked('detail', 'high')).toBe(true);
        expect(service.isChecked('detail', 'low')).toBe(false);
    });

    it('keeps one line of a one-of group checked when a host pick races the reader’s click', () => {
        const service = new TestService();
        const lod: ViewOptionGroup = {
            id: 'lod', label: 'Detail', choice: 'one',
            items: [{ id: 'low', label: 'Low' }, { id: 'mid', label: 'Mid', checked: false }, { id: 'high', label: 'High', checked: false }]
        };
        service.modelRootChanged(rootOf([lod]));
        service.change({ group: 'lod', item: 'high', checked: true });
        // The host picked another line before the click reached it.
        service.hostTurned(FILE, [{ group: 'lod', item: 'low', checked: false }, { group: 'lod', item: 'mid', checked: true }]);
        expect(states(service.groups, 'lod')).toEqual({ low: false, mid: false, high: true });
        // Then the click, as the host made it after its own pick.
        service.hostTurned(FILE, [{ group: 'lod', item: 'mid', checked: false }, { group: 'lod', item: 'high', checked: true }]);
        expect(states(service.groups, 'lod')).toEqual({ low: false, mid: false, high: true });
        // The product was never told of two lines checked.
        for (const action of service.dispatched) {
            expect(action.groups[0].items.filter((item: { checked?: boolean }) => item.checked !== false)).toHaveLength(1);
        }
        // A host pick on what the diagram shows is followed.
        service.hostTurned(FILE, [{ group: 'lod', item: 'high', checked: false }, { group: 'lod', item: 'low', checked: true }]);
        expect(states(service.groups, 'lod')).toEqual({ low: true, mid: false, high: false });
    });

    it('takes the host’s answer to its own click without telling the product again', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.change({ group: 'kinds', item: 'k1', checked: false });
        const told = service.dispatched.length;
        service.hostTurned(FILE, [{ group: 'kinds', item: 'k1', checked: false }]);
        expect(service.dispatched).toHaveLength(told);
        expect(service.sent).toHaveLength(1);
    });

    it('takes a model of another file whole', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.change({ group: 'kinds', item: 'k1', checked: false });
        service.modelRootChanged(rootOf([kinds], 'file:///w/other.sv'));
        expect(service.isChecked('kinds', 'k1')).toBe(true);
        expect(service.sourceUri).toBe('file:///w/other.sv');
    });

    it('drops the groups of a model that has none', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        service.modelRootChanged(rootOf(undefined, 'file:///w/plain.sv'));
        expect(service.groups).toEqual([]);
    });

    it('compares files by what they name', () => {
        expect(sameSource('file:///w/a%20b.sv', 'file:///w/a b.sv')).toBe(true);
        expect(sameSource('file:///w/a.sv', 'file:///w/b.sv')).toBe(false);
        expect(keepShownState([detail], [{ ...detail, items: [{ id: 'low', label: 'Low', checked: false }, { id: 'high', label: 'High', checked: true }] }]))
            .toEqual([{ ...detail, items: [{ id: 'low', label: 'Low', checked: false }, { id: 'high', label: 'High', checked: true }] }]);
        expect(viewOptionTurnsBetween([], [detail])).toHaveLength(2);
    });
});

describe('the drawing', () => {
    const drawing = (overrides: Partial<Parameters<typeof drawViewOptionGroups>[1]> = {}) => ({
        filter: '',
        isCollapsed: () => false,
        onCollapse: vi.fn(),
        onChange: vi.fn(),
        ...overrides
    });

    it('is the palette’s markup: a heading with its count and All and None, a line with a box, a swatch and Only', () => {
        const [group] = drawViewOptionGroups([kinds], drawing());
        expect(group.classList.contains('tool-group')).toBe(true);
        const header = group.querySelector('.group-header')!;
        expect(header.textContent).toContain('Kinds');
        expect(header.querySelector('.view-options-count')!.textContent).toBe('31 of 31');
        expect(header.querySelector('.codicon-check-all')).not.toBeNull();
        expect(header.querySelector('.codicon-close-all')).not.toBeNull();
        const lines = group.querySelectorAll<HTMLElement>('.tool-button.view-option');
        expect(lines).toHaveLength(31);
        expect(lines[0].getAttribute('role')).toBe('checkbox');
        expect(lines[0].getAttribute('aria-checked')).toBe('true');
        expect(lines[0].querySelector<HTMLElement>('.view-option-swatch')!.style.background).toContain('hsl');
        expect(lines[0].querySelector('.view-option-only')).not.toBeNull();
        const off = lines[30];
        expect(off.classList.contains('disabled')).toBe(true);
        expect(off.title).toBe('Not drawn at this zoom');
        expect(off.querySelector('.view-option-only')).toBeNull();
        // It reads as a line that cannot change, not as one unchecked.
        expect(off.querySelector('.view-option-locked.codicon-circle-slash')).not.toBeNull();
        expect(off.getAttribute('aria-disabled')).toBe('true');
        // The lines scroll under the heading.
        expect(lines[0].parentElement!.classList.contains('view-options-lines')).toBe(true);
    });

    it('turns a line on a click, alone on Alt+click or Only, and every line on All and None', () => {
        const onChange = vi.fn();
        const [group] = drawViewOptionGroups([kinds], drawing({ onChange }));
        const line = group.querySelector<HTMLElement>('[data-item="k4"]')!;
        line.click();
        line.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
        line.querySelector<HTMLElement>('.view-option-only')!.click();
        group.querySelector<HTMLElement>('.view-options-all')!.click();
        group.querySelector<HTMLElement>('.view-options-none')!.click();
        group.querySelector<HTMLElement>('[data-item="off"]')!.click();
        expect(onChange.mock.calls.map(call => call[0])).toEqual([
            { group: 'kinds', item: 'k4', checked: false },
            { group: 'kinds', only: 'k4' },
            { group: 'kinds', only: 'k4' },
            { group: 'kinds', all: true },
            { group: 'kinds', all: false }
        ]);
    });

    it('draws a one-of group as radio buttons, with no All, None or Only', () => {
        const [group] = drawViewOptionGroups([detail], drawing());
        expect(group.getAttribute('role')).toBe('radiogroup');
        expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
        expect(group.querySelector('.view-options-all, .view-options-only, .view-options-count')).toBeNull();
        expect(checkedSummary(detail)).toBe('');
    });

    it('opens and closes a group on its heading, and remembers it for the product', () => {
        const store = new Map<string, string>();
        const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
        const collapse = new ViewOptionsCollapse(storage);
        const onCollapse = vi.fn((group: ViewOptionGroup, closed: boolean) => collapse.set(group, closed));
        const [group] = drawViewOptionGroups([kinds], drawing({ isCollapsed: g => collapse.isCollapsed(g), onCollapse }));
        group.querySelector<HTMLElement>('.group-header')!.click();
        expect(onCollapse).toHaveBeenCalledWith(kinds, true);
        expect(new ViewOptionsCollapse(storage).isCollapsed(kinds)).toBe(true);
        const [closed] = drawViewOptionGroups([kinds], drawing({ isCollapsed: () => true }));
        expect(closed.querySelectorAll('.view-option')).toHaveLength(0);
        expect(new ViewOptionsCollapse(undefined).isCollapsed({ ...detail, collapsed: true })).toBe(true);
    });

    it('filters by the palette’s filter, a group’s own name keeping all of it, and opens what it found', () => {
        expect(linesMatching(kinds, 'kind 1').map(item => item.id)).toEqual(['k1', 'k10', 'k11', 'k12', 'k13', 'k14', 'k15', 'k16', 'k17', 'k18', 'k19']);
        expect(linesMatching(kinds, 'KINDS')).toHaveLength(31);
        expect(drawViewOptionGroups([kinds, detail], drawing({ filter: 'zzz' }))).toEqual([]);
        const [found] = drawViewOptionGroups([kinds], drawing({ filter: 'kind 29', isCollapsed: () => true }));
        expect(found.querySelectorAll('.view-option')).toHaveLength(1);
    });

    it('paints a swatch only with a colour', () => {
        expect(swatchColor('#a0b1c2')).toBe('#a0b1c2');
        expect(swatchColor('var(--vscode-charts-red)')).toBe('var(--vscode-charts-red)');
        expect(swatchColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
        expect(swatchColor('red; background: url(x)')).toBeUndefined();
        expect(swatchColor('url(https://x)')).toBeUndefined();
    });
});

describe('the palette', () => {
    let container: HTMLElement;
    let search: HTMLInputElement;

    beforeEach(() => {
        document.body.replaceChildren();
        container = document.createElement('div');
        search = document.createElement('input');
        document.body.appendChild(container);
    });

    function palette(service: ViewOptionsService | undefined, tools: unknown[]): any {
        container.replaceChildren();
        const made: any = new ViewToolPalette();
        made.viewOptions = service;
        made.paletteItems = tools;
        made.containerElement = container;
        made.searchField = search;
        made.createBody();
        return made;
    }
    const body = (): HTMLElement => container.querySelector('.palette-body')!;
    const tools = [{ label: 'Nodes', children: [{ label: 'Add a node' }] }];

    it('draws the groups under its tools', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds, detail]));
        palette(service, tools);
        const children = Array.from(body().children);
        expect(children[0].textContent).toBe('Add a node');
        expect(children[1].classList.contains('view-options')).toBe(true);
        expect(children[1].querySelectorAll('.view-options-group')).toHaveLength(2);
    });

    it('redraws them as they change, from a click or the host', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        palette(service, tools);
        body().querySelector<HTMLElement>('[data-item="k0"]')!.click();
        expect(body().querySelector('[data-item="k0"]')!.getAttribute('aria-checked')).toBe('false');
        expect(body().querySelector('.view-options-count')!.textContent).toBe('30 of 31');
        service.hostTurned(FILE, [{ group: 'kinds', item: 'k0', checked: true }]);
        expect(body().querySelector('[data-item="k0"]')!.getAttribute('aria-checked')).toBe('true');
    });

    it('keeps a long group’s scroll and the focused line when it redraws', () => {
        // happy-dom lays nothing out: an element scrolls as far as it is told.
        const scrolled = new WeakMap<Element, number>();
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        Object.defineProperty(Element.prototype, 'scrollTop', {
            configurable: true,
            get(this: Element) { return scrolled.get(this) ?? 0; },
            set(this: Element, value: number) { scrolled.set(this, value); }
        });
        try {
            const service = new TestService();
            service.modelRootChanged(rootOf([kinds]));
            palette(service, tools);
            body().querySelector<HTMLElement>('.view-options-lines')!.scrollTop = 140;
            const line = body().querySelector<HTMLElement>('[data-item="k20"]')!;
            line.focus();
            line.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
            const redrawn = body().querySelector<HTMLElement>('[data-item="k20"]')!;
            expect(redrawn).not.toBe(line);
            expect(redrawn.getAttribute('aria-checked')).toBe('false');
            expect(body().querySelector<HTMLElement>('.view-options-lines')!.scrollTop).toBe(140);
            expect(document.activeElement).toBe(redrawn);
            // And again: Space works on the line it left focused.
            (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
            expect(body().querySelector('[data-item="k20"]')!.getAttribute('aria-checked')).toBe('true');
        } finally {
            if (descriptor) {
                Object.defineProperty(Element.prototype, 'scrollTop', descriptor);
            }
        }
    });

    it('does not say "No results found." for a product with no tools and view options', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        palette(service, []);
        expect(body().textContent).not.toContain('No results found.');
        expect(body().classList.contains(EMPTY_PALETTE_BODY_CLASS)).toBe(false);
    });

    it('does not say it, nor draw an empty body, for a product with neither', () => {
        palette(new TestService(), []);
        expect(body().textContent).not.toContain('No results found.');
        expect(body().classList.contains(EMPTY_PALETTE_BODY_CLASS)).toBe(true);
        palette(undefined, []);
        expect(body().textContent).not.toContain('No results found.');
    });

    it('says it when a filter matched neither a tool nor a line', () => {
        const service = new TestService();
        service.modelRootChanged(rootOf([kinds]));
        search.value = 'zzz';
        palette(service, []);
        expect(body().textContent).toBe('No results found.');
        search.value = 'kind 7';
        palette(service, []);
        expect(body().textContent).not.toContain('No results found.');
        expect(body().querySelectorAll('.view-option')).toHaveLength(1);
    });

    it('draws a body as shown, and finds something, when the product draws in it itself', () => {
        class OwnPalette extends ViewToolPalette {
            protected override drawsOwnContent(): boolean {
                return true;
            }
        }
        container.replaceChildren();
        const made: any = new OwnPalette();
        made.viewOptions = new TestService();
        made.paletteItems = [];
        made.containerElement = container;
        made.searchField = search;
        made.createBody();
        expect(body().classList.contains(EMPTY_PALETTE_BODY_CLASS)).toBe(false);
        search.value = 'zzz';
        made.drawViewOptions();
        expect(body().textContent).not.toContain('No results found.');
        expect(body().classList.contains(EMPTY_PALETTE_BODY_CLASS)).toBe(false);
    });

    it('leaves a palette with tools and no view options as it was', () => {
        palette(new TestService(), tools);
        expect(body().querySelector('.view-options')!.childElementCount).toBe(0);
        expect(body().classList.contains(EMPTY_PALETTE_BODY_CLASS)).toBe(false);
        expect(body().textContent).toBe('Add a node');
    });
});
