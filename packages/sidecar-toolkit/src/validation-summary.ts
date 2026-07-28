/**
 * Sidecar graph-container location + validation-verdict distillation.
 *
 * Extracted so BOTH the standalone stdio MCP server (`sidecar-mcp-server.ts`)
 * and the in-process registry chat tools (`registry-tools.ts`) share one copy
 * of the graph-container probing and validation-summary logic (no duplication).
 */

/**
 * Locate the graph container inside an export response. Runtimes nest it
 * differently (some under `diagnostic.graph`, others at the top level or under
 * `graph`/`result`), so probe the known shapes and pick the first object that
 * actually carries a `nodes`/`edges` array.
 */
export function findGraphContainer(result: any): any {
  const candidates = [
    result?.diagnostic?.graph,
    result?.graph,
    result?.result?.graph,
    result?.result,
    result,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && (Array.isArray(c.nodes) || Array.isArray(c.edges))) {
      return c;
    }
  }
  return undefined;
}

/**
 * Distill an export response into a compact validation verdict the agent can act
 * on: an overall pass/fail plus file-level errors and per-element diagnostics
 * (with source locations). Reuses the partial-graph diagnostics the sidecars
 * already emit (`graph.partial`, `graph.errors[]`, per-node/edge
 * `meta.diagnostics` / `isErrored`). Intentionally does NOT set `status:'error'`
 * so the full structured verdict reaches the model (the MCP layer collapses an
 * errored result to just its message).
 */
export function summarizeValidation(result: any): Record<string, unknown> {
  const graph = findGraphContainer(result);
  const errors: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];

  if (!graph) {
    // No graph came back at all — the file could not be parsed/elaborated.
    errors.push({
      severity: 'error',
      code: result?.diagnostic?.code ?? 'export_failed',
      message: result?.message ?? result?.diagnostic?.message ?? 'Could not elaborate the file.',
      location: null,
    });
    return { ok: false, partial: true, problems: 1, summary: '1 problem found (file did not elaborate).', errors, elements };
  }

  for (const e of (Array.isArray(graph.errors) ? graph.errors : [])) {
    errors.push({
      severity: e?.severity ?? 'error',
      code: e?.code,
      message: e?.message,
      location: e?.location ?? null,
    });
  }

  const scan = (arr: any[], kind: 'node' | 'edge'): void => {
    for (const el of (Array.isArray(arr) ? arr : [])) {
      const meta = el?.meta ?? el?.metadata ?? {};
      const diagnostics = Array.isArray(meta.diagnostics) ? meta.diagnostics : [];
      const errored = meta.isErrored === true || diagnostics.some((d: any) => d?.severity === 'error');
      if (diagnostics.length > 0 || errored) {
        elements.push({
          kind,
          id: el?.id ?? el?.name,
          errored,
          diagnostics,
          location: el?.location ?? null,
        });
      }
    }
  };
  scan(graph.nodes, 'node');
  scan(graph.edges, 'edge');

  const partial = graph.partial === true;
  const erroredElements = elements.filter((e) => e.errored).length;
  const problems = errors.filter((e) => e.severity === 'error').length + erroredElements;
  const ok = !partial && problems === 0;
  return {
    ok,
    partial,
    problems,
    summary: ok
      ? 'Validation passed: the file elaborates cleanly.'
      : `${problems} problem(s) found${partial ? ' (graph is partial)' : ''}.`,
    errors,
    elements,
  };
}
