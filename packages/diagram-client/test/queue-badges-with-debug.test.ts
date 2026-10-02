/**
 * The queue-size badges on the edges show only while the Debug button is
 * pressed, and disappear when it is pressed again.
 *
 * They are the stepper's: how many tokens sat on each edge at the step shown.
 * The button opens the stepper and sets a class on the body; the stylesheet
 * hides the badges without it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEBUG_EXPANDED_CLASS, showQueueBadges } from '../src/navigation-ui';

function fakeBody() {
    const classes = new Set<string>();
    return {
        classes,
        classList: {
            toggle(name: string, force?: boolean) {
                const on = force ?? !classes.has(name);
                if (on) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
                return on;
            }
        }
    };
}

describe('the queue-size badges', () => {
    it('show when the Debug button is pressed and hide when it is pressed again', () => {
        const body = fakeBody();

        showQueueBadges(body, true);
        expect(body.classes.has(DEBUG_EXPANDED_CLASS)).toBe(true);

        showQueueBadges(body, false);
        expect(body.classes.has(DEBUG_EXPANDED_CLASS)).toBe(false);
    });

    it('are hidden by the stylesheet unless the body says the stepper is open', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const css = readFileSync(path.join(here, '../src/diagram-client.css'), 'utf8');

        expect(css).toMatch(
            new RegExp(`body:not\\(\\.${DEBUG_EXPANDED_CLASS}\\)\\s+\\.edge-queue-badge\\s*\\{\\s*display:\\s*none;`)
        );
    });
});
