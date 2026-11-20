// @vitest-environment happy-dom
/**
 * The context menu draws a submenu ("Layout") as one item with a chevron:
 * its items open beside it on hover, click or the right arrow, a choice runs
 * and closes everything, and moving onto another item closes it after a
 * moment, so a diagonal path to it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowContextMenuService, menuToShow } from '../src/context-menu-service';

const layoutMenu = () => [
    { id: 'goto', label: 'Go to Source', actions: [{ kind: 'navigate' }] },
    {
        id: 'dialogram.layout',
        label: 'Layout',
        group: 'layout',
        children: [
            { id: 'default', label: 'Default Layout', actions: [{ kind: 'layout.default' }] },
            { id: 'compact', label: 'Compact Layout', actions: [{ kind: 'layout.compact' }] }
        ]
    }
];

let dispatched: string[];
let hidden: number;
/** Every menu a test made, closed after it: an open one still hears Escape and clicks. */
const made: WorkflowContextMenuService[] = [];

function service(): WorkflowContextMenuService {
    const menu = new WorkflowContextMenuService() as any;
    menu.actionDispatcher = { dispatch: async (action: { kind: string }) => { dispatched.push(action.kind); } };
    menu.editorContext = {};
    menu.postEditSelection = { prepareForDuplicate: () => undefined };
    made.push(menu);
    return menu;
}

const menus = () => [...document.querySelectorAll<HTMLElement>('.workflow-context-menu')];
const itemsOf = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>(':scope > button')].map(b => b.textContent);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.workflow-context-menu-item')]
    .find(b => b.textContent === label)!;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    document.body.replaceChildren();
    dispatched = [];
    hidden = 0;
});

afterEach(() => {
    vi.useRealTimers();
    for (const menu of made.splice(0)) {
        (menu as any).hide();
    }
});

describe('a submenu', () => {
    it('is one item with a chevron, its items not drawn until it opens', () => {
        service().show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);

        expect(menus()).toHaveLength(1);
        expect(itemsOf(menus()[0])).toEqual(['Go to Source', 'Layout']);
        const layout = button('Layout');
        expect(layout.getAttribute('aria-haspopup')).toBe('menu');
        expect(layout.getAttribute('aria-expanded')).toBe('false');
        expect(layout.querySelector('.codicon-chevron-right')).not.toBeNull();
    });

    it('opens beside its item on hover, and a choice runs it and closes everything', async () => {
        service().show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);
        button('Layout').dispatchEvent(new MouseEvent('mouseenter'));

        expect(menus()).toHaveLength(2);
        expect(menus()[1].classList.contains('workflow-context-menu-sub')).toBe(true);
        expect(itemsOf(menus()[1])).toEqual(['Default Layout', 'Compact Layout']);
        expect(button('Layout').getAttribute('aria-expanded')).toBe('true');

        button('Compact Layout').click();
        await settle();
        expect(dispatched).toEqual(['layout.compact']);
        expect(menus()).toHaveLength(0);
        expect(hidden).toBe(1);
    });

    it('opens on the right arrow with its first item focused, and the left arrow goes back', () => {
        service().show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);
        const layout = button('Layout');
        layout.focus();
        layout.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

        expect(document.activeElement).toBe(button('Default Layout'));
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(menus()).toHaveLength(1);
        expect(document.activeElement).toBe(layout);
    });

    it('closes a moment after the pointer moves onto another item, unless it reaches the submenu', () => {
        vi.useFakeTimers();
        service().show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);
        button('Layout').dispatchEvent(new MouseEvent('mouseenter'));

        button('Go to Source').dispatchEvent(new MouseEvent('mouseenter'));
        menus()[1].dispatchEvent(new MouseEvent('mouseenter'));
        vi.advanceTimersByTime(1000);
        expect(menus()).toHaveLength(2);

        button('Go to Source').dispatchEvent(new MouseEvent('mouseenter'));
        vi.advanceTimersByTime(1000);
        expect(menus()).toHaveLength(1);
    });

    it('closes with everything on Escape or a click elsewhere', () => {
        const menu = service();
        menu.show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);
        button('Layout').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(menus()).toHaveLength(0);

        menu.show(layoutMenu() as any, { x: 10, y: 10 }, () => hidden++);
        button('Layout').click();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(menus()).toHaveLength(0);
        expect(hidden).toBe(2);
    });
});

describe('the menu drawn', () => {
    it('puts an unlabeled item\'s children in its place and drops a submenu with nothing in it', () => {
        const shown = menuToShow([
            { label: '', children: [{ label: 'Delete', actions: [{ kind: 'delete' }] }] },
            { label: 'Empty', children: [{ label: '  ' }] },
            { label: 'Layout', children: [{ label: 'Default Layout', actions: [{ kind: 'x' }] }] },
            { label: 'Rename', actions: [{ kind: 'rename' }] }
        ] as any);

        expect(shown.map(item => [item.label, item.children?.map(child => child.label)])).toEqual([
            ['Delete', undefined],
            ['Layout', ['Default Layout']],
            ['Rename', undefined]
        ]);
    });
});
