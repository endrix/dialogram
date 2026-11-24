import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createUntangleCommand } from '../src/extension/chat/untangle-command';

const CTX = { file: '/ws/wf.py', uri: 'file:///ws/wf.py', sessionId: 's1', selectedNodeIds: [] as string[] };

/** The diagram's GLSP-MCP tools: `session-info` lists one session of the chat's file; every other call succeeds. */
function makeTools() {
    const calls: Array<{ tool: string; args: any }> = [];
    return {
        calls,
        callTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
            calls.push({ tool, args });
            if (tool === 'session-info') {
                return { ok: true, text: '', structured: { sessions: [{ sessionId: 'glsp_1', sourceUri: 'file:///ws/wf.py', readOnly: false }] } };
            }
            return { ok: true, text: '' };
        })
    };
}

describe('/untangle', () => {
    it('hands the agent the untangle, whatever the diagram\'s source can take, and ends it with the turn', async () => {
        const tools = makeTools();
        const untangle = createUntangleCommand({ tools, getEditorProvider: () => undefined });
        expect(untangle.command).toBe('untangle');
        expect(untangle.modes).toEqual(['build']);
        const result: any = await untangle.handler!({}, CTX);
        expect(result.success).toBe(true);
        expect(result.prompt).toContain('untangle-start');
        expect(result.prompt).toContain('at most 10 tries');
        expect(result.prompt).toContain('untangle-propose');
        // A second /untangle in one chat starts over, the diagram maybe changed by the first.
        expect(result.prompt).toContain('This is a new untangle, whatever this chat did before');
        // Nothing is asked of the diagram before the agent's turn: no source capability gates it.
        expect(tools.calls).toEqual([]);
        // Its turn over, a try the agent left drawn and did not propose is drawn back.
        await result.afterTurn();
        expect(tools.calls.at(-1)).toEqual({ tool: 'untangle-end', args: { sessionId: 'glsp_1' } });
    });

    it('is refused where the diagram\'s tools are turned off', async () => {
        const get = vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => false } as any);
        try {
            const result = await createUntangleCommand({ tools: makeTools(), getEditorProvider: () => undefined }).handler!({}, CTX);
            expect(result).toEqual({ success: false, error: "The agent untangles with the diagram's tools, which are turned off here." });
        } finally {
            get.mockRestore();
        }
    });
});
