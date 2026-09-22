import { describe, expect, it } from 'vitest';
import { formatAgentOutputs, looksLikeDiff, isBlock, parseEmbedded } from '../src/agent-outputs';

/** The shape the runtime reports when an agent writes its ports. */
const planner = JSON.stringify({
    outputs: {
        Next: JSON.stringify({
            front_options: 'ftd=auto',
            handshake_options: 'decision-slots=4 ready-slots-outside-loops=true',
            model_patch: '--- a/core/cpu.py\n+++ b/core/cpu.py\n@@ -704,7 +704,7 @@\n-        cmd = MemCmd.Prefetch(nxt)\n+        cmd = MemCmd.Ifetch(nxt)\n',
            reason: 'Launch issues Ifetch instead of Prefetch, decoupling decode from the register read.',
            stop: false
        })
    }
});

describe('formatAgentOutputs', () => {
    it('leaves anything that is not an outputs object alone', () => {
        expect(formatAgentOutputs('Round 3 looks good to me.')).toBeNull();
        expect(formatAgentOutputs('{"not_outputs": 1}')).toBeNull();
        expect(formatAgentOutputs('{"outputs": "a string"}')).toBeNull();
        expect(formatAgentOutputs('{"outputs": {} }')).toBeNull();
        expect(formatAgentOutputs('{"outputs": {')).toBeNull();
    });

    it('names each port as a heading', () => {
        expect(formatAgentOutputs(planner)).toContain('### Next');
    });

    it('unescapes the diff and fences it for colouring', () => {
        const out = formatAgentOutputs(planner)!;
        expect(out).toContain('```diff');
        expect(out).toContain('+        cmd = MemCmd.Ifetch(nxt)');
        expect(out).not.toContain('\\n');
    });

    it('puts scalars on their own lines and prose without backticks', () => {
        const out = formatAgentOutputs(planner)!;
        expect(out).toContain('- **front_options** `ftd=auto`');
        expect(out).toContain('- **stop** `false`');
        expect(out).toContain('- **reason** Launch issues Ifetch');
    });

    it('reads the short fields before the long ones', () => {
        const out = formatAgentOutputs(planner)!;
        expect(out.indexOf('front_options')).toBeLessThan(out.indexOf('model_patch'));
    });

    it('survives a value that is not JSON, and one that carries backticks', () => {
        const plain = JSON.stringify({ outputs: { Log: 'nothing to report' } });
        expect(formatAgentOutputs(plain)).toContain('nothing to report');
        const ticks = JSON.stringify({ outputs: { Note: JSON.stringify({ body: 'a\n```\nfence\n```\ninside' }) } });
        const out = formatAgentOutputs(ticks)!;
        expect(out).toContain('````');
    });
});

describe('the helpers the property panel shares', () => {
    it('knows a diff from prose, and from a bullet list', () => {
        expect(looksLikeDiff('--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b')).toBe(true);
        expect(looksLikeDiff('@@ -704,7 +704,7 @@\n-old\n+new')).toBe(true);
        expect(looksLikeDiff('- one\n- two\n- three')).toBe(false);
        expect(looksLikeDiff('a short reason.')).toBe(false);
    });

    it('unwraps a port value that is itself JSON, and leaves other strings alone', () => {
        expect(parseEmbedded('{"a": 1}')).toEqual({ a: 1 });
        expect(parseEmbedded('[1, 2]')).toEqual([1, 2]);
        expect(parseEmbedded('not json')).toBe('not json');
        expect(parseEmbedded('{ broken')).toBe('{ broken');
        expect(parseEmbedded(7)).toBe(7);
    });

    it('calls a value a block when it has newlines or runs long', () => {
        expect(isBlock('one\ntwo')).toBe(true);
        expect(isBlock('x'.repeat(200))).toBe(true);
        expect(isBlock('ftd=auto')).toBe(false);
    });
});
