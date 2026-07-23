/**
 * Truth-table tests for the host-injected client behavior flags.
 *
 * These flags replace the former `runtimeProfile === 'calpy'` / hardcoded
 * `'wfpy-none'` / `cmd === 'python'` comparisons in the webview. The shells
 * supply per-product values through `window.diagramIdentifier.clientBehavior`;
 * `clientBehavior()` is the single seam every consumer reads. Behavior must stay
 * byte-identical per product, so we pin the exact fixtures the two shells inject
 * and assert the derived predicates each consumer computes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clientBehavior } from '../src/profile';

// Byte-identical mirrors of the two shells' `clientBehavior` inputs.
const WFPY_BEHAVIOR = {
    graphSourceNavigation: false,
    networkPropertySections: false,
    networkNavigationLabels: false,
    noneSentinel: 'wfpy-none',
    scriptInterpreterCommands: ['python', 'python3']
};

const CALPY_BEHAVIOR = {
    graphSourceNavigation: true,
    networkPropertySections: true,
    networkNavigationLabels: true,
    noneSentinel: 'wfpy-none',
    scriptInterpreterCommands: ['python', 'python3']
};

function inject(behavior: unknown): void {
    (globalThis as any).diagramIdentifier = { clientBehavior: behavior };
}

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('clientBehavior flag consumption', () => {
    it('resolves the wfpy truth table (network behaviors off)', () => {
        inject(WFPY_BEHAVIOR);
        const cb = clientBehavior();
        // network-navigation-mouse-listener drill-down predicate
        expect(cb.graphSourceNavigation === true).toBe(false);
        // property-panel isNetworkRuntime predicate
        expect(cb.networkPropertySections === true).toBe(false);
        // navigation-ui entity-label predicate
        expect(cb.networkNavigationLabels === true).toBe(false);
        // property-panel CLI-tools "none" sentinel
        expect(cb.noneSentinel).toBe('wfpy-none');
        // views.ts icon detection
        expect((cb.scriptInterpreterCommands ?? []).includes('python')).toBe(true);
        expect((cb.scriptInterpreterCommands ?? []).includes('python3')).toBe(true);
        expect((cb.scriptInterpreterCommands ?? []).includes('bash')).toBe(false);
    });

    it('resolves the calpy truth table (network behaviors on)', () => {
        inject(CALPY_BEHAVIOR);
        const cb = clientBehavior();
        expect(cb.graphSourceNavigation === true).toBe(true);
        expect(cb.networkPropertySections === true).toBe(true);
        expect(cb.networkNavigationLabels === true).toBe(true);
        expect(cb.noneSentinel).toBe('wfpy-none');
        expect((cb.scriptInterpreterCommands ?? []).includes('python')).toBe(true);
        expect((cb.scriptInterpreterCommands ?? []).includes('python3')).toBe(true);
    });

    it('reads as all-off with no sentinel when nothing is injected (dev/standalone)', () => {
        const cb = clientBehavior();
        expect(cb.graphSourceNavigation === true).toBe(false);
        expect(cb.networkPropertySections === true).toBe(false);
        expect(cb.networkNavigationLabels === true).toBe(false);
        expect(cb.noneSentinel).toBeUndefined();
        expect((cb.scriptInterpreterCommands ?? []).includes('python')).toBe(false);
    });

    it('ignores a non-object clientBehavior payload', () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: 'nope' };
        expect(clientBehavior()).toEqual({});
    });
});
