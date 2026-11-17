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
