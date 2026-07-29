/**
 * The chat panel auto-sticks to the bottom during streaming ONLY while the user
 * is already at (or near) the bottom. `shouldStick` is the pure predicate that
 * decision hangs on.
 */
import { describe, expect, it } from 'vitest';
import { shouldStick, STICK_THRESHOLD_PX } from '../src/chat-scroll';

describe('shouldStick', () => {
    it('sticks when pinned exactly at the bottom', () => {
        // scrollTop === scrollHeight - clientHeight
        expect(shouldStick(800, 1000, 200)).toBe(true);
    });

    it('sticks when within the threshold of the bottom', () => {
        const scrollHeight = 1000;
        const clientHeight = 200;
        const scrollTop = scrollHeight - clientHeight - (STICK_THRESHOLD_PX - 1);
        expect(shouldStick(scrollTop, scrollHeight, clientHeight)).toBe(true);
    });

    it('does NOT stick once the user scrolls up past the threshold', () => {
        // User scrolled to the top of a tall transcript.
        expect(shouldStick(0, 1000, 200)).toBe(false);
    });

    it('does NOT stick just beyond the threshold', () => {
        const scrollHeight = 1000;
        const clientHeight = 200;
        const scrollTop = scrollHeight - clientHeight - (STICK_THRESHOLD_PX + 1);
        expect(shouldStick(scrollTop, scrollHeight, clientHeight)).toBe(false);
    });

    it('sticks when content is shorter than the viewport (nothing to scroll)', () => {
        expect(shouldStick(0, 150, 300)).toBe(true);
    });
});
