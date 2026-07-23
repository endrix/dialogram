import { describe, expect, it } from 'vitest';
import { GraphGModelSource } from '../src/model/graph-gmodel-source.js';

describe('python model source agent spec formatting', () => {
    it('exports agent string fields as wf string literals', () => {
        const src = new GraphGModelSource();
        const doc: any = {
            graph: {
                workflow: 'Main',
                nodes: [
                    {
                        id: 'n1',
                        kind: 'agent',
                        label: 'analyze',
                        type: 'AnalyzeAgent',
                        scope: 'scope:root',
                        ports: [
                            { id: 'p1', name: 'In', direction: 'in', type: 'any' },
                            { id: 'p2', name: 'Out', direction: 'out', type: 'any' },
                        ],
                        meta: {
                            agent: {
                                prompt: 'Review this graph',
                                skill: 'writer',
                                claudeAgent: 'code-reviewer',
                                usePrompt: true,
                                useSkill: true,
                                useClaudeAgent: true,
                            },
                            source: { file: '/tmp/demo.py', line: 10 }
                        }
                    }
                ],
                edges: [],
                scopes: [{ id: 'scope:root', kind: 'root' }],
            }
        };

        const model = src.transform(doc as any);
        const node = (model.graph.children ?? [])[0] as any;
        const spec = node?.args?.['wf:agentSpec'] as Record<string, unknown>;

        expect(spec).toBeTruthy();
        expect(spec['prompt']).toBe('"Review this graph"');
        expect(spec['skill']).toBe('"writer"');
        expect(spec['claudeAgent']).toBe('"code-reviewer"');
        expect(spec['usePrompt']).toBe(true);
        expect(spec['useSkill']).toBe(true);
        expect(spec['useClaudeAgent']).toBe(true);
    });
});
