import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AgentStructuralEditSignal } from '../src/server/agent-structural-edit-signal';

describe('AgentStructuralEditSignal', () => {
    it('starts down and is NOT pending until a reload follows the mark', () => {
        const signal = new AgentStructuralEditSignal();
        expect(signal.isPending()).toBe(false);
        signal.markPending();
        // Marked but not yet reload-confirmed: a submit with no intervening reload (the premature
        // post-operation submit) must NOT see it as pending.
        expect(signal.isPending()).toBe(false);
        signal.noteSourceReloaded();
        // The reload that carries the edit makes it consumable.
        expect(signal.isPending()).toBe(true);
    });

    it('the premature post-op submit cannot consume a not-yet-reloaded edit', () => {
        const signal = new AgentStructuralEditSignal();
        signal.markPending();
        // Post-op submit runs on the not-yet-reloaded model → nothing owed, flag survives.
        expect(signal.consumePending()).toBe(false);
        // Watcher reload arrives, carrying the edit.
        signal.noteSourceReloaded();
        expect(signal.consumePending()).toBe(true);
        // Second consume after the same reload is a no-op.
        expect(signal.consumePending()).toBe(false);
    });

    it('a reload BEFORE any edit never arms the flag', () => {
        const signal = new AgentStructuralEditSignal();
        // Fresh-open load(s) with no agent edit.
        signal.noteSourceReloaded();
        signal.noteSourceReloaded();
        expect(signal.isPending()).toBe(false);
        expect(signal.consumePending()).toBe(false);
    });

    it('coalesces multiple edits before one reload into a single pending consume', () => {
        const signal = new AgentStructuralEditSignal();
        signal.markPending(); // create-nodes
        signal.markPending(); // create-edges (same load generation)
        expect(signal.isPending()).toBe(false);
        signal.noteSourceReloaded(); // one coalesced watcher reload
        expect(signal.consumePending()).toBe(true);
        expect(signal.consumePending()).toBe(false);
    });

    it('two instances are independent (session isolation)', () => {
        const a = new AgentStructuralEditSignal();
        const b = new AgentStructuralEditSignal();
        a.markPending();
        a.noteSourceReloaded();
        expect(a.isPending()).toBe(true);
        expect(b.isPending()).toBe(false);
    });
});
