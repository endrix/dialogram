/**
 * Shared graph-diagnostics VS Code Problems-panel collection
 *
 * Extracted verbatim from diagram-glsp-module.ts. The module-level singleton is
 * deliberately shared (not per-instance) — see the comment below for why.
 */

/**
 * The 'workflow-graph' Problems collection is process-global: VS Code warns
 * ("DiagnosticCollection ... already exists") if the same name is created twice,
 * and this storage class is instantiated once per diagram panel. Share a single
 * collection across instances — it is keyed by file URI internally, so per-file
 * routing is unaffected.
 */
let sharedGraphDiagnostics: import('vscode').DiagnosticCollection | undefined;
export function getGraphDiagnosticsCollection(vscode: typeof import('vscode')): import('vscode').DiagnosticCollection {
    if (!sharedGraphDiagnostics) {
        sharedGraphDiagnostics = vscode.languages.createDiagnosticCollection('workflow-graph');
    }
    return sharedGraphDiagnostics;
}
