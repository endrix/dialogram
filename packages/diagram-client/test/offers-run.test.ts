/**
 * What drives a run is offered unless the host says no run driver is behind
 * the diagram. The palette header adds Run, Stop and the edge toggle by
 * {@link runHeaderControls}; the property panel shows the agent-tool switches
 * by {@link offersRun}. (The client tests run without a DOM, so the header's
 * own wiring is not exercised here.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { offersRun, runHeaderControls } from '../src/profile';

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the run controls', () => {
    it('are gone when the host says no run driver is behind the diagram', () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: { runDriver: false } };
        expect(offersRun()).toBe(false);
        expect(runHeaderControls()).toEqual({ run: false, stop: false, edgeToggle: false });
    });

    it('are there when one is', () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: { runDriver: true } };
        expect(offersRun()).toBe(true);
        expect(runHeaderControls()).toEqual({ run: true, stop: true, edgeToggle: true });
    });

    it('stay in a webview the host did not describe', () => {
        expect(offersRun()).toBe(true);
    });
});
