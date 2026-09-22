// The live run viewer renders an agent's parts, not the session timeline, so
// formatting the outputs object in the timeline left this view showing the
// raw escaped JSON — which is what the IDE still displayed. A text part must
// format an outputs object and leave ordinary text as typed.
//
// The markdown module is mocked because it sanitizes through DOMPurify, which
// needs a DOM; these tests are about which branch is taken and what reaches
// the renderer, not about the HTML it produces.
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/markdown', () => ({
    renderMarkdownSafe: (src: string) => `<rendered>${src}</rendered>`,
    renderInlineMarkdownSafe: (src: string) => src,
    looksLikeMarkdown: () => true
}));

const { ChatPanel } = await import('../src/chat-panel-integrated');

function part(text: string): { strings: string; values: unknown[] } {
    const panel = new ChatPanel();
    const tpl = (panel as any).partTemplate({ kind: 'text', text }, false);
    return { strings: (tpl.strings as ReadonlyArray<string>).join('|'), values: tpl.values };
}

const answer = JSON.stringify({
    outputs: { Answer: JSON.stringify({ question: 'why?', answer: 'pipelining', declined: false }) }
});

describe('a text part in the live run viewer', () => {
    it('formats an outputs object rather than showing the escaped JSON', () => {
        const { strings, values } = part(answer);
        expect(strings).toContain('chat-run-outputs');
        const rendered = JSON.stringify(values);
        expect(rendered).toContain('### Answer');
        expect(rendered).toContain('pipelining');
        expect(rendered).not.toContain('\\\\"question\\\\"');
    });

    it('leaves ordinary agent text as typed', () => {
        const text = 'Reading the register file now.';
        const { strings, values } = part(text);
        expect(strings).not.toContain('chat-run-outputs');
        expect(values).toContain(text);
    });
});
