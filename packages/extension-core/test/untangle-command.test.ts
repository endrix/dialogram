import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createUntangleCommand, platformChatCommands } from '../src/extension/chat/untangle-command';

const CTX = { file: '/ws/wf.py', uri: 'file:///ws/wf.py', sessionId: 's1', selectedNodeIds: [] as string[] };

type Row = { sessionId: string; sourceUri: string; readOnly: boolean };

/** The diagram's GLSP-MCP tools: `session-info` lists `sessions` (one of the chat's file by default); every other call succeeds. */
function makeTools(sessions: Row[] = [{ sessionId: 'glsp_1', sourceUri: 'file:///ws/wf.py', readOnly: false }]) {
    const calls: Array<{ tool: string; args: any }> = [];
    return {
        calls,
        callTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
            calls.push({ tool, args });
            if (tool === 'session-info') {
                return { ok: true, text: '', structured: { sessions } };
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
        // The agent is told the diagram's session: its first call needs it.
        expect(result.prompt).toContain('This diagram\'s session is "glsp_1": pass it as sessionId to every untangle tool.');
        // Only the session is asked for before the agent's turn: no source capability gates it.
        expect(tools.calls).toEqual([{ tool: 'session-info', args: {} }]);
        // Its turn over, a try the agent left drawn and did not propose is drawn back.
        await result.afterTurn();
        expect(tools.calls.at(-1)).toEqual({ tool: 'untangle-end', args: { sessionId: 'glsp_1' } });
    });

    it('untangles the view the editor shows, navigated into a workflow of another file', async () => {
        // The editor of wf.py shows a nested workflow defined in place.py: its session draws place.py.
        const tools = makeTools([
            { sessionId: 'other', sourceUri: 'file:///ws/wf.py', readOnly: true },
            { sessionId: 'glsp_7', sourceUri: 'file:///ws/workflows/place.py', readOnly: false }
        ]);
        const provider = { getClientIdForDocumentUri: () => 'glsp_7' } as any;
        const result: any = await createUntangleCommand({ tools, getEditorProvider: () => provider }).handler!({}, CTX);
        expect(result.prompt).toContain('This diagram\'s session is "glsp_7"');
        await result.afterTurn();
        expect(tools.calls.at(-1)).toEqual({ tool: 'untangle-end', args: { sessionId: 'glsp_7' } });
    });

    it('untangles the diagram of the panel that sent it, of two editors on the file', async () => {
        // Editor B, used last, shows another file's workflow; the command was typed in editor A's panel.
        const tools = makeTools([
            { sessionId: 'glsp_A', sourceUri: 'file:///ws/wf.py', readOnly: false },
            { sessionId: 'glsp_B', sourceUri: 'file:///ws/workflows/place.py', readOnly: false }
        ]);
        const provider = { getClientIdForDocumentUri: () => 'glsp_B' } as any;
        const result: any = await createUntangleCommand({ tools, getEditorProvider: () => provider }).handler!({}, { ...CTX, diagramClientId: 'glsp_A' });
        expect(result.prompt).toContain('This diagram\'s session is "glsp_A"');
    });

    it('ends the session shown now when the one it untangled is gone', async () => {
        const rows = [{ sessionId: 'glsp_1', sourceUri: 'file:///ws/wf.py', readOnly: false }];
        const tools = makeTools(rows);
        const result: any = await createUntangleCommand({ tools, getEditorProvider: () => undefined }).handler!({}, CTX);
        // The editor reopened during the turn: a new session, and the old one answers no more.
        rows.splice(0, 1, { sessionId: 'glsp_2', sourceUri: 'file:///ws/wf.py', readOnly: false });
        tools.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            tools.calls.push({ tool, args });
            if (tool === 'session-info') {
                return { ok: true, text: '', structured: { sessions: rows } };
            }
            return tool === 'untangle-end' && args.sessionId === 'glsp_1' ? { ok: false, text: 'no session glsp_1' } : { ok: true, text: '' };
        });
        await result.afterTurn();
        expect(tools.calls.filter((c) => c.tool === 'untangle-end').map((c) => c.args.sessionId)).toEqual(['glsp_1', 'glsp_2']);
    });

    it('is refused where no diagram of the chat\'s file is open, or the tools do not answer', async () => {
        const none = await createUntangleCommand({ tools: makeTools([]), getEditorProvider: () => undefined }).handler!({}, CTX);
        expect(none).toEqual({ success: false, error: "The diagram's tools know no open diagram of this file to untangle." });
        const silent = { callTool: vi.fn(async () => ({ ok: false, text: 'connection refused' })) };
        const refused = await createUntangleCommand({ tools: silent, getEditorProvider: () => undefined }).handler!({}, CTX);
        expect(refused).toEqual({ success: false, error: 'connection refused' });
    });

    it('is offered where the platform\'s diagram module serves the diagram, with its tools on', () => {
        const provider = () => undefined;
        expect(platformChatCommands({}, makeTools(), provider).map((c) => c.command)).toEqual(['untangle']);
        // No diagram tools: nothing for the agent to untangle with.
        expect(platformChatCommands({}, undefined, provider)).toEqual([]);
        // A product's own diagram module binds no untangle tools (no Apply, no Free Ports, no layout file).
        expect(platformChatCommands({ serverDiagramModule: () => ({}) }, makeTools(), provider)).toEqual([]);
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
