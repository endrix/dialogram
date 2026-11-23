// @vitest-environment happy-dom
/**
 * The Running agents bar and the outlines (the hierarchy, a product's node
 * list) open in the same corner, beside the button lane: the outlines on top.
 * The bar moves left of the open outlines when there is room, and back when
 * they close; where there is none it stays, and the panel in use is on top.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';
import { announceFloatingPanelsMoved } from '../src/floating-panels';
import { RunningAgentsBar, agentsBarPlacement } from '../src/running-agents-bar';

describe('agentsBarPlacement', () => {
    it('keeps the stylesheet place when no outline is open', () => {
        expect(agentsBarPlacement([], 1700)).toBeUndefined();
        expect(agentsBarPlacement([{ left: 0, width: 0 }], 1700)).toBeUndefined();
    });

    it('goes left of the leftmost open outline, at its width when there is room', () => {
        // Viewers at 1260..1640 over the hierarchy at 1260..1640, in a 1700 px window.
        expect(agentsBarPlacement([{ left: 1260, width: 380 }, { left: 1270, width: 370 }], 1700)).toEqual({ right: 452, width: 340 });
    });

    it('narrows to the room there is, not past the canvas, and stays put when that is too little', () => {
        expect(agentsBarPlacement([{ left: 600, width: 380 }], 1000, 300)).toEqual({ right: 412, width: 276 });
        expect(agentsBarPlacement([{ left: 500, width: 380 }], 900, 300)).toBeUndefined();
    });
});

describe('the bar beside the outlines', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        RunAgentStreamActionHandler.reset();
        vi.restoreAllMocks();
    });

    function outlinePanel(left: number): HTMLElement {
        const panel = document.createElement('aside');
        panel.className = 'workflow-hierarchy-outline';
        panel.getBoundingClientRect = () => ({ left, width: 380, right: left + 380, top: 400, bottom: 900, height: 500, x: left, y: 400, toJSON: () => ({}) });
        document.body.appendChild(panel);
        return panel;
    }

    async function frames(): Promise<void> {
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
        }
    }

    it('moves aside while an outline is open and comes back when it closes', async () => {
        Object.defineProperty(window, 'innerWidth', { value: 1700, configurable: true });
        const panel = outlinePanel(1260);
        const bar = new RunningAgentsBar();
        bar.postModelInitialization();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        new RunAgentStreamActionHandler().handle({
            kind: EXECUTION_OVERLAY_ACTION_KIND,
            sourceUri: 'file:///w/flow.py',
            events: [{ type: 'run.started' }, { type: 'agent.message.start', instance: 'writer' }]
        } as never);
        await frames();

        const host = document.getElementById('wf-running-agents-bar')!;
        expect(host.classList.contains('hidden')).toBe(false);
        expect(host.style.right).toBe('452px');
        expect(host.style.width).toBe('340px');

        panel.hidden = true;
        announceFloatingPanelsMoved();
        expect(host.style.right).toBe('');
        expect(host.style.width).toBe('');
    });
});
