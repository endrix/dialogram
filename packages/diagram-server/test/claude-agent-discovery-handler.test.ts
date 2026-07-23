import { describe, expect, it } from 'vitest';
import { __testables, WorkflowRequestClaudeAgentsOperationHandler } from '../src/operations/request-claude-agents-handler.js';

describe('claude agent discovery handler', () => {
    it('extracts description from markdown body', () => {
        const handler = new WorkflowRequestClaudeAgentsOperationHandler();
        const text = [
            '---',
            'name: reviewer',
            '---',
            '# Reviewer',
            '',
            'Review patches for correctness and maintainability.',
        ].join('\n');
        const desc = __testables.extractDescription(handler, text);
        expect(desc).toBe('Review patches for correctness and maintainability.');
    });

    it('generates compatibility warnings for unsupported fields', () => {
        const handler = new WorkflowRequestClaudeAgentsOperationHandler();
        const warnings = __testables.compatWarnings(handler, {
            model: 'sonnet',
            tools: 'Read,Write',
            permissionMode: 'default',
            memory: 'project',
        });
        const ignored = __testables.ignoredFields(handler, {
            model: 'sonnet',
            tools: 'Read,Write',
            permissionMode: 'default',
            memory: 'project',
        });
        expect(warnings.some((w: string) => w.includes("'model'") && w.includes('ignored'))).toBe(true);
        expect(warnings.some((w: string) => w.includes("'tools'") && w.includes('ignored'))).toBe(true);
        expect(warnings.some((w: string) => w.includes("'permissionMode'") && w.includes('ignored'))).toBe(true);
        expect(warnings.some((w: string) => w.includes("'memory'") && w.includes('ignored'))).toBe(true);
        expect(ignored).toEqual(expect.arrayContaining(['model', 'tools', 'permissionMode', 'memory']));
    });

    it('includes runtime and home claude roots', () => {
        const handler = new WorkflowRequestClaudeAgentsOperationHandler();
        const roots = __testables.agentRoots(handler, '/tmp/my-workflow');
        expect(roots).toContain('/tmp/my-workflow/.claude/agents');
        expect(roots.some((r: string) => r.endsWith('/.claude/agents'))).toBe(true);
    });
});
