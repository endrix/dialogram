// @vitest-environment happy-dom
/**
 * What the panel does for an agent node's configured skill, as it does it
 * today: the Skill row of Basic Info, the skills and agent presets it takes
 * from the root's snapshots before drawing, and the redraw when discovery
 * answers for the node shown. Characterization before the move to wfpy-ide:
 * see `harness.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowShowAgentSkillsActionHandler, WorkflowShowClaudeAgentsActionHandler } from '../../src/editing-action-handlers';
import { installPage, taskNode, ANALYST_AGENT } from './harness';
import { TestPanel, resetAgentUi, rootOf, section, tick } from './panel';

vi.mock('../../src/vscode-ui', async () => (await import('./harness')).vscodeUiModule());

const READER = {
    name: 'turnus-reader', description: 'Reads Turnus analyses', root: '/w/.wf/skills',
    skillDir: '/w/.wf/skills/turnus-reader', skillMdPath: '/w/.wf/skills/turnus-reader/SKILL.md',
    hasSkillMd: true, hooks: [], declaredHooks: {}
};
const PRESET = { name: 'reviewer', description: 'Reviews a change', path: '/w/.claude/agents/reviewer.md' };

/** An agent node whose spec names a skill, as the server sends it. */
const skilled = (name: string) => taskNode(name, [ANALYST_AGENT], { 'wf:agentSpec': { skill: 'turnus-reader' } });

/** The Basic Info rows, label to value. */
function infoRows(): Record<string, string> {
    const rows: Record<string, string> = {};
    for (const row of section('Basic Info')!.querySelectorAll('.pp-arow')) {
        rows[row.querySelector('.pp-akey')!.textContent!.trim()] = row.querySelector('.pp-aval')!.textContent!.replace(/\s+/g, ' ').trim();
    }
    return rows;
}

const kinds = (panel: TestPanel) => panel.dispatched.map(action => action.kind);

beforeEach(() => {
    resetAgentUi();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the Skill row of an agent node', () => {
    it('says the configured skill was not discovered, and writes that into the node', () => {
        const node = skilled('lonely');
        new TestPanel().show(node);
        expect(infoRows()).toMatchObject({ Name: 'lonely', Skill: 'Skill \'turnus-reader\' not discovered in configured roots.' });
        expect(node.args[WorkflowDiagramMetadata.AGENT_SKILL_STATUS]).toBe('Skill \'turnus-reader\' not discovered in configured roots.');
    });

    it('describes the skill from the root’s snapshot, and keeps the snapshot’s presets for the node', () => {
        const node = skilled('primed');
        const root = rootOf(node);
        root.args = {
            'wf:agentSkillsSnapshot': JSON.stringify([READER]),
            'wf:claudeAgentsSnapshot': JSON.stringify([PRESET])
        };
        new TestPanel().show(node, root);
        expect(infoRows().Skill).toBe('Reads Turnus analyses');
        expect(WorkflowShowAgentSkillsActionHandler.getSkillsForElement(node.id)).toEqual([READER]);
        expect(WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(node.id)).toEqual([PRESET]);
    });

    it('keeps what discovery found when the snapshot is empty', () => {
        const node = skilled('kept');
        new WorkflowShowAgentSkillsActionHandler().handle({ kind: 'dialogram.showAgentSkills', elementId: node.id, skills: [READER] } as any);
        const root = rootOf(node);
        root.args = { 'wf:agentSkillsSnapshot': '[]' };
        new TestPanel().show(node, root);
        expect(infoRows().Skill).toBe('Reads Turnus analyses');
    });

    it('is absent when the spec names no skill', () => {
        new TestPanel().show(taskNode('plain', [ANALYST_AGENT]));
        expect(Object.keys(infoRows())).not.toContain('Skill');
    });

    it('takes no snapshot for the node of a selected port', () => {
        const node = skilled('ported');
        const port = { id: `${node.id}:in`, type: 'port', args: { [WorkflowDiagramMetadata.IS_INPUT_PORT]: true }, parent: node, children: [] };
        node.children = [port];
        const root = rootOf(node, port);
        root.args = { 'wf:agentSkillsSnapshot': JSON.stringify([READER]) };
        const panel = new TestPanel();
        (panel as any).lastRoot = root;
        (panel as any).updateContent(port);
        expect(WorkflowShowAgentSkillsActionHandler.getSkillsForElement(node.id)).toEqual([]);
        expect(infoRows().Skill).toBe('Skill \'turnus-reader\' not discovered in configured roots.');
    });
});

describe('when discovery answers', () => {
    function listening(): TestPanel {
        const panel = new TestPanel();
        panel.listenForDiscovery();
        onTestFinished(() => panel.dispose());
        return panel;
    }

    it('redraws the node shown with what it found, without asking for skills again', async () => {
        const node = skilled('answered');
        const panel = listening();
        panel.show(node);
        expect(kinds(panel)).toEqual(['dialogram.requestAgentSkills', 'dialogram.requestClaudeAgents']);
        new WorkflowShowAgentSkillsActionHandler().handle({ kind: 'dialogram.showAgentSkills', elementId: node.id, skills: [READER] } as any);
        await tick();
        expect(infoRows().Skill).toBe('Reads Turnus analyses');
        expect(kinds(panel)).toEqual(['dialogram.requestAgentSkills', 'dialogram.requestClaudeAgents', 'dialogram.requestClaudeAgents']);
    });

    it('does not redraw for another node', async () => {
        const node = skilled('shown');
        const panel = listening();
        panel.show(node);
        new WorkflowShowAgentSkillsActionHandler().handle({ kind: 'dialogram.showAgentSkills', elementId: 'node:scope:root:other', skills: [READER] } as any);
        await tick();
        expect(kinds(panel)).toHaveLength(2);
        expect(infoRows().Skill).toBe('Skill \'turnus-reader\' not discovered in configured roots.');
    });

    it('does not redraw while the panel is collapsed', async () => {
        const node = skilled('hidden');
        const panel = listening();
        panel.show(node);
        document.getElementById('property-panel')!.classList.add('collapsed');
        new WorkflowShowAgentSkillsActionHandler().handle({ kind: 'dialogram.showAgentSkills', elementId: node.id, skills: [READER] } as any);
        await tick();
        expect(kinds(panel)).toHaveLength(2);
    });
});
