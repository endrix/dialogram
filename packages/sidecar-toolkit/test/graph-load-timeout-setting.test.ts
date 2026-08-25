/**
 * The deadline must always exist, and must always be raisable.
 *
 * Those two pull against each other: a limit with no escape hatch turns a
 * legitimately slow workflow into one that can never be opened, while a limit
 * that a bad setting can switch off brings back the notification that never goes
 * away. So every unusable value falls back to the default rather than to "no
 * deadline".
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_GRAPH_LOAD_TIMEOUT_MS,
    GRAPH_LOAD_TIMEOUT_SETTING,
    getGraphLoadTimeoutMs,
    graphLoadTimeoutHint
} from '../src/server/sidecar-runtime-config';

const CFG = { settingsNamespace: 'product' } as any;

/** A vscode stand-in whose configuration returns `value` for the timeout setting. */
function vscodeWith(value: unknown) {
    return {
        workspace: {
            getConfiguration: () => ({
                get: (key: string) => (key === GRAPH_LOAD_TIMEOUT_SETTING ? value : undefined)
            })
        }
    } as any;
}

describe('graph-load deadline from settings', () => {
    it('uses the default when nothing is configured', () => {
        expect(getGraphLoadTimeoutMs(CFG, vscodeWith(undefined))).toBe(DEFAULT_GRAPH_LOAD_TIMEOUT_MS);
    });

    it('takes a configured value, in seconds', () => {
        expect(getGraphLoadTimeoutMs(CFG, vscodeWith(300))).toBe(300_000);
    });

    it.each([
        ['zero', 0],
        ['negative', -5],
        ['not a number', 'soon'],
        ['infinite', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN]
    ])('falls back to the default when the setting is %s', (_label, value) => {
        // Never to "no deadline": that is the stuck notification coming back
        // through a typo'd setting.
        expect(getGraphLoadTimeoutMs(CFG, vscodeWith(value))).toBe(DEFAULT_GRAPH_LOAD_TIMEOUT_MS);
    });

    it('names the setting under the product namespace so the message can quote it', () => {
        expect(graphLoadTimeoutHint(CFG)).toContain(`product.${GRAPH_LOAD_TIMEOUT_SETTING}`);
    });
});
