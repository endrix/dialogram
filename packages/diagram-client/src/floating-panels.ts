/**
 * The panels that float over the diagram (the chat, the hierarchy) overlap where
 * the editor is narrow, and each had a fixed place in the stacking order: the
 * hierarchy, a step above the chat, covered the chat's send button whenever its
 * button sat low in the stack. The panel in use is on top: the one last opened,
 * clicked or typed in.
 */
const RAISED_Z = '1002';
const LOWERED_Z = '1001';

const panels = new Set<HTMLElement>();

/** Take part in the order: a click or focus inside the panel raises it. */
export function stackAsFloatingPanel(panel: HTMLElement): void {
    if (panels.has(panel)) {
        return;
    }
    panels.add(panel);
    const raise = (): void => raiseFloatingPanel(panel);
    // Capturing, so a click a child stops still raises the panel.
    panel.addEventListener('pointerdown', raise, true);
    panel.addEventListener('focusin', raise);
}

/** Put `panel` above the other floating panels. */
export function raiseFloatingPanel(panel: HTMLElement): void {
    for (const each of [...panels]) {
        if (!each.isConnected) {
            panels.delete(each);
            continue;
        }
        each.style.zIndex = each === panel ? RAISED_Z : LOWERED_Z;
    }
}

/** The id of the floating button stack, bottom right of the canvas. */
export const FLOATING_BUTTON_STACK_ID = 'workflow-fab-stack';

/**
 * The floating button stack, made once: the column of buttons bottom right of
 * the canvas (the chat's, the outlines', the navigation's) that a panel's
 * button joins (`placeInButtonStack`) and a panel opens beside. The stock
 * navigation makes it; a product with views of its own calls this before the
 * chat panel starts, so that the chat's button joins it too. Styles in
 * floating-buttons.css.
 */
export function ensureFloatingButtonStack(doc: Document = document): HTMLDivElement {
    const existing = doc.querySelector<HTMLDivElement>('div.workflow-fab-stack');
    if (existing) {
        return existing;
    }
    const stack = doc.createElement('div');
    stack.className = 'workflow-fab-stack';
    stack.id = FLOATING_BUTTON_STACK_ID;
    doc.body.appendChild(stack);
    return stack;
}

/** Sent on `window` when a floating panel opened, closed or moved: what keeps clear of them places itself again. */
export const FLOATING_PANELS_MOVED = 'dialogram.floatingPanels.moved';

export function announceFloatingPanelsMoved(): void {
    window.dispatchEvent(new CustomEvent(FLOATING_PANELS_MOVED));
}
