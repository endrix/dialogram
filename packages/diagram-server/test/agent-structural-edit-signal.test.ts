import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AgentStructuralEditSignal } from '../src/server/agent-structural-edit-signal';

describe('AgentStructuralEditSignal', () => {
    it('starts down and reads pending after markPending', () => {
        const signal = new AgentStructuralEditSignal();
        expect(signal.isPending()).toBe(false);
        signal.markPending();
        expect(signal.isPending()).toBe(true);
    });

    it('consumePending returns the prior state and lowers the flag', () => {
        const signal = new AgentStructuralEditSignal();
        signal.markPending();
        expect(signal.consumePending()).toBe(true);
        expect(signal.isPending()).toBe(false);
        // Second consume is a no-op that reports nothing was owed.
        expect(signal.consumePending()).toBe(false);
    });

    it('two instances are independent (session isolation)', () => {
        const a = new AgentStructuralEditSignal();
        const b = new AgentStructuralEditSignal();
        a.markPending();
        expect(a.isPending()).toBe(true);
        expect(b.isPending()).toBe(false);
    });
});
