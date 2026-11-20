import {
    Action,
    Anchor,
    IContextMenuService,
    IActionDispatcher,
    TYPES
} from '@eclipse-glsp/client';
import { EditorContextService } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { offeredMenuItems } from './node-actions';
import { PostEditSelectionService } from './post-edit-selection-service';

type AnyMenuItem = {
    label?: string;
    group?: string;
    actions?: Action[];
    children?: AnyMenuItem[];
};

/**
 * The menu as it is drawn: items without a label are not drawn, but the
 * children of an unlabeled item take its place (a producer's grouping, as
 * before submenus were drawn); a labeled item with children is a submenu,
 * dropped when none of them is drawn and it does nothing itself.
 */
export function menuToShow<T extends AnyMenuItem>(items: readonly T[]): T[] {
    const out: T[] = [];
    for (const item of items) {
        const children = Array.isArray(item.children) && item.children.length > 0
            ? menuToShow(item.children as T[])
            : [];
        if ((item.label ?? '').trim() === '') {
            out.push(...children);
        } else if (children.length > 0) {
            out.push({ ...item, children });
        } else if (!Array.isArray(item.children) || item.children.length === 0 || (item.actions ?? []).length > 0) {
            out.push({ ...item, children: undefined });
        }
    }
    return out;
}

/** How long a submenu stays open after the pointer moves onto another item, so a diagonal path to it does not close it. */
const SUBMENU_CLOSE_DELAY_MS = 250;
const MENU_MARGIN_PX = 8;

function isContextMenuDebugEnabled(): boolean {
    try {
        return globalThis?.localStorage?.getItem('workflow.debugContextMenu') === '1';
    } catch {
        return false;
    }
}

function isMouseEvent(anchor: Anchor): anchor is MouseEvent {
    return typeof (anchor as MouseEvent).clientX === 'number' && typeof (anchor as MouseEvent).clientY === 'number';
}

function anchorPoint(anchor: Anchor): { x: number; y: number } {
    if (isMouseEvent(anchor)) {
        return { x: anchor.clientX, y: anchor.clientY };
    }
    const a = anchor as { x: number; y: number };
    return { x: a.x, y: a.y };
}

@injectable()
export class WorkflowContextMenuService implements IContextMenuService {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    @inject(PostEditSelectionService)
    protected readonly postEditSelection!: PostEditSelectionService;

    /** The menu and its open submenus, outermost first. */
    private menus: HTMLDivElement[] = [];
    /** The item each open submenu belongs to: `owners[i]` opened `menus[i]` (none for the menu itself). */
    private owners: Array<HTMLButtonElement | undefined> = [];
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private onHide?: () => void;
    private onDocMouseDown?: (e: MouseEvent) => void;
    private onDocKeyDown?: (e: KeyboardEvent) => void;

    show(items: AnyMenuItem[], anchor: Anchor, onHide?: () => void): void {
        const debug = isContextMenuDebugEnabled();
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] show called', { itemCount: items?.length ?? 0, anchor });
        }
        this.hide();

        const menuItems = menuToShow(offeredMenuItems(items));
        if (menuItems.length === 0) {
            if (debug) {
                // eslint-disable-next-line no-console
                console.log('[workflow][context-menu] no labeled items; not rendering');
            }
            return;
        }
        this.onHide = onHide;

        const div = this.buildMenu(menuItems, 0);
        // Attach first so width/height can be measured accurately.
        document.body.appendChild(div);
        const { x, y } = anchorPoint(anchor);
        placeMenu(div, x, y);
        this.menus = [div];
        this.owners = [undefined];
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] render at', { x, y, labels: menuItems.map(i => i.label) });
        }

        this.onDocMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (target && this.menus.some(menu => menu.contains(target))) {
                return;
            }
            this.dismiss();
        };
        this.onDocKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.dismiss();
            }
        };
        document.addEventListener('mousedown', this.onDocMouseDown, true);
        document.addEventListener('keydown', this.onDocKeyDown, true);

        // Focus so Escape works reliably.
        div.focus();
    }

    /** One menu: the items of a level, a separator before each group. */
    private buildMenu(items: AnyMenuItem[], depth: number): HTMLDivElement {
        const div = document.createElement('div');
        div.className = depth === 0 ? 'workflow-context-menu' : 'workflow-context-menu workflow-context-menu-sub';
        div.setAttribute('role', 'menu');
        div.tabIndex = -1;
        div.addEventListener('mouseenter', () => this.cancelClose());
        div.addEventListener('keydown', event => this.onMenuKey(event, div, depth));

        let previousGroup: string | undefined;
        for (const item of items) {
            const group = typeof item.group === 'string' && item.group.trim() !== ''
                ? item.group
                : undefined;
            // A group starts under a separator: after another group, and
            // after the ungrouped items at the top of the menu.
            if (group && previousGroup !== group && div.childElementCount > 0) {
                const separator = document.createElement('div');
                separator.className = 'workflow-context-menu-separator';
                separator.setAttribute('role', 'separator');
                separator.setAttribute('aria-hidden', 'true');
                div.appendChild(separator);
            }
            div.appendChild(item.children ? this.submenuItem(item, item.children, depth) : this.actionItem(item, depth));
            if (group) {
                previousGroup = group;
            }
        }
        return div;
    }

    private actionItem(item: AnyMenuItem, depth: number): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'workflow-context-menu-item';
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.textContent = item.label ?? '';
        // Onto another item of this menu: its open submenu closes, after a
        // moment in case the pointer is on its way there.
        button.addEventListener('mouseenter', () => this.closeLater(depth + 1));
        button.addEventListener('click', async () => {
            const actions = item.actions ?? [];
            for (const action of actions) {
                const kind = (action as any)?.kind as string | undefined;
                if (kind === 'dialogram.duplicate') {
                    const elementIds = ((action as any)?.elementIds ?? []) as string[];
                    this.postEditSelection.prepareForDuplicate(elementIds, (this.editorContext as any).modelRoot);
                }
                await this.actionDispatcher.dispatch(action);
            }
            this.dismiss();
        });
        return button;
    }

    private submenuItem(item: AnyMenuItem, children: AnyMenuItem[], depth: number): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'workflow-context-menu-item has-children';
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const label = document.createElement('span');
        label.className = 'workflow-context-menu-label';
        label.textContent = item.label ?? '';
        const chevron = document.createElement('span');
        chevron.className = 'workflow-context-menu-chevron codicon codicon-chevron-right';
        chevron.setAttribute('aria-hidden', 'true');
        button.append(label, chevron);
        button.addEventListener('mouseenter', () => this.openSubmenu(button, children, depth + 1, false));
        button.addEventListener('click', () => this.openSubmenu(button, children, depth + 1, true));
        button.addEventListener('keydown', event => {
            if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.openSubmenu(button, children, depth + 1, true);
            }
        });
        return button;
    }

    /** Open `children` beside `owner`, at `depth`, closing what was open there; with `focus`, its first item takes the keyboard. */
    private openSubmenu(owner: HTMLButtonElement, children: AnyMenuItem[], depth: number, focus: boolean): void {
        this.cancelClose();
        if (this.owners[depth] !== owner) {
            this.closeFrom(depth);
            const sub = this.buildMenu(children, depth);
            document.body.appendChild(sub);
            placeSubmenu(sub, owner, this.menus[depth - 1]);
            this.menus[depth] = sub;
            this.owners[depth] = owner;
            owner.setAttribute('aria-expanded', 'true');
            owner.classList.add('open');
        }
        if (focus) {
            this.menus[depth]?.querySelector<HTMLButtonElement>('button')?.focus();
        }
    }

    /** Up and down move between a menu's items; left closes a submenu, back to its item. */
    private onMenuKey(event: KeyboardEvent, menu: HTMLDivElement, depth: number): void {
        const buttons = [...menu.children].filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement);
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(at + step + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'ArrowLeft' && depth > 0) {
            event.preventDefault();
            const owner = this.owners[depth];
            this.closeFrom(depth);
            owner?.focus();
        }
    }

    private closeLater(depth: number): void {
        if (this.menus.length <= depth) {
            return;
        }
        this.cancelClose();
        this.closeTimer = setTimeout(() => {
            this.closeTimer = undefined;
            this.closeFrom(depth);
        }, SUBMENU_CLOSE_DELAY_MS);
    }

    private cancelClose(): void {
        if (this.closeTimer !== undefined) {
            clearTimeout(this.closeTimer);
            this.closeTimer = undefined;
        }
    }

    /** Close the submenus at `depth` and deeper (0: everything). */
    private closeFrom(depth: number): void {
        for (let index = this.menus.length - 1; index >= depth; index--) {
            this.menus[index].remove();
            const owner = this.owners[index];
            owner?.setAttribute('aria-expanded', 'false');
            owner?.classList.remove('open');
        }
        this.menus.length = Math.min(this.menus.length, depth);
        this.owners.length = Math.min(this.owners.length, depth);
    }

    /** Closed by the reader: a choice, Escape or a click elsewhere. */
    private dismiss(): void {
        const onHide = this.onHide;
        this.hide();
        onHide?.();
    }

    private hide(): void {
        const debug = isContextMenuDebugEnabled();
        if (debug && this.menus.length > 0) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] hide');
        }
        this.cancelClose();
        this.closeFrom(0);
        this.onHide = undefined;
        if (this.onDocMouseDown) {
            document.removeEventListener('mousedown', this.onDocMouseDown, true);
            this.onDocMouseDown = undefined;
        }
        if (this.onDocKeyDown) {
            document.removeEventListener('keydown', this.onDocKeyDown, true);
            this.onDocKeyDown = undefined;
        }
    }
}

/** Put a menu at `x`, `y`, kept inside the window. */
function placeMenu(menu: HTMLElement, x: number, y: number): void {
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(MENU_MARGIN_PX, Math.min(x, Math.max(MENU_MARGIN_PX, window.innerWidth - width - MENU_MARGIN_PX)));
    const top = Math.max(MENU_MARGIN_PX, Math.min(y, Math.max(MENU_MARGIN_PX, window.innerHeight - height - MENU_MARGIN_PX)));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

/**
 * Put a submenu beside the item that opened it: on the right of its menu,
 * on the left when the window has no room there, its first item level with
 * the item.
 */
function placeSubmenu(sub: HTMLElement, owner: HTMLElement, parent: HTMLElement | undefined): void {
    const item = owner.getBoundingClientRect();
    const beside = parent?.getBoundingClientRect() ?? item;
    const width = sub.offsetWidth;
    const padding = parseFloat(getComputedStyle(sub).paddingTop) || 0;
    const right = beside.right - 2;
    const x = right + width + MENU_MARGIN_PX > window.innerWidth ? beside.left - width + 2 : right;
    placeMenu(sub, x, item.top - padding);
}
