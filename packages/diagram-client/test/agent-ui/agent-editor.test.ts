// @vitest-environment happy-dom
/**
 * The `@agent` editor and the annotation section's agent and tool buttons, as
 * the property panel draws and sends them today for wfpy's agent nodes.
 * Characterization before the move to wfpy-ide: see `harness.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowShowAgentSkillsActionHandler, WorkflowShowClaudeAgentsActionHandler } from '../../src/editing-action-handlers';
import { ui, installPage, taskNode, dumpDom, ANALYST_AGENT } from './harness';
import { TestPanel, button, card, rootOf, tick } from './panel';

vi.mock('../../src/vscode-ui', async () => (await import('./harness')).vscodeUiModule());

const content = () => document.getElementById('property-content')!;

beforeEach(() => {
    ui.reset();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('an @agent node', () => {
    it('draws its annotation editor, its tool settings and its sections as today', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('analyst', [ANALYST_AGENT]));
        await tick();
        await expect(dumpDom(content())).toMatchFileSnapshot('./__snapshots__/agent-node.dom.txt');
    });

    it('asks the server for skills and agent presets, and the host for its tool settings', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('asker', [ANALYST_AGENT]));
        await tick();
        expect(panel.dispatched).toEqual([
            { kind: 'dialogram.requestAgentSkills', elementId: 'node:scope:root:asker', rootsMode: 'all' },
            { kind: 'dialogram.requestClaudeAgents', elementId: 'node:scope:root:asker' }
        ]);
        expect(ui.calls).toEqual([
            { method: 'executeCommand', args: ['wfpy.glsp.getAgentToolConfig', ['asker']] }
        ]);
    });

    it('saves the whole annotation, its arguments in the order it writes them', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('saver', [ANALYST_AGENT]));
        button(card('agent'), 'Save').click();
        await tick();
        const op = panel.last('dialogram.updateDefinitionAnnotation');
        expect(op).toMatchObject({ isOperation: true, elementId: 'node:scope:root:saver', action: 'upsert', annotationName: 'agent' });
        await expect(op.annotationText + '\n').toMatchFileSnapshot('./__snapshots__/agent-save.annotation.txt');
        await expect(JSON.stringify(op.argUpdates, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/agent-save.arg-updates.json');
    });

    it('saves an edited prompt as a quoted string literal', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('editor', [ANALYST_AGENT]));
        const prompt = card('agent').querySelector('textarea.agent-prompt-input') as HTMLTextAreaElement;
        prompt.value = 'Summarize "the" round.\nThen stop.';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        prompt.dispatchEvent(new Event('change', { bubbles: true }));
        button(card('agent'), 'Save').click();
        await tick();
        const op = panel.last('dialogram.updateDefinitionAnnotation');
        expect(op.argUpdates.prompt).toBe('"Summarize \\"the\\" round.\\nThen stop."');
        expect(op.annotationText).toContain('prompt="Summarize \\"the\\" round.\\nThen stop."');
    });

    it('removes the annotation', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('remover', [ANALYST_AGENT]));
        button(card('agent'), 'Remove').click();
        await tick();
        expect(panel.last('dialogram.updateDefinitionAnnotation')).toMatchObject({
            elementId: 'node:scope:root:remover', action: 'remove', annotationName: 'agent'
        });
    });
});

describe('discovered skills and agent presets', () => {
    const SKILLS = [
        {
            name: 'turnus-reader', description: 'Reads Turnus analyses', root: '/w/.wf/skills',
            skillDir: '/w/.wf/skills/turnus-reader', skillMdPath: '/w/.wf/skills/turnus-reader/SKILL.md',
            hasSkillMd: true, hooks: ['pre.py'], declaredHooks: { pre: 'pre.py' }
        },
        {
            name: 'half-done', root: '/home/u/.claude/skills', skillDir: '/home/u/.claude/skills/half-done',
            skillMdPath: '/home/u/.claude/skills/half-done/SKILL.md', hasSkillMd: false, hooks: [],
            warnings: ['missing SKILL.md']
        }
    ];

    it('offers the skills the server found, and saves the one picked', async () => {
        const node = taskNode('picker', [ANALYST_AGENT]);
        const panel = new TestPanel();
        panel.listenForDiscovery();
        panel.show(node);
        new WorkflowShowAgentSkillsActionHandler().handle({ kind: 'dialogram.showAgentSkills', elementId: node.id, skills: SKILLS } as any);
        await tick();

        ui.picks.push('turnus-reader');
        button(card('agent'), 'Pick Skill').click();
        await tick();
        const pick = ui.calls.find(c => c.method === 'quickPick')!;
        expect(pick.args[0]).toEqual({
            items: [
                { id: 'turnus-reader', label: 'turnus-reader', description: 'Reads Turnus analyses', detail: '/w/.wf/skills' },
                { id: 'half-done', label: 'half-done', description: 'missing SKILL.md', detail: '/home/u/.claude/skills | missing SKILL.md' }
            ],
            placeHolder: 'Select a skill'
        });
        await expect(dumpDom(card('agent'))).toMatchFileSnapshot('./__snapshots__/agent-skill-picked.dom.txt');

        button(card('agent'), 'Save').click();
        await tick();
        expect(panel.last('dialogram.updateDefinitionAnnotation').argUpdates.skill).toBe('"turnus-reader"');
    });

    it('says so when no skill was found', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('lonely', [ANALYST_AGENT]));
        button(card('agent'), 'Pick Skill').click();
        await tick();
        expect(ui.calls.filter(c => c.method === 'infoMessage')).toEqual([
            { method: 'infoMessage', args: ['No discovered skills found in .wf/.claude roots.'] }
        ]);
    });

    it('offers the agent presets the server found once the preset is enabled', async () => {
        const node = taskNode('preset', [ANALYST_AGENT]);
        const panel = new TestPanel();
        panel.show(node, rootOf(node));
        new WorkflowShowClaudeAgentsActionHandler().handle({
            kind: 'dialogram.showClaudeAgents', elementId: node.id,
            agents: [{ name: 'code-reviewer', description: 'Reviews diffs', path: '/w/.claude/agents/code-reviewer.md', ignoredFields: ['tools'] }]
        } as any);
        const presetBlock = [...card('agent').querySelectorAll('.agent-skill-block')]
            .find(b => b.querySelector('.agent-skill-label')?.textContent?.trim() === 'Agent Preset') as HTMLElement;
        const toggle = presetBlock.querySelector('input.agent-enabled-input') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        ui.picks.push('code-reviewer');
        button(presetBlock, 'Pick Preset').click();
        await tick();
        const pick = ui.calls.find(c => c.method === 'quickPick');
        await expect(JSON.stringify(pick?.args[0] ?? null, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/agent-preset.pick.json');
        await expect(dumpDom(presetBlock)).toMatchFileSnapshot('./__snapshots__/agent-preset-picked.dom.txt');
        button(card('agent'), 'Save').click();
        await tick();
        const op = panel.last('dialogram.updateDefinitionAnnotation');
        await expect(JSON.stringify(op.argUpdates, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/agent-preset-save.arg-updates.json');
    });
});

describe('the annotation section’s buttons', () => {
    it('adds an @agent and a @tool from their templates, and opens the wizard', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('plain', []));
        const header = document.querySelector('.section-actions')!;
        button(header, 'Add @agent').click();
        button(header, 'Add @tool').click();
        button(header, 'Wizard…').click();
        await tick();
        expect(panel.dispatched.slice(-3)).toEqual([
            {
                kind: 'dialogram.updateDefinitionAnnotation', isOperation: true, elementId: 'node:scope:root:plain',
                action: 'upsert', annotationName: 'agent',
                annotationText: '@agent(\n    prompt="Transform inputs to outputs",\n    model="openai/gpt-5-mini"\n)'
            },
            {
                kind: 'dialogram.updateDefinitionAnnotation', isOperation: true, elementId: 'node:scope:root:plain',
                action: 'upsert', annotationName: 'tool',
                annotationText: '@tool(\n    cmd="bash",\n    args=["-lc", ""],\n    inheritStdio=true\n)'
            },
            { kind: 'dialogram.editAnnotations', elementId: 'node:scope:root:plain' }
        ]);
    });
});
