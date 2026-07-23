import { describe, expect, it } from 'vitest';
import { __testables, WorkflowRequestAgentSkillsOperationHandler } from '../src/operations/request-agent-skills-handler.js';

describe('agent skill discovery hook parsing', () => {
    it('parses hooks from SKILL frontmatter', () => {
        const handler = new WorkflowRequestAgentSkillsOperationHandler();
        const raw = [
            '---',
            'name: writer',
            'hooks:',
            '  pre: prep_context',
            '  post: finalize_output',
            '---',
            '# Body',
        ].join('\n');
        const hooks = __testables.parseDeclaredHooks(handler, raw);
        expect(hooks).toEqual({ pre: 'prep_context', post: 'finalize_output' });
    });

    it('returns undefined when no frontmatter', () => {
        const handler = new WorkflowRequestAgentSkillsOperationHandler();
        const hooks = __testables.parseDeclaredHooks(handler, '# plain markdown');
        expect(hooks).toBeUndefined();
    });

    it('extracts human description from skill body', () => {
        const handler = new WorkflowRequestAgentSkillsOperationHandler();
        const raw = [
            '---',
            'name: writer',
            '---',
            '# Writer Skill',
            '',
            'Create concise executive summaries.',
        ].join('\n');
        const desc = __testables.extractSkillDescription(handler, raw);
        expect(desc).toBe('Create concise executive summaries.');
    });

    it('roots mode project excludes cwd/home fallbacks', () => {
        const handler = new WorkflowRequestAgentSkillsOperationHandler();
        const runtimeRoot = '/tmp/wf-project';
        const allRoots = __testables.skillRoots(handler, runtimeRoot, 'all');
        const projectRoots = __testables.skillRoots(handler, runtimeRoot, 'project');

        expect(projectRoots).toContain('/tmp/wf-project/.wf/skills');
        expect(projectRoots).toContain('/tmp/wf-project/.claude/skills');
        expect(projectRoots.length).toBeLessThan(allRoots.length);

        const extraInAll = allRoots.filter((root: string) => !projectRoots.includes(root));
        expect(extraInAll.some((root: string) => root.includes('/.claude/skills'))).toBe(true);
    });

    it('includes ancestor skill roots for nested workflow files', () => {
        const handler = new WorkflowRequestAgentSkillsOperationHandler();
        const projectRoots = __testables.skillRoots(handler, '/tmp/wf-project/src/nested', 'project');

        expect(projectRoots).toContain('/tmp/wf-project/src/nested/.wf/skills');
        expect(projectRoots).toContain('/tmp/wf-project/src/.wf/skills');
        expect(projectRoots).toContain('/tmp/wf-project/.wf/skills');
    });
});
