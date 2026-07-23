/**
 * Integrated chat panel — live diagram selection → chat context.
 *
 * The panel implements GLSP's `ISelectionListener`: on every selection change it
 * tracks the node ids, posts `chat.selection { selectedNodeIds }` to the host
 * (which mirrors it into the ChatRuntime's per-file selection map), and carries
 * the current selection on `chat.sendMessage`.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/chat-panel-integrated';

function makePanel() {
    const sent: Array<{ method: string; env: any }> = [];
    const panel = new ChatPanel();
    (panel as any).channel = {
        sendToHost: (method: string, env: any) => sent.push({ method, env })
    };
    (globalThis as any).diagramIdentifier = { uri: 'file:///ws/wf.py' };
    return { panel, sent };
}

describe('ChatPanel selection', () => {
    it('posts chat.selection with the node ids on every selection change', () => {
        const { panel, sent } = makePanel();
        panel.selectionChanged(undefined, ['n1', 'n2']);
        const msg = sent.find(s => s.env?.type === 'chat.selection');
        expect(msg).toBeDefined();
        expect(msg!.env.data.selectedNodeIds).toEqual(['n1', 'n2']);
        expect(msg!.env.data.workflowUri).toBe('file:///ws/wf.py');
    });

    it('clears the selection with an empty list', () => {
        const { panel, sent } = makePanel();
        panel.selectionChanged(undefined, ['n1']);
        panel.selectionChanged(undefined, []);
        const last = sent.filter(s => s.env?.type === 'chat.selection').at(-1);
        expect(last!.env.data.selectedNodeIds).toEqual([]);
    });

    it('sendMessage carries the current selection', () => {
        const { panel, sent } = makePanel();
        panel.selectionChanged(undefined, ['n7']);
        (panel as any).inputValue = 'explain this node';
        (panel as any).sendMessage();
        const msg = sent.find(s => s.env?.type === 'chat.sendMessage');
        expect(msg!.env.data.selectedNodeIds).toEqual(['n7']);
    });
});
