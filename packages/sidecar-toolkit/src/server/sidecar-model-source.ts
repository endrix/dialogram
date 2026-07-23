/**
 * Sidecar Diagram Model Source (sidecar-export path)
 *
 * `DiagramModelSource` implementation that acquires a workflow/network graph document from the
 * sidecar's graph-export op (the sidecar-export acquisition strategy). Configured entirely by a
 * product-neutral {@link SidecarRuntimeConfig}. The CLI-plan acquisition strategy lives in
 * `CliGraphModelSource`, which composes this class as its static-sidecar fallback.
 */

import 'reflect-metadata';

import * as path from 'node:path';
import { URI } from 'vscode-uri';
import type {
    DiagramModelSource,
    GraphDiagnostic,
    GraphDocument,
    GraphNodeIdentity,
    GraphSourceAnalysis,
    ModelSourceOptions
} from '@dialogram/shared';
import {
    GRAPH_SOURCE_URI_ARG,
    INSTANCE_PATH_ARG,
    ROOT_WORKFLOW_ARG,
    deriveTrailFallback,
    normalizeGraphLoadErrors,
    parseStringListArg,
    shouldRetryTrailFallback
} from '@dialogram/diagram-server/server/graph-load-request-options';
import {
    findPackageRootForFile,
    pickDefaultWorkflowName,
    resolveWorkflowDefinitionRange,
    analyzeWorkflowRelationships,
    collectPythonFilesUnderRoots,
    discoverCrossFileWorkflowCallers,
    buildViewerOverlayAstPathCandidates,
    buildViewerOverlaySignatureCandidates,
    buildViewerOverlayNodeIdentityCandidates,
    resolveViewerOverlayActiveEntityName,
    normalizeWorkflowReferenceName,
    normalizeSourceUriKey
} from './source-analysis';
import { graphPayloadToDoc } from './graph-payload-to-doc';
import { type SidecarRuntimeConfig, sidecarOp, getSidecarCommand } from './sidecar-runtime-config';

/**
 * `GraphDocument` plus the request options `finishLoadFromDoc` must continue with. Usually
 * identical to the caller's options, but the breadcrumb-trail retry can substitute a
 * different graph source/root workflow/instance path than originally requested.
 */
export interface SidecarModelSourceResult extends GraphDocument {
    resolvedOptions: Record<string, unknown>;
}

/** Turn a graph-doc's node list into neutral {@link GraphNodeIdentity}s (label→instance, type→definition). */
export function nodeIdentitiesFromDoc(doc: any): GraphNodeIdentity[] | undefined {
    const nodes = Array.isArray(doc?.graph?.nodes) ? doc.graph.nodes : undefined;
    if (!nodes) {
        return undefined;
    }
    const identities: GraphNodeIdentity[] = [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        const instanceName = typeof node.label === 'string' ? node.label.trim() : '';
        const definitionName = typeof node.type === 'string' ? node.type.trim() : '';
        identities.push({ instanceName, ...(definitionName !== '' ? { definitionName } : {}) });
    }
    return identities;
}

/**
 * Acquires workflow/network graph documents via the sidecar's graph-export op.
 */
export class SidecarModelSource implements DiagramModelSource {

    constructor(private readonly cfg: SidecarRuntimeConfig) {}

    /** Language-specific source-analysis capabilities, delegating to the moved analysis module. */
    readonly analysis: GraphSourceAnalysis = {
        findPackageRootForFile,
        pickDefaultWorkflowName,
        resolveWorkflowDefinitionRange,
        analyzeWorkflowRelationships,
        collectSourceFilesUnderRoots: collectPythonFilesUnderRoots,
        discoverCrossFileWorkflowCallers,
        buildOverlayAstPathCandidates: buildViewerOverlayAstPathCandidates,
        buildOverlaySignatureCandidates: buildViewerOverlaySignatureCandidates,
        buildOverlayNodeIdentityCandidates: buildViewerOverlayNodeIdentityCandidates,
        resolveOverlayActiveEntityName: resolveViewerOverlayActiveEntityName,
        normalizeWorkflowReferenceName
    };

    /**
     * Acquire the graph document for `sourceUri` via the sidecar graph-export op, with the
     * breadcrumb-trail retry and a graph-export failure document when the sidecar can't produce one.
     */
    async getGraph(sourceUri: string, options: ModelSourceOptions): Promise<SidecarModelSourceResult | undefined> {
        const opts = options.requestOptions ?? {};
        let resolvedOpts: Record<string, unknown> = opts;
        const workflowFilePath = URI.parse(sourceUri).fsPath;
        const graphSourceUri = typeof opts[GRAPH_SOURCE_URI_ARG] === 'string' && String(opts[GRAPH_SOURCE_URI_ARG]).trim() !== ''
            ? normalizeSourceUriKey(String(opts[GRAPH_SOURCE_URI_ARG]).trim())
            : sourceUri;
        const graphFilePath = URI.parse(graphSourceUri).fsPath;

        let sidecarResult: { graph?: Record<string, unknown>; error?: string; warning?: string } =
            await this.tryLoadGraphFromSidecar(graphFilePath, opts);
        if (!sidecarResult.graph || shouldRetryTrailFallback(sidecarResult, opts)) {
            const retry = deriveTrailFallback(sourceUri, opts);
            if (retry) {
                const retryOpts = {
                    ...opts,
                    [GRAPH_SOURCE_URI_ARG]: retry.graphSourceUri,
                    [ROOT_WORKFLOW_ARG]: retry.rootWorkflowName,
                    [INSTANCE_PATH_ARG]: retry.instancePath
                };
                const retriedResult = await this.tryLoadGraphFromSidecar(URI.parse(retry.graphSourceUri).fsPath, retryOpts);
                // Preserve the original partial graph if retry fails to produce a graph.
                if (retriedResult.graph || !sidecarResult.graph) {
                    sidecarResult = retriedResult;
                    resolvedOpts = retryOpts;
                }
            }
        }
        if (sidecarResult.graph) {
            const doc = this.graphPayloadToDoc(sidecarResult.graph);
            // `graphPayloadToDoc` reshapes the raw sidecar payload -- diagnostics must still see the
            // pre-transform payload, so pass it alongside the transformed doc.
            return this.attachDiagnostics({ ...doc, resolvedOptions: resolvedOpts }, sidecarResult.graph);
        }

        const failureLabel = this.cfg.graphExportFailureLabel ?? 'Graph export failed';
        const message = `${failureLabel}${sidecarResult.error ? `: ${sidecarResult.error}` : ''}`;
        void this.showGraphExportError(message);
        return this.attachDiagnostics(
            { ...this.createGraphExportFailureDoc(workflowFilePath, resolvedOpts, message), resolvedOptions: resolvedOpts },
            this.graphExportFailureDiagnosticsPayload(workflowFilePath, message)
        );
    }

    /**
     * Attach normalized `diagnostics` to a result, computed from the same payload storage's old
     * `publishGraphDiagnostics` walked: the pre-transform `rawPayload` when present, else the
     * returned `graph`.
     */
    attachDiagnostics(result: SidecarModelSourceResult, rawPayload?: unknown): SidecarModelSourceResult {
        const payload = rawPayload && typeof rawPayload === 'object'
            ? rawPayload as Record<string, unknown>
            : (result.graph && typeof result.graph === 'object' ? result.graph as Record<string, unknown> : {});
        return { ...result, diagnostics: this.normalizeGraphDiagnostics(payload) };
    }

    /**
     * Normalize a raw sidecar/CLI graph payload into neutral {@link GraphDiagnostic}s -- lifted
     * verbatim from `WorkflowSourceModelStorage#publishGraphDiagnostics`'s walk.
     */
    private normalizeGraphDiagnostics(graphPayload: Record<string, unknown> | undefined): GraphDiagnostic[] {
        const out: GraphDiagnostic[] = [];
        const severityOf = (s: unknown): GraphDiagnostic['severity'] =>
            s === 'warning' ? 'warning' : s === 'info' ? 'info' : 'error';
        const add = (file: unknown, line: unknown, column: unknown, message: string, severity: unknown, code: unknown): void => {
            const entry: GraphDiagnostic = { severity: severityOf(severity), message };
            if (typeof file === 'string' && file.trim() !== '') {
                entry.uri = file;
            }
            if (typeof line === 'number' && Number.isFinite(line)) {
                entry.startLine = line;
            }
            if (typeof column === 'number' && Number.isFinite(column)) {
                entry.startColumn = column;
            }
            if (typeof code === 'string' && code.trim() !== '') {
                entry.code = code.trim();
            }
            out.push(entry);
        };
        const collectElements = (elements: unknown): void => {
            if (!Array.isArray(elements)) {
                return;
            }
            for (const el of elements) {
                if (!el || typeof el !== 'object') {
                    continue;
                }
                const meta = (el as any).metadata ?? (el as any).meta;
                const diags = meta && Array.isArray(meta.diagnostics) ? meta.diagnostics : [];
                if (diags.length === 0) {
                    continue;
                }
                const loc = (el as any).location ?? (el as any).source;
                const file = loc && typeof loc === 'object' ? (loc as any).file : undefined;
                const line = loc && typeof loc === 'object' ? (loc as any).line : undefined;
                const column = loc && typeof loc === 'object' ? (loc as any).column : undefined;
                for (const d of diags) {
                    if (!d || typeof d !== 'object') {
                        continue;
                    }
                    const message = typeof (d as any).message === 'string' ? (d as any).message.trim() : '';
                    if (message === '') {
                        continue;
                    }
                    add(file, line, column, message, (d as any).severity, (d as any).code);
                }
            }
        };
        const walk = (payload: Record<string, unknown> | undefined): void => {
            if (!payload || typeof payload !== 'object') {
                return;
            }
            for (const err of normalizeGraphLoadErrors(payload.errors)) {
                add(err.file, err.line, err.column, err.message, err.severity, err.code);
            }
            collectElements(payload.nodes);
            collectElements(payload.edges);
            if (Array.isArray(payload.children)) {
                for (const child of payload.children) {
                    if (child && typeof child === 'object' && (child as any).graph) {
                        walk((child as any).graph as Record<string, unknown>);
                    }
                }
            }
        };
        walk(graphPayload);
        return out;
    }

    /**
     * Resolve node identities for a workflow via the sidecar. The sidecar-export runtime stops at
     * the sidecar (no CLI fallback); returns undefined when it can't produce a node list.
     */
    async getNodeIdentities(sourceUri: string, options: ModelSourceOptions): Promise<GraphNodeIdentity[] | undefined> {
        const opts = options.requestOptions ?? {};
        const filePath = URI.parse(sourceUri).fsPath;
        const workflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : '';

        const sidecarResult = await this.tryLoadGraphFromSidecar(filePath, { networkName: workflowName });
        if (sidecarResult.graph) {
            return nodeIdentitiesFromDoc(this.graphPayloadToDoc(sidecarResult.graph));
        }
        return undefined;
    }

    /**
     * Produce a well-formed failure document when acquisition is impossible. Neutral seam method
     * (see `DiagramModelSource`); delegates to {@link createGraphExportFailureDoc} with no context.
     */
    createFailureDocument(sourceUri: string, message: string): GraphDocument {
        let filePath = sourceUri;
        try {
            filePath = URI.parse(sourceUri).fsPath;
        } catch {
            // Fall back to the raw string when it isn't a parseable URI.
        }
        return this.createGraphExportFailureDoc(filePath, {}, message);
    }

    /**
     * The synthetic file-level diagnostic published on every hard-failure branch alongside
     * {@link createGraphExportFailureDoc}'s error-node document, preserving the
     * `graph_export_failed` code the Problems panel keys on.
     */
    graphExportFailureDiagnosticsPayload(workflowFilePath: string, message: string): Record<string, unknown> {
        return {
            errors: [
                {
                    severity: 'error',
                    code: 'graph_export_failed',
                    message,
                    location: { file: workflowFilePath, line: 1, column: 1 }
                }
            ]
        };
    }

    /**
     * Last-resort static graph when the runtime CLI `plan` path can't produce one. The static
     * sidecar still parses the source, so structure renders rather than collapsing to an error node.
     * Returns the fallback document plus the raw (pre-transform) payload diagnostics must consume,
     * or undefined if the static sidecar couldn't produce one either. Used by `CliGraphModelSource`.
     */
    async renderStaticSidecarFallback(
        graphFilePath: string,
        opts: Record<string, unknown>,
        workflowFilePath: string,
        runtimeError?: string
    ): Promise<{ doc: GraphDocument; rawDiagnosticsPayload: Record<string, unknown> } | undefined> {
        const fallback = await this.tryLoadGraphFromSidecar(graphFilePath, opts);
        if (!fallback.graph) {
            return undefined;
        }
        const graph = runtimeError && runtimeError.trim() !== ''
            ? {
                  ...fallback.graph,
                  partial: true,
                  errors: [
                      ...normalizeGraphLoadErrors((fallback.graph as Record<string, unknown>).errors),
                      {
                          severity: 'error',
                          code: 'runtime_plan_failed',
                          message: `Showing statically-parsed structure; the runtime could not elaborate this workflow: ${runtimeError.trim()}`,
                          file: workflowFilePath,
                          line: 1,
                          column: 1
                      }
                  ]
              }
            : fallback.graph;
        return { doc: this.graphPayloadToDoc(graph), rawDiagnosticsPayload: graph };
    }

    /**
     * Try to acquire the graph via the sidecar's graph-export op. Public: also used by
     * `CliGraphModelSource` for its static-sidecar fallback and child-workflow identity resolution.
     */
    async tryLoadGraphFromSidecar(
        filePath: string,
        opts: Record<string, unknown>
    ): Promise<{ graph?: Record<string, unknown>; error?: string; warning?: string }> {
        try {
            const vscode = require('vscode') as typeof import('vscode');
            const sidecarCmd = getSidecarCommand(this.cfg, vscode, vscode.Uri.file(filePath));
            const networkName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
                ? opts.networkName.trim()
                : undefined;
            const rootWorkflow = typeof opts[ROOT_WORKFLOW_ARG] === 'string' && String(opts[ROOT_WORKFLOW_ARG]).trim() !== ''
                ? String(opts[ROOT_WORKFLOW_ARG]).trim()
                : undefined;
            const instancePath = parseStringListArg(opts[INSTANCE_PATH_ARG]);
            const requestArgs: Record<string, unknown> = {};
            if (this.cfg.graphAcquisition === 'sidecar-export' && instancePath.length > 0 && rootWorkflow) {
                requestArgs.rootNetwork = rootWorkflow;
                requestArgs.instancePath = instancePath;
            } else if (networkName) {
                requestArgs.network = networkName;
            }
            // The graph-export op name differs per acquisition strategy: the sidecar-export runtime
            // dispatches `exportNetworkGraph`; others dispatch `exportWorkflowGraph`.
            const exportOp = this.cfg.graphAcquisition === 'sidecar-export'
                ? 'exportNetworkGraph'
                : 'exportWorkflowGraph';
            const requestPayload = {
                file: filePath,
                op: sidecarOp(this.cfg, exportOp),
                args: requestArgs
            };
            const { spawn } = await import('node:child_process');
            const sidecarEnv: NodeJS.ProcessEnv = { ...process.env };
            const packageRoot = await findPackageRootForFile(filePath);
            if (packageRoot) {
                sidecarEnv.PYTHONPATH = sidecarEnv.PYTHONPATH && sidecarEnv.PYTHONPATH.trim() !== ''
                    ? `${packageRoot}${path.delimiter}${sidecarEnv.PYTHONPATH}`
                    : packageRoot;
            }
            const child = spawn(sidecarCmd, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: packageRoot ?? path.dirname(filePath),
                env: sidecarEnv
            });
            let spawnError: Error | undefined;
            // An unspawnable sidecar (ENOENT — not installed or a typo'd setting) emits 'error';
            // without this handler the EventEmitter throws an uncaught exception in the extension
            // host and the load hangs at "model loading" forever. The stdin no-op error handler
            // swallows the EPIPE that follows when the process never started.
            const exitPromise = new Promise<number>(resolve => {
                child.on('error', err => {
                    spawnError = err;
                    resolve(-1);
                });
                child.on('close', c => resolve(c ?? 1));
            });
            child.stdin.on('error', () => undefined);
            child.stdin.write(JSON.stringify(requestPayload) + '\n');
            child.stdin.end();

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => (stdout += d.toString()));
            child.stderr.on('data', d => (stderr += d.toString()));
            const exitCode: number = await exitPromise;
            if (spawnError || exitCode !== 0 || stdout.trim() === '') {
                const msg = spawnError
                    ? `failed to start: ${spawnError.message}`
                    : stderr.trim() !== '' ? stderr.trim() : `sidecar exited with ${exitCode}`;
                return { error: `${sidecarCmd}: ${msg}` };
            }
            const response = JSON.parse(stdout);
            if (response?.status !== 'ok') {
                const msg = typeof response?.message === 'string' && response.message.trim() !== ''
                    ? response.message.trim()
                    : 'sidecar returned non-ok status';
                return { error: `${sidecarCmd}: ${msg}` };
            }
            const graph = response?.diagnostic?.graph;
            if (!graph || typeof graph !== 'object') {
                return { error: `${sidecarCmd}: response missing diagnostic.graph payload` };
            }
            const graphErrors = normalizeGraphLoadErrors(response?.diagnostic?.errors);
            const isPartialGraph = response?.diagnostic?.partial === true;
            return {
                graph: {
                    ...(graph as Record<string, unknown>),
                    ...(isPartialGraph ? { partial: true } : {}),
                    ...(graphErrors.length > 0 ? { errors: graphErrors } : {})
                },
                ...((isPartialGraph || graphErrors.length > 0)
                    ? { warning: graphErrors[0]?.message ?? 'Graph export completed with recoverable errors.' }
                    : {})
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Normalize a raw sidecar/CLI graph payload into the `{version, graph: {...}}` doc shape.
     * Delegates to the moved {@link graphPayloadToDoc}. Public: also used by `CliGraphModelSource`
     * and re-homed tests that call it directly.
     */
    graphPayloadToDoc(graphPayload: Record<string, unknown>): GraphDocument {
        return graphPayloadToDoc(graphPayload);
    }

    /** Build the single-error-node fallback document used when the sidecar can't produce a graph. */
    createGraphExportFailureDoc(
        filePath: string,
        opts: Record<string, unknown>,
        message: string
    ): GraphDocument {
        const requestedWorkflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : undefined;
        const fallbackGraphName = requestedWorkflowName
            ?? path.basename(filePath, path.extname(filePath))
            ?? 'python';
        const normalizedMessage = message.trim() !== '' ? message.trim() : 'Graph export failed.';
        return {
            version: '1',
            partial: true,
            errors: [{ message: normalizedMessage, file: filePath }],
            graph: {
                id: `wf:${fallbackGraphName}`,
                nodes: [
                    {
                        id: '__graph_export_error__',
                        kind: 'task',
                        label: 'Graph export failed',
                        type: 'LoadError',
                        scope: '',
                        ports: [],
                        meta: {
                            isErrored: true,
                            errorMessage: normalizedMessage
                        }
                    }
                ],
                edges: [],
                subgraphs: []
            }
        };
    }

    async showGraphExportError(message: string): Promise<void> {
        try {
            const vscode = await import('vscode');
            await vscode.window.showErrorMessage(message);
        } catch {
            // Ignore when VS Code UI is unavailable in tests.
        }
    }
}
