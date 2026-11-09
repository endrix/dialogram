// Breadcrumb split: run-history is reported as its own `runHistory=` phase, distinct from the
// `overlaysRest` residual (skill-status + skills + agents snapshots).
//
// Previously the whole overlay tail after the two dominant readers landed in one `overlaysRest`
// bucket, so a spike there could not be attributed to a specific overlay phase from the log alone.
// Splitting `runHistory` out lets the next live breadcrumb pinpoint whether the run-history
// enumeration is the cost — or whether the phase was merely starved by background work.
import { describe, expect, it, vi } from 'vitest';
import { GraphLoadPerf } from '../src/server/graph-load-perf';

function captureBreadcrumb(spans: Array<[string, number]>): string {
    const perf = new (GraphLoadPerf as any)('demo.py');
    // Inject deterministic per-phase spans (the real marks derive from wall-clock deltas).
    (perf as any).spans.push(...spans);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    perf.emitOpenBreadcrumb(1, { nodes: 3, edges: 2 });
    const line = String(logSpy.mock.calls[0]?.[0] ?? '');
    logSpy.mockRestore();
    return line;
}

describe('open breadcrumb: runHistory phase split', () => {
    it('reports runHistory as its own field', () => {
        // ov:skills is now its own `skills=` phase (not folded into overlaysRest), and run-history
        // stays distinct; overlaysRest is the residual (0 here — every span is bucketed).
        const line = captureBreadcrumb([['ov:history', 111], ['ov:agentCtx', 22]]);
        expect(line).toContain('runHistory=111ms');
        expect(line).toContain('agentCtx=22ms');
        expect(line).toContain('overlaysRest=0ms');
    });

    it('does not fold run-history back into overlaysRest', () => {
        // Only an ov:history span → overlaysRest must be zero, runHistory carries the cost.
        const line = captureBreadcrumb([['ov:history', 240]]);
        expect(line).toContain('runHistory=240ms');
        expect(line).toContain('overlaysRest=0ms');
    });

    it('reports no agent-enrichment phases: the platform no longer discovers skills and presets', () => {
        const line = captureBreadcrumb([['ov:history', 3]]);
        expect(line).not.toMatch(/skillStatus=|skills=|agents=|enrichment=/);
    });

    it('folds only unbucketed ov:* spans into overlaysRest', () => {
        const line = captureBreadcrumb([['ov:history', 4], ['ov:somethingNew', 6]]);
        expect(line).toContain('runHistory=4ms');
        expect(line).toContain('overlaysRest=6ms');
    });
});
