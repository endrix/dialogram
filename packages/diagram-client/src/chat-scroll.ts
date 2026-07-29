/**
 * Auto-scroll ("stick to bottom") policy for the chat transcript.
 *
 * The panel re-renders on every streamed token. Force-scrolling to the bottom on
 * each render traps the user at the end of the transcript — they can never read
 * back while the assistant is still streaming. Instead we keep the view pinned
 * ONLY when the user is already at (or near) the bottom; once they scroll up,
 * auto-scroll stops until they return to the bottom themselves.
 */

/** How close to the bottom (px) still counts as "stuck". */
export const STICK_THRESHOLD_PX = 40;

/**
 * True when the scroll position is at (or within {@link STICK_THRESHOLD_PX} of)
 * the bottom — the only case in which a re-render should re-pin to the end.
 * Pure and DOM-free so it can be unit-tested in isolation.
 */
export function shouldStick(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    threshold: number = STICK_THRESHOLD_PX
): boolean {
    return scrollHeight - scrollTop - clientHeight <= threshold;
}
