/**
 * What the producer answered during one agent tool call, and only that call.
 *
 * The sink is one per session; two tool calls at once used to share it, so one's reset wiped the
 * other's answers before it read them, and every gesture outside any tool call was kept for good.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AgentEditOutcomeSink } from '../src/server/agent-edit-outcome';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AgentEditOutcomeSink', () => {
    it('keeps nothing while nobody collects', async () => {
        const sink = new AgentEditOutcomeSink();
        sink.record({ op: 'p.connect', ok: true });
        const { outcomes } = await sink.collect(async () => undefined);
        expect(outcomes).toEqual([]);
    });

    it('gives each call its own answers, when two run at once', async () => {
        const sink = new AgentEditOutcomeSink();
        let releaseFirst!: () => void;
        const first = sink.collect(async () => {
            sink.record({ op: 'p.connect', ok: true });
            await new Promise<void>(resolve => { releaseFirst = resolve; });
            sink.record({ op: 'p.connect', ok: false, message: 'taken' });
            return 'first';
        });
        const second = sink.collect(async () => {
            sink.record({ op: 'p.deleteNode', ok: true });
            return 'second';
        });
        await tick();
        releaseFirst();
        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual({ value: 'first', outcomes: [{ op: 'p.connect', ok: true }, { op: 'p.connect', ok: false, message: 'taken' }] });
        expect(b).toEqual({ value: 'second', outcomes: [{ op: 'p.deleteNode', ok: true }] });
    });

    it('lets the next call run after one that threw', async () => {
        const sink = new AgentEditOutcomeSink();
        await expect(sink.collect(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        const { value } = await sink.collect(async () => 'next');
        expect(value).toBe('next');
    });
});
