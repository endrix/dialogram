/**
 * A profile's status source: node states from a report, asked for and shown,
 * without a run driver.
 *
 * Pinned against the real execution-overlay registry (the sink a run driver
 * gets as `DiagramRunHost.overlay`) and a fake host: Show collects for the
 * diagram it is invoked on and publishes the answer as the whole set; a
 * failure says so and leaves the diagram as it was; Clear takes the states off
 * and wins over a Show still running; two Shows at once share one collect.
 * The answer crosses the extension API, so it is checked before it is sent.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionNodeState } from '@dialogram/shared';
import type { DiagramStatusSource } from '../src/api';
import { ExecutionOverlayRegistry } from '../src/extension/diagram/execution-overlay';
import {
    registerStatusSource,
    statesFromCollect,
    summarizeStates,
    type StatusSourceHost
} from '../src/extension/diagram/status-source';

const DIAGRAM = { sourceUri: 'file:///spec/docs/pipeline.md', file: '/spec/docs/pipeline.md' };

/** A host whose commands, messages and output are recorded; the active diagram is `active`, `null` for none. */
function fakeHost(active: typeof DIAGRAM | null = DIAGRAM) {
    const overlay = new ExecutionOverlayRegistry();
    const commands = new Map<string, (arg?: unknown) => unknown>();
    const errors: string[] = [];
    const warnings: string[] = [];
    const status: string[] = [];
    const output: string[] = [];
    const host: StatusSourceHost = {
        targetOf: (arg) => (typeof arg === 'string' ? { sourceUri: arg, file: arg.replace('file://', '') } : active ?? undefined),
        overlay,
        output: { appendLine: (line: string) => output.push(line) } as any,
        registerCommand: (id, handler) => {
            commands.set(id, handler);
            return { dispose: () => commands.delete(id) };
        },
        withProgress: (_title, task) => task(),
        showError: (message) => errors.push(message),
        showWarning: (message) => warnings.push(message),
        setStatusMessage: (message) => status.push(message)
    };
    const run = (id: string, arg?: unknown) => Promise.resolve(commands.get(id)!(arg));
    return { host, overlay, commands, errors, warnings, status, output, run };
}

function source(collect: DiagramStatusSource['collect']): DiagramStatusSource {
    return { label: 'Coverage', showCommand: 'product.coverage.show', clearCommand: 'product.coverage.clear', collect };
}

const REPORT: ExecutionNodeState[] = [
    { nodeId: 'node:scope:root:A-001', status: 'failed', detail: 'unverified' },
    { nodeId: 'node:scope:root:A-002', status: 'succeeded' },
    { nodeId: 'node:scope:root:Q-001', status: 'running' }
];

describe('a status source', () => {
    it('registers its two commands, and disposing takes them back', () => {
        const { host, commands } = fakeHost();
        const registration = registerStatusSource(source(async () => []), host);

        expect([...commands.keys()]).toEqual(['product.coverage.show', 'product.coverage.clear']);
        registration.dispose();
        expect(commands.size).toBe(0);
    });

    it('shows what collect answers for the active diagram, as the whole set', async () => {
        const { host, overlay, run, status } = fakeHost();
        const asked: string[] = [];
        registerStatusSource(source(async (file) => {
            asked.push(file);
            return REPORT;
        }), host);

        expect(await run('product.coverage.show')).toBe(true);

        expect(asked).toEqual([DIAGRAM.file]);
        expect(overlay.get(DIAGRAM.sourceUri)).toEqual(REPORT);
        expect(status).toEqual(['Coverage: 1 succeeded, 1 failed, 1 running']);
    });

    it('acts on the diagram it is given, as an editor-title menu gives it', async () => {
        const { host, overlay, run } = fakeHost(null);
        registerStatusSource(source(async () => REPORT), host);

        await run('product.coverage.show', 'file:///spec/docs/other.md');

        expect(overlay.get('file:///spec/docs/other.md')).toEqual(REPORT);
    });

    it('replaces the states shown, so a node no longer reported loses its mark', async () => {
        const { host, overlay, run } = fakeHost();
        let answer = REPORT;
        registerStatusSource(source(async () => answer), host);

        await run('product.coverage.show');
        answer = [{ nodeId: 'node:scope:root:A-001', status: 'succeeded' }];
        await run('product.coverage.show');

        expect(overlay.get(DIAGRAM.sourceUri)).toEqual(answer);
    });

    it('reports a failure and leaves what is shown as it was', async () => {
        const { host, overlay, run, errors, output } = fakeHost();
        let fail = false;
        registerStatusSource(source(async () => {
            if (fail) {
                throw new Error('ndf build wrote no index');
            }
            return REPORT;
        }), host);
        await run('product.coverage.show');
        fail = true;

        expect(await run('product.coverage.show')).toBe(false);

        expect(errors).toEqual(['Coverage failed: ndf build wrote no index']);
        expect(output).toContain('[Coverage] failed: ndf build wrote no index');
        expect(overlay.get(DIAGRAM.sourceUri)).toEqual(REPORT);
    });

    it('says there is no diagram rather than collecting for none', async () => {
        const { host, run, warnings } = fakeHost(null);
        let asked = false;
        registerStatusSource(source(async () => {
            asked = true;
            return [];
        }), host);

        expect(await run('product.coverage.show')).toBe(false);

        expect(asked).toBe(false);
        expect(warnings[0]).toContain('No diagram to show Coverage on');
    });

    it('clears the states, and only them', async () => {
        const { host, overlay, run } = fakeHost();
        const events: unknown[] = [{ type: 'run.started' }];
        overlay.emitEvents(DIAGRAM.sourceUri, events);
        registerStatusSource(source(async () => REPORT), host);
        await run('product.coverage.show');

        expect(await run('product.coverage.clear')).toBe(true);

        expect(overlay.get(DIAGRAM.sourceUri)).toEqual([]);
        // A run's replay window is not the status source's to drop.
        expect(overlay.replayEvents(DIAGRAM.sourceUri)).toEqual(events);
    });

    it('lets a Clear win over a Show still collecting', async () => {
        const { host, overlay, run, output } = fakeHost();
        let answer!: (states: ExecutionNodeState[]) => void;
        registerStatusSource(source(() => new Promise(resolve => (answer = resolve))), host);

        const shown = run('product.coverage.show');
        await run('product.coverage.clear');
        answer(REPORT);

        expect(await shown).toBe(false);
        expect(overlay.get(DIAGRAM.sourceUri)).toEqual([]);
        expect(output).toContain('[Coverage] cleared while it ran; not shown');
    });

    it('shares one collect between two Shows at once', async () => {
        const { host, run } = fakeHost();
        let calls = 0;
        let answer!: (states: ExecutionNodeState[]) => void;
        registerStatusSource(source(() => {
            calls += 1;
            return new Promise(resolve => (answer = resolve));
        }), host);

        const first = run('product.coverage.show');
        const second = run('product.coverage.show');
        answer(REPORT);

        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(calls).toBe(1);
    });
});

describe('the answer, checked', () => {
    it('keeps well-formed states and drops the rest', () => {
        expect(statesFromCollect([
            { nodeId: 'a', status: 'failed', detail: 'why' },
            { nodeId: 'b', status: 'idle' },
            { nodeId: '', status: 'failed' },
            { nodeId: 'c', status: 'green' },
            { status: 'running' },
            null,
            { nodeId: 'd', status: 'running', detail: 7 }
        ])).toEqual([
            { nodeId: 'a', status: 'failed', detail: 'why' },
            { nodeId: 'b', status: 'idle' },
            { nodeId: 'd', status: 'running' }
        ]);
    });

    it('is an error when it is not a list', () => {
        expect(() => statesFromCollect(undefined)).toThrow(/no list of node states/);
        expect(() => statesFromCollect({ states: [] })).toThrow(/no list of node states/);
    });

    it('is summed up by status, idle left out', () => {
        expect(summarizeStates('Coverage', [])).toBe('Coverage: nothing to show');
        expect(summarizeStates('Checks', [
            { nodeId: 'a', status: 'failed' },
            { nodeId: 'b', status: 'failed' },
            { nodeId: 'c', status: 'idle' }
        ])).toBe('Checks: 2 failed');
    });
});
