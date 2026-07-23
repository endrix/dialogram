/**
 * Graph-load performance instrumentation
 *
 * Opt-in per-load timing for the diagram graph-load pipeline. Extracted verbatim from
 * diagram-glsp-module.ts.
 */

/** Opt-in graph-load profiling: set WORKFLOW_PERF=1 (anything but 0/false) to enable. */
export const PERF_ENABLED = (() => {
    const v = process.env.WORKFLOW_PERF;
    return !!v && v !== '0' && v.toLowerCase() !== 'false';
})();
if (PERF_ENABLED) {
    // One-time confirmation so it is obvious the flag took effect, even before the first
    // diagram load. If you do NOT see this line, WORKFLOW_PERF was not set in the host env.
    // eslint-disable-next-line no-console
    console.log('[perf] WORKFLOW_PERF enabled — per-load timing active');
}

/** High-resolution monotonic clock (ms), used by the perf instrumentation. */
export function perfNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

/**
 * Cumulative per-file build counter for the always-on open breadcrumb. Lets you eyeball, in the
 * dev host, whether a single diagram open triggers more than one model build (spawn + transform):
 * open a file once, count the `[dialogram perf] load <file>#N` lines that follow. Keyed by the
 * absolute workflow file path; monotonic for the life of the extension-host process.
 */
const buildCounts = new Map<string, number>();
export function nextBuildCount(file: string): number {
    const n = (buildCounts.get(file) ?? 0) + 1;
    buildCounts.set(file, n);
    return n;
}

/**
 * Per-load timer that records the duration of each pipeline stage (extraction → submit) and
 * emits a single summary line to the diagram-server console. No-op (near-zero cost) unless
 * WORKFLOW_PERF is set, so it is safe to leave the marks in the hot path.
 */
export class GraphLoadPerf {
    private readonly startedAt: number;
    private lastAt: number;
    private readonly spans: Array<[string, number]> = [];
    /**
     * Caller-reference phase outcome for the open breadcrumb: either the synchronous inclusion cost
     * in ms (a warm-cache hit) or the sentinel `'deferred'` (cold cache — discovery was moved off
     * the first-load critical path and will arrive via a background refresh). Undefined until set.
     */
    private callersInfo?: string;
    /**
     * Agent-enrichment phase outcome for the open breadcrumb: either the synchronous warm-cache
     * apply cost in ms or the sentinel `'deferred'` (cold cache — the skill-status/skills/agents
     * discovery was moved off the first-load critical path and will arrive via a background
     * refresh). Undefined until set. Mirrors {@link callersInfo}.
     */
    private enrichmentInfo?: string;
    constructor(private readonly label: string) {
        this.startedAt = this.lastAt = GraphLoadPerf.now();
    }
    /** Record the caller-reference phase outcome surfaced on the open breadcrumb. */
    setCallers(info: number | 'deferred'): void {
        this.callersInfo = typeof info === 'number' ? `${Math.round(info)}ms` : info;
    }
    /** Record the agent-enrichment (skill-status/skills/agents) phase outcome for the breadcrumb. */
    setEnrichment(info: number | 'deferred'): void {
        this.enrichmentInfo = typeof info === 'number' ? `${Math.round(info)}ms` : info;
    }
    private static now(): number {
        return perfNow();
    }
    mark(name: string): void {
        // Always record: the per-stage spans feed the always-on `emitOpenBreadcrumb` summary, not
        // just the WORKFLOW_PERF detailed line. `perfNow()` is a cheap monotonic read (a handful of
        // calls per load), so leaving marks un-gated has negligible cost in the hot path.
        const t = GraphLoadPerf.now();
        this.spans.push([name, t - this.lastAt]);
        this.lastAt = t;
    }
    /** Roll the recorded spans up into the coarse buckets the open breadcrumb reports. */
    /**
     * Roll the recorded spans up into the phase buckets the open breadcrumb reports. Every stage of
     * `finishLoadFromDoc` maps to exactly one bucket so the reported phases account for the whole
     * load: `misc` is computed by the caller as `total − Σ(named buckets)`, catching the post-submit
     * tail plus any span whose mark name is not yet bucketed here (a newly added mark lands in
     * `misc` rather than vanishing). Overlay work is split into its dominant readers
     * (`viewerOverlay`, `agentCtx`, `runHistory`) and the three agent-enrichment phases
     * (`skillStatus`, `skills`, `agents`); `overlaysRest` is the true residual — any `ov:*` span not
     * bucketed above — and should now approach 0 (enrichment is deferred off cold loads).
     */
    private summarize(): {
        acquireMs: number;
        relationshipsMs: number;
        transformMs: number;
        layoutMs: number;
        convertMs: number;
        defRangeMs: number;
        callerScanMs: number;
        viewerOverlayMs: number;
        agentCtxMs: number;
        runHistoryMs: number;
        skillStatusMs: number;
        skillsMs: number;
        agentsMs: number;
        overlaysRestMs: number;
        totalMs: number;
    } {
        let acquireMs = 0;
        let relationshipsMs = 0;
        let transformMs = 0;
        let layoutMs = 0;
        let convertMs = 0;
        let defRangeMs = 0;
        let callerScanMs = 0;
        let viewerOverlayMs = 0;
        let agentCtxMs = 0;
        let runHistoryMs = 0;
        let skillStatusMs = 0;
        let skillsMs = 0;
        let agentsMs = 0;
        let overlaysRestMs = 0;
        for (const [name, ms] of this.spans) {
            if (name === 'acquire') { acquireMs += ms; }
            else if (name === 'relInfo') { relationshipsMs += ms; }
            else if (name === 'transform') { transformMs += ms; }
            else if (name === 'layoutIO') { layoutMs += ms; }
            else if (name === 'convert') { convertMs += ms; }
            else if (name === 'wfRange') { defRangeMs += ms; }
            else if (name === 'callerRefs') { callerScanMs += ms; }
            else if (name === 'ov:viewer') { viewerOverlayMs += ms; }
            else if (name === 'ov:agentCtx') { agentCtxMs += ms; }
            else if (name === 'ov:history') { runHistoryMs += ms; }
            else if (name === 'ov:skillStatus') { skillStatusMs += ms; }
            else if (name === 'ov:skills') { skillsMs += ms; }
            else if (name === 'ov:agents') { agentsMs += ms; }
            else if (name.startsWith('ov:')) { overlaysRestMs += ms; }
        }
        return {
            acquireMs,
            relationshipsMs,
            transformMs,
            layoutMs,
            convertMs,
            defRangeMs,
            callerScanMs,
            viewerOverlayMs,
            agentCtxMs,
            runHistoryMs,
            skillStatusMs,
            skillsMs,
            agentsMs,
            overlaysRestMs,
            totalMs: GraphLoadPerf.now() - this.startedAt,
        };
    }
    /**
     * Always-on one-line breadcrumb for the server-side build cost of a single diagram load. Every
     * phase is reported so the numbers sum to `loadTotal` (the trailing `misc` is the remainder, so
     * `acquire + … + overlaysRest + misc === loadTotal`). Phase key:
     *  - `acquire`       spawn/model-source acquisition (getGraph + fallbacks)
     *  - `relationships` analyzeWorkflowRelationships (source read + workflow/caller parse)
     *  - `transform`     graph → diagram-model transform
     *  - `layout`        persisted layout + edge-route reads
     *  - `convert`       diagram-model → GModel conversion
     *  - `defRange`      workflow-definition source-range resolution
     *  - `callerScan`    synchronous caller-reference peek (the walk itself is the `callers` field)
     *  - `viewerOverlay` latest viewer-overlay scan/apply (edges)
     *  - `agentCtx`      agent-context scan/apply (nodes)
     *  - `runHistory`    run-history enumeration (resolve run-output dirs + read run logs)
     *  - `skillStatus`   per-node agent skill-status apply (warm-cache; deferred off cold loads)
     *  - `skills`        agent-skills picker snapshot apply (warm-cache; deferred off cold loads)
     *  - `agents`        Claude-agents picker snapshot apply (warm-cache; deferred off cold loads)
     *  - `overlaysRest`  residual `ov:*` not bucketed above (should approach 0)
     *  - `misc`          post-submit tail and any not-yet-bucketed span
     * ELK layout and edge reroute run later, in the client-bounds round-trip (see
     * WorkflowModelSubmissionHandler), so they are reported on a separate `[dialogram perf] layout
     * ...` line rather than folded in here.
     */
    emitOpenBreadcrumb(build: number, extra: { nodes: number; edges: number }): void {
        const s = this.summarize();
        const accounted = s.acquireMs + s.relationshipsMs + s.transformMs + s.layoutMs + s.convertMs
            + s.defRangeMs + s.callerScanMs + s.viewerOverlayMs + s.agentCtxMs + s.runHistoryMs
            + s.skillStatusMs + s.skillsMs + s.agentsMs + s.overlaysRestMs;
        const miscMs = Math.max(0, s.totalMs - accounted);
        // eslint-disable-next-line no-console
        console.log(
            `[dialogram perf] load ${this.label}#${build}: acquire=${Math.round(s.acquireMs)}ms `
            + `relationships=${Math.round(s.relationshipsMs)}ms transform=${Math.round(s.transformMs)}ms `
            + `layout=${Math.round(s.layoutMs)}ms convert=${Math.round(s.convertMs)}ms `
            + `defRange=${Math.round(s.defRangeMs)}ms callerScan=${Math.round(s.callerScanMs)}ms `
            + `viewerOverlay=${Math.round(s.viewerOverlayMs)}ms agentCtx=${Math.round(s.agentCtxMs)}ms `
            + `runHistory=${Math.round(s.runHistoryMs)}ms skillStatus=${Math.round(s.skillStatusMs)}ms `
            + `skills=${Math.round(s.skillsMs)}ms agents=${Math.round(s.agentsMs)}ms `
            + `overlaysRest=${Math.round(s.overlaysRestMs)}ms misc=${Math.round(miscMs)}ms `
            + `callers=${this.callersInfo ?? 'n/a'} enrichment=${this.enrichmentInfo ?? 'n/a'} `
            + `loadTotal=${Math.round(s.totalMs)}ms `
            + `(nodes=${extra.nodes} edges=${extra.edges})`
        );
    }
    done(extra: Record<string, string | number> = {}): void {
        if (!PERF_ENABLED) {
            return;
        }
        const total = GraphLoadPerf.now() - this.startedAt;
        const spanStr = this.spans.map(([n, ms]) => `${n}=${Math.round(ms)}`).join(' ');
        const extraStr = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ');
        // eslint-disable-next-line no-console
        console.log(`[perf] ${this.label} ${spanStr} total=${Math.round(total)}ms${extraStr ? ` (${extraStr})` : ''}`);
    }
}
