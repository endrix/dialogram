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
    it('reports runHistory and the enrichment phases as separate fields', () => {
        // ov:skills is now its own `skills=` phase (not folded into overlaysRest), and run-history
        // stays distinct; overlaysRest is the residual (0 here — every span is bucketed).
        const line = captureBreadcrumb([['ov:history', 111], ['ov:skills', 22]]);
        expect(line).toContain('runHistory=111ms');
        expect(line).toContain('skills=22ms');
        expect(line).toContain('overlaysRest=0ms');
    });

    it('does not fold run-history back into overlaysRest', () => {
        // Only an ov:history span → overlaysRest must be zero, runHistory carries the cost.
        const line = captureBreadcrumb([['ov:history', 240]]);
        expect(line).toContain('runHistory=240ms');
        expect(line).toContain('overlaysRest=0ms');
    });

    it('splits skill-status, skills, and agents into their own phases (overlaysRest stays the residual)', () => {
        // Post-deferral: each enrichment phase is named on the breadcrumb and overlaysRest is the true
        // residual — any ov:* span not bucketed above — which is 0 here since all spans are bucketed.
        const line = captureBreadcrumb([['ov:skillStatus', 5], ['ov:skills', 7], ['ov:agents', 9]]);
        expect(line).toContain('skillStatus=5ms');
        expect(line).toContain('skills=7ms');
        expect(line).toContain('agents=9ms');
        expect(line).toContain('overlaysRest=0ms');
        expect(line).toContain('runHistory=0ms');
    });

    it('folds only unbucketed ov:* spans into overlaysRest', () => {
        const line = captureBreadcrumb([['ov:skills', 4], ['ov:somethingNew', 6]]);
        expect(line).toContain('skills=4ms');
        expect(line).toContain('overlaysRest=6ms');
    });

    it('reports the enrichment outcome field', () => {
        const perf = new (GraphLoadPerf as any)('demo.py');
        perf.setEnrichment('deferred');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        perf.emitOpenBreadcrumb(1, { nodes: 3, edges: 2 });
        const line = String(logSpy.mock.calls[0]?.[0] ?? '');
        logSpy.mockRestore();
        expect(line).toContain('enrichment=deferred');
    });
});
