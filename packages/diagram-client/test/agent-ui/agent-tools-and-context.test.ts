// @vitest-environment happy-dom
/**
 * The Agent Tools section, the agent-context section and the `@tool` card, as
 * the property panel draws and sends them today. Characterization before the
 * move to wfpy-ide: see `harness.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { ui, installPage, taskNode, dumpDom, ANALYST_AGENT, BASH_TOOL } from './harness';
import { TestPanel, button, card, resetAgentUi, rootOf, section, tick } from './panel';

vi.mock('../../src/vscode-ui', async () => (await import('./harness')).vscodeUiModule());

beforeEach(() => {
    resetAgentUi();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('Agent Tools', () => {
    it('shows the host’s settings for the agent, and sends each change', async () => {
        ui.answers.set('wfpy.glsp.getAgentToolConfig', { enabled: true, auth: 'policy' });
        const panel = new TestPanel();
        panel.show(taskNode('tooled', [ANALYST_AGENT]));
        await tick();
        const tools = section('Agent Tools')!;
        await expect(dumpDom(tools)).toMatchFileSnapshot('./__snapshots__/agent-tools.dom.txt');

        // As a person can: pick another auth mode while the tools are on, then turn them off.
        const auth = tools.querySelector('select') as HTMLSelectElement;
        expect(auth.disabled).toBe(false);
        auth.value = 'deny-all';
        auth.dispatchEvent(new Event('change', { bubbles: true }));
        const enabled = tools.querySelector('input[type="checkbox"]') as HTMLInputElement;
        enabled.checked = false;
        enabled.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        expect(auth.disabled).toBe(true);
        await expect(JSON.stringify(ui.calls, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/agent-tools.calls.json');
    });

    it('is not offered where no run driver is behind the diagram', async () => {
        installPage({ runDriver: false });
        const panel = new TestPanel();
        panel.show(taskNode('unrun', [ANALYST_AGENT]));
        await tick();
        expect(section('Agent Tools')).toBeUndefined();
        expect(ui.calls).toEqual([]);
    });

    it('is not offered for a node without @agent', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('toolonly', [BASH_TOOL]));
        await tick();
        expect(section('Agent Tools')).toBeUndefined();
    });
});

/** A stateful agent's history as the run overlay stamps it on the node. */
const HISTORY = [
    { role: 'system', content: 'You are the analyst.' },
    // The shape wfpy's runtime writes for an agent's input: its task, its instance, the inputs by port.
    {
        role: 'user',
        content: JSON.stringify({
            task: 'Analyst',
            instance: 'analyst',
            inputs: { round: '/w/out/r3/round.json' },
            fileInputs: { round: { path: '/w/out/r3/round.json', content: '{"round": 3, "cycles": {"dhrystone": 41210}}' } }
        })
    },
    { role: 'assistant', content: '## Budget\n\n- dhrystone: **12%** of the path\n- fetch still on the path', thinking: 'Compare with round 2.' },
    { role: 'assistant', content: 'x'.repeat(450) }
];

function withHistory(name: string, history: unknown[]): any {
    return taskNode(name, [ANALYST_AGENT], {
        [WorkflowDiagramMetadata.AGENT_CHAT_HISTORY]: JSON.stringify(history),
        [WorkflowDiagramMetadata.AGENT_FIRE_COUNT]: 3,
        [WorkflowDiagramMetadata.AGENT_CONTEXT_BUDGET]: 50,
        [WorkflowDiagramMetadata.AGENT_TRUNCATION_STRATEGY]: 'sliding',
        [WorkflowDiagramMetadata.AGENT_MODEL]: 'opus'
    });
}

describe('the agent-context section', () => {
    it('shows a stateful agent’s conversation as today', async () => {
        const panel = new TestPanel();
        panel.show(withHistory('talker', HISTORY));
        await tick();
        const context = section('Agent Context')!;
        expect(context).toBeDefined();
        await expect(dumpDom(context)).toMatchFileSnapshot('./__snapshots__/agent-context.dom.txt');
    });

    it('is absent without a history, and when the history is not JSON', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('silent', [ANALYST_AGENT]));
        expect(section('Agent Context')).toBeUndefined();
        panel.show(taskNode('garbled', [ANALYST_AGENT], { [WorkflowDiagramMetadata.AGENT_CHAT_HISTORY]: '{not json' }));
        expect(section('Agent Context')).toBeUndefined();
    });

    it('follows the run: a new history on the shown node replaces the section in place', async () => {
        const first = withHistory('streamer', HISTORY.slice(0, 2));
        const panel = new TestPanel();
        panel.show(first);
        const before = section('Agent Context')!;
        const annotations = section('Annotations')!;
        expect(before.querySelector('.section-title')?.textContent).toBe('Agent Context (2/50)');

        const next = withHistory('streamer', HISTORY);
        panel.modelRootChanged(rootOf(next));
        await tick();
        const after = section('Agent Context')!;
        expect(after.querySelector('.section-title')?.textContent).toBe('Agent Context (4/50)');
        // In place: the rest of the panel is the same DOM, not a re-render.
        expect(section('Annotations')).toBe(annotations);
        expect([...document.querySelectorAll('.property-section')]
            .filter(s => s.querySelector('.section-title')?.textContent?.startsWith('Agent Context'))).toHaveLength(1);
    });
});

describe('a @tool node', () => {
    it('draws its editor as today and saves the whole annotation', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('builder', [BASH_TOOL]));
        await tick();
        await expect(dumpDom(card('tool'))).toMatchFileSnapshot('./__snapshots__/tool-card.dom.txt');
        button(card('tool'), 'Save').click();
        await tick();
        const op = panel.last('dialogram.updateDefinitionAnnotation');
        expect(op).toMatchObject({ elementId: 'node:scope:root:builder', action: 'upsert', annotationName: 'tool' });
        // KNOWN DEFECT, pinned as it ships: the text says `inherit_stdio=True` while
        // the argument updates say `inheritStdio: "true"`, so the operation names one
        // argument two ways. Fixing it changes these two snapshots on purpose.
        expect(op.annotationText).toContain('inherit_stdio=True');
        expect(op.argUpdates.inheritStdio).toBe('true');
        await expect(op.annotationText + '\n').toMatchFileSnapshot('./__snapshots__/tool-save.annotation.txt');
        await expect(JSON.stringify(op.argUpdates, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/tool-save.arg-updates.json');
    });
});
