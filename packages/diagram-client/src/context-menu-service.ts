import {
    Action,
    Anchor,
    IContextMenuService,
    IActionDispatcher,
    TYPES
} from '@eclipse-glsp/client';
import { EditorContextService } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { PostEditSelectionService } from './post-edit-selection-service';

type AnyMenuItem = {
    label?: string;
    group?: string;
    actions?: Action[];
    children?: AnyMenuItem[];
};

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

    private container?: HTMLDivElement;
    private onDocMouseDown?: (e: MouseEvent) => void;
    private onDocKeyDown?: (e: KeyboardEvent) => void;

    show(items: AnyMenuItem[], anchor: Anchor, onHide?: () => void): void {
        const debug = isContextMenuDebugEnabled();
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] show called', { itemCount: items?.length ?? 0, anchor });
        }
        this.hide();

        const menuItems = this.flatten(items).filter(i => (i.label ?? '').trim().length > 0);
        if (menuItems.length === 0) {
            if (debug) {
                // eslint-disable-next-line no-console
                    console.log('[workflow][context-menu] no labeled items after flatten/filter; not rendering');
            }
            return;
        }

        const div = document.createElement('div');
        div.className = 'workflow-context-menu';
        div.tabIndex = -1;

        let previousGroup: string | undefined;
        for (const item of menuItems) {
            const group = typeof item.group === 'string' && item.group.trim() !== ''
                ? item.group
                : undefined;
            if (previousGroup && group && previousGroup !== group) {
                const separator = document.createElement('div');
                separator.className = 'workflow-context-menu-separator';
                separator.setAttribute('role', 'separator');
                separator.setAttribute('aria-hidden', 'true');
                div.appendChild(separator);
            }

            const button = document.createElement('button');
            button.className = 'workflow-context-menu-item';
            button.type = 'button';
            button.textContent = item.label ?? '';
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
                this.hide();
                onHide?.();
            });
            div.appendChild(button);

            if (group) {
                previousGroup = group;
            }
        }

        const { x, y } = anchorPoint(anchor);
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] render at', { x, y, labels: menuItems.map(i => i.label) });
        }

        // Attach first so width/height can be measured accurately.
        document.body.appendChild(div);

        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        const margin = 8;
        const menuW = div.offsetWidth;
        const menuH = div.offsetHeight;
        const clampedX = Math.max(margin, Math.min(x, Math.max(margin, viewportW - menuW - margin)));
        const clampedY = Math.max(margin, Math.min(y, Math.max(margin, viewportH - menuH - margin)));

        div.style.left = `${clampedX}px`;
        div.style.top = `${clampedY}px`;

        this.container = div;

        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] appended to document.body');
        }

        this.onDocMouseDown = (e: MouseEvent) => {
            if (!this.container) {
                return;
            }
            const target = e.target as Node | null;
            if (target && this.container.contains(target)) {
                return;
            }
            this.hide();
            onHide?.();
        };

        this.onDocKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.hide();
                onHide?.();
            }
        };

        document.addEventListener('mousedown', this.onDocMouseDown, true);
        document.addEventListener('keydown', this.onDocKeyDown, true);

        // Focus so Escape works reliably.
        div.focus();
    }

    private flatten(items: AnyMenuItem[]): AnyMenuItem[] {
        const out: AnyMenuItem[] = [];
        for (const item of items) {
            out.push(item);
            if (Array.isArray(item.children) && item.children.length > 0) {
                out.push(...this.flatten(item.children));
            }
        }
        return out;
    }

    private hide(): void {
        const debug = isContextMenuDebugEnabled();
        if (debug && this.container) {
            // eslint-disable-next-line no-console
            console.log('[workflow][context-menu] hide');
        }
        if (this.container) {
            this.container.remove();
            this.container = undefined;
        }
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
