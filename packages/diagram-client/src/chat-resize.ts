/**
 * Resizing the chat card by its edges: the top edge sets the message drawer's
 * height, a side edge the card's width, a top corner both. The card is centred,
 * so a side moves both sides by the same amount and the edge under the pointer
 * follows it.
 *
 * While a drag is on, the card carries `resizing`, which turns off the drawer's
 * height transition: with it on, every move restarted a quarter-second
 * animation and the drawer trailed the pointer for as long as it moved.
 */

/** The drawer's least height. */
export const CHAT_DRAWER_MIN_HEIGHT_PX = 120;
/** The drawer's greatest height, as a share of the window (`.chat-scroll`'s `max-height: 60vh`). */
export const CHAT_DRAWER_MAX_HEIGHT_RATIO = 0.6;
/** The card's least width (`.workflow-chat-panel`'s `min-width`). */
export const CHAT_PANEL_MIN_WIDTH_PX = 480;
/** The room the card leaves beside it (`.workflow-chat-panel`'s `max-width: calc(100vw - 28px)`). */
export const CHAT_PANEL_SIDE_ROOM_PX = 28;

export const CHAT_HEIGHT_STORAGE_KEY = 'workflow.diagram.chatPanel.heightPx';
export const CHAT_WIDTH_STORAGE_KEY = 'workflow.diagram.chatPanel.widthPx';

export type ChatResizeEdge = 'top' | 'left' | 'right' | 'top-left' | 'top-right';

/** The handles the card draws, one per edge or corner. */
export const CHAT_RESIZE_EDGES: readonly ChatResizeEdge[] = ['top', 'left', 'right', 'top-left', 'top-right'];

/**
 * `px`, kept between the drawer's least and greatest heights. In a window too
 * short for both the greatest wins, as `max-height` does over `height`.
 */
export function drawerHeight(px: number, windowHeight: number): number {
    const most = windowHeight * CHAT_DRAWER_MAX_HEIGHT_RATIO;
    return Math.round(Math.min(most, Math.max(CHAT_DRAWER_MIN_HEIGHT_PX, px)));
}

/**
 * `px`, kept between the card's least width and the window's width less the
 * room beside it. In a window too narrow for both the least wins, as
 * `min-width` does over `max-width`.
 */
export function panelWidth(px: number, windowWidth: number): number {
    const most = Math.max(CHAT_PANEL_MIN_WIDTH_PX, windowWidth - CHAT_PANEL_SIDE_ROOM_PX);
    return Math.round(Math.min(most, Math.max(CHAT_PANEL_MIN_WIDTH_PX, px)));
}

/** Put the sizes saved by the last drag back on the card. */
export function restoreChatSize(panel: HTMLElement): void {
    const height = readSaved(CHAT_HEIGHT_STORAGE_KEY);
    if (height) {
        panel.style.setProperty('--chat-drawer-height', height);
    }
    const width = readSaved(CHAT_WIDTH_STORAGE_KEY);
    if (width) {
        panel.style.setProperty('--chat-panel-width', width);
    }
}

/**
 * Start a drag on one of the card's handles (its `pointerdown`). The pointer is
 * captured, so the drag goes on when it leaves the handle. A release outside
 * the webview never reaches it, so the drag also ends at the first move with
 * the button up, and when the webview loses focus.
 */
export function startChatResize(panel: HTMLElement, event: PointerEvent, edge: ChatResizeEdge): void {
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();
    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const scroll = panel.querySelector<HTMLElement>('.chat-scroll');
    // A closed drawer has no height to drag: its handles are hidden, and a
    // corner drag changes the width only, so the saved height stays.
    const top = edge.startsWith('top') && !panel.classList.contains('drawer-closed') && !!scroll;
    const side = edge.endsWith('left') ? -1 : edge.endsWith('right') ? 1 : 0;
    if (!top && side === 0) {
        return;
    }
    // Transition off before measuring: a drawer still opening snaps to the
    // height it was opening to, which is where the drag starts from.
    panel.classList.add('resizing');
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = scroll?.getBoundingClientRect().height ?? 0;
    const startWidth = panel.getBoundingClientRect().width;

    const cursor = handle ? getComputedStyle(handle).cursor : '';
    document.body.style.cursor = cursor;
    try {
        handle?.setPointerCapture(event.pointerId);
    } catch {
        // No capture (an old engine, or the pointer already gone): the document's listeners still see the moves.
    }

    const move = (ev: PointerEvent): void => {
        if ((ev.buttons & 1) === 0) {
            // The release happened where the webview could not hear it.
            end();
            return;
        }
        if (top) {
            panel.style.setProperty('--chat-drawer-height', `${drawerHeight(startHeight + startY - ev.clientY, window.innerHeight)}px`);
        }
        if (side !== 0) {
            panel.style.setProperty('--chat-panel-width', `${panelWidth(startWidth + 2 * side * (ev.clientX - startX), window.innerWidth)}px`);
        }
    };
    const end = (): void => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        panel.classList.remove('resizing');
        document.body.style.cursor = '';
        if (top) {
            save(CHAT_HEIGHT_STORAGE_KEY, panel.style.getPropertyValue('--chat-drawer-height'));
        }
        if (side !== 0) {
            save(CHAT_WIDTH_STORAGE_KEY, panel.style.getPropertyValue('--chat-panel-width'));
        }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
}

function readSaved(key: string): string | undefined {
    try {
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}

function save(key: string, value: string): void {
    if (!value) {
        return;
    }
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage refused: the size holds until the webview reloads.
    }
}
