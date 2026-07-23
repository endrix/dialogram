import { describe, it, expect } from 'vitest';
import type { ExecutionOverlaySink } from '@dialogram/shared';
import { ExecutionOverlayRegistry, EXECUTION_EVENT_REPLAY_LIMIT } from '../src/extension/diagram/execution-overlay';
import { normalizeSourceUriKey } from '../src/extension/diagram/uri-keys';

describe('ExecutionOverlayRegistry', () => {
    it('publish/get/clear round-trip per source URI', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.publish('file:///a.py', [{ nodeId: 'n1', status: 'running' }]);
        expect(reg.get('file:///a.py')).toEqual([{ nodeId: 'n1', status: 'running' }]);
        expect(reg.get('file:///b.py')).toEqual([]);
        reg.clear('file:///a.py');
        expect(reg.get('file:///a.py')).toEqual([]);
    });

    it('notifies listeners on publish and on effective clear, with the URI', () => {
        const reg = new ExecutionOverlayRegistry();
        const seen: string[] = [];
        const sub = reg.onDidChange(uri => seen.push(uri));
        reg.publish('file:///a.py', [{ nodeId: 'n1', status: 'succeeded' }]);
        reg.clear('file:///a.py');
        reg.clear('file:///a.py');           // second clear: no state → no event
        sub.dispose();
        reg.publish('file:///a.py', [{ nodeId: 'n1', status: 'failed' }]);
        expect(seen).toEqual(['file:///a.py', 'file:///a.py']);
    });

    it('publish stores a copy — later caller mutation does not leak in', () => {
        const reg = new ExecutionOverlayRegistry();
        const states = [{ nodeId: 'n1', status: 'running' as const }];
        reg.publish('file:///a.py', states);
        states.push({ nodeId: 'n2', status: 'running' as const });
        expect(reg.get('file:///a.py')).toHaveLength(1);
    });

    it('emitEvents notifies onDidEmitEvents listeners with the URI and the exact array', () => {
        const reg = new ExecutionOverlayRegistry();
        const seen: Array<{ uri: string; events: unknown[] }> = [];
        const sub = reg.onDidEmitEvents((uri, events) => seen.push({ uri, events }));
        const batch: unknown[] = [{ type: 'agent.message.delta', delta: 'hi' }];
        reg.emitEvents('file:///a.py', batch);
        sub.dispose();
        expect(seen).toHaveLength(1);
        expect(seen[0].uri).toBe('file:///a.py');
        // Opaque, zero-copy pass-through: the listener receives the very array.
        expect(seen[0].events).toBe(batch);
    });

    it('disposed onDidEmitEvents listeners stop receiving', () => {
        const reg = new ExecutionOverlayRegistry();
        let count = 0;
        const sub = reg.onDidEmitEvents(() => { count += 1; });
        reg.emitEvents('file:///a.py', []);
        sub.dispose();
        reg.emitEvents('file:///a.py', []);
        expect(count).toBe(1);
    });

    it('satisfies the ExecutionOverlaySink write-side seam — emitEvents round-trips', () => {
        const reg = new ExecutionOverlayRegistry();
        const sink: ExecutionOverlaySink = reg;
        const seen: Array<{ uri: string; events: unknown[] }> = [];
        reg.onDidEmitEvents((uri, events) => seen.push({ uri, events }));
        const batch: unknown[] = [{ type: 'agent.message.delta', delta: 'hi' }];
        sink.emitEvents('file:///a.py', batch);
        sink.publish('file:///a.py', [{ nodeId: 'n1', status: 'running' }]);
        expect(seen).toEqual([{ uri: 'file:///a.py', events: batch }]);
        expect(reg.get('file:///a.py')).toEqual([{ nodeId: 'n1', status: 'running' }]);
    });

    it('emitEvents does not touch the states channel', () => {
        const reg = new ExecutionOverlayRegistry();
        const changed: string[] = [];
        reg.onDidChange(uri => changed.push(uri));
        reg.emitEvents('file:///a.py', [{ type: 'x' }]);
        // States channel untouched: no stored state, no onDidChange notification.
        expect(reg.get('file:///a.py')).toEqual([]);
        expect(changed).toEqual([]);
    });
});

describe('ExecutionOverlayRegistry — bounded replay buffer (Task 4)', () => {
    const uri = 'file:///w/wf.py';

    it('accumulates emitted events across batches and replays them per source URI', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.emitEvents(uri, [{ type: 'run.started' }, { type: 'agent.message.start', instance: 'n1' }]);
        reg.emitEvents(uri, [{ type: 'agent.message.delta', instance: 'n1', delta: 'hi' }]);
        expect(reg.replayEvents(uri)).toEqual([
            { type: 'run.started' },
            { type: 'agent.message.start', instance: 'n1' },
            { type: 'agent.message.delta', instance: 'n1', delta: 'hi' }
        ]);
        // Distinct source URIs keep independent windows.
        expect(reg.replayEvents('file:///other.py')).toEqual([]);
    });

    it('a run.started RESETS the window — replay carries only the current run, anchored at run.started', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.emitEvents(uri, [{ type: 'run.started' }, { type: 'agent.message.delta', instance: 'n1', delta: 'old' }]);
        reg.emitEvents(uri, [{ type: 'run.started' }, { type: 'agent.message.delta', instance: 'n2', delta: 'new' }]);
        const window = reg.replayEvents(uri);
        expect(window).toEqual([
            { type: 'run.started' },
            { type: 'agent.message.delta', instance: 'n2', delta: 'new' }
        ]);
        expect((window[0] as { type: string }).type).toBe('run.started');
    });

    it('a run.started mid-batch resets, keeping only the tail from the anchor', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.emitEvents(uri, [
            { type: 'run.started' },
            { type: 'agent.message.delta', instance: 'n1', delta: 'a' },
            { type: 'run.started' },
            { type: 'agent.message.delta', instance: 'n2', delta: 'b' }
        ]);
        expect(reg.replayEvents(uri)).toEqual([
            { type: 'run.started' },
            { type: 'agent.message.delta', instance: 'n2', delta: 'b' }
        ]);
    });

    it('caps the window at EXECUTION_EVENT_REPLAY_LIMIT — anchor-preserving (keeps run.started + oldest)', () => {
        const reg = new ExecutionOverlayRegistry();
        const batch: unknown[] = [{ type: 'run.started', seq: 0 }];
        for (let i = 1; i <= 400; i += 1) {
            batch.push({ type: 'agent.message.delta', instance: 'n1', delta: 'z', seq: i });
        }
        reg.emitEvents(uri, batch);
        const window = reg.replayEvents(uri);
        expect(window).toHaveLength(EXECUTION_EVENT_REPLAY_LIMIT);
        // Anchor retained as the first entry; overflow tail shed (oldest kept).
        expect((window[0] as { type: string }).type).toBe('run.started');
        expect((window[1] as { seq: number }).seq).toBe(1);
        expect((window.at(-1) as { seq: number }).seq).toBe(EXECUTION_EVENT_REPLAY_LIMIT - 1);
    });

    it('replayEvents returns a copy — mutating it does not corrupt the stored window', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.emitEvents(uri, [{ type: 'run.started' }]);
        const copy = reg.replayEvents(uri);
        copy.push({ type: 'agent.message.delta' });
        expect(reg.replayEvents(uri)).toHaveLength(1);
    });

    it('clear(uri) drops the replay window', () => {
        const reg = new ExecutionOverlayRegistry();
        reg.emitEvents(uri, [{ type: 'run.started' }, { type: 'agent.message.delta', instance: 'n1', delta: 'x' }]);
        reg.clear(uri);
        expect(reg.replayEvents(uri)).toEqual([]);
    });

    it('still hands the EXACT array to live listeners (zero-copy live path preserved)', () => {
        const reg = new ExecutionOverlayRegistry();
        const seen: unknown[][] = [];
        reg.onDidEmitEvents((_uri, events) => seen.push(events));
        const batch: unknown[] = [{ type: 'run.started' }];
        reg.emitEvents(uri, batch);
        expect(seen[0]).toBe(batch);
    });
});

describe('ExecutionOverlayRegistry — replay key unification (Task-4 review M2)', () => {
    it('replay hits when emit and lookup use different URI forms that canonicalize equal (injected keyer)', () => {
        // The buffer keys through the injected normalizer, so an emit form and a
        // lookup form that map to the same key resolve to the same window — the
        // production divergence (run driver emits one form, provider replays
        // another) can no longer miss the replay.
        const keyOf = (u: string): string => u.replace(/\/\.\//g, '/'); // collapse "/./"
        const reg = new ExecutionOverlayRegistry(keyOf);
        reg.emitEvents('file:///w/./wf.py', [{ type: 'run.started' }, { type: 'agent.message.start', instance: 'n1' }]);
        // Fed one form, looked up with a variant that canonicalizes equal.
        expect(reg.replayEvents('file:///w/wf.py')).toEqual([
            { type: 'run.started' },
            { type: 'agent.message.start', instance: 'n1' }
        ]);
    });

    it('uses the host-canonical normalizeSourceUriKey so the provider and the buffer agree', () => {
        // Production topology: the SAME function the editor provider keys its
        // client/URI maps on is the buffer keyer here.
        const reg = new ExecutionOverlayRegistry(normalizeSourceUriKey);
        reg.emitEvents('file:///w/./wf.py', [{ type: 'run.started' }, { type: 'agent.message.delta', delta: 'x' }]);
        const replayed = reg.replayEvents('file:///w/wf.py');
        expect(replayed).toEqual([{ type: 'run.started' }, { type: 'agent.message.delta', delta: 'x' }]);
        // Sanity: the two forms really are distinct raw strings but one canonical key.
        expect('file:///w/./wf.py').not.toBe('file:///w/wf.py');
        expect(normalizeSourceUriKey('file:///w/./wf.py')).toBe(normalizeSourceUriKey('file:///w/wf.py'));
    });

    it('clear canonicalizes too — a variant form drops the same window', () => {
        const reg = new ExecutionOverlayRegistry(normalizeSourceUriKey);
        reg.emitEvents('file:///w/wf.py', [{ type: 'run.started' }]);
        reg.clear('file:///w/./wf.py');
        expect(reg.replayEvents('file:///w/wf.py')).toEqual([]);
    });
});
