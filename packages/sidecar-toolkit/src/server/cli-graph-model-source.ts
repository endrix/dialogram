/**
 * CLI-plan Diagram Model Source (cli-plan path)
 *
 * `DiagramModelSource` implementation that acquires a workflow graph by spawning the runtime CLI's
 * `plan --format graph` (the cli-plan acquisition strategy), with a plan-result cache and a static-sidecar
 * fallback (composed via a {@link SidecarModelSource}) when the runtime CLI can't produce a graph.
 * argv comes from `cfg.cliGraphArgs` — the toolkit carries no product argv literals.
 */

import 'reflect-metadata';

import { promises as fs } from 'node:fs';
import { URI } from 'vscode-uri';
import type {
    DiagramModelSource,
    GraphDocument,
    GraphNodeIdentity,
    GraphSourceAnalysis,
    ModelSourceOptions
} from '@dialogram/shared';
import { GRAPH_SOURCE_URI_ARG } from '@dialogram/diagram-server/server/graph-load-request-options';
import { extractWorkflowDefinitionNames, normalizeSourceUriKey } from './source-analysis';
import {
    type SidecarRuntimeConfig,
    DEFAULT_GRAPH_LOAD_TIMEOUT_MS,
    getCliInvocation,
    getGraphLoadTimeoutMs,
    graphLoadTimeoutHint
} from './sidecar-runtime-config';
import { describeChildFailure, runChildProcess } from '../run-child-process';
import { SidecarModelSource, type SidecarModelSourceResult, nodeIdentitiesFromDoc } from './sidecar-model-source';

/**
 * Acquires workflow graph documents via the runtime CLI's `plan --format graph`, falling back to
 * the static sidecar (via the injected {@link SidecarModelSource}) when the CLI can't elaborate.
 */
export class CliGraphModelSource implements DiagramModelSource {

    /**
     * Cache of runtime `plan` output keyed by (file, workflow, on-disk content hash). The runtime
     * path re-elaborates the workflow on every load/refresh; debounced live updates and reopens of
     * an unchanged file re-read identical disk content and become cache hits. A save changes the
     * content hash and misses, so edits always re-run. Bounded LRU-ish.
     */
    private readonly planGraphCache = new Map<string, string>();
    private static readonly PLAN_GRAPH_CACHE_MAX = 24;

    constructor(
        private readonly cfg: SidecarRuntimeConfig,
        private readonly fallback: SidecarModelSource
    ) {}

    /** Delegates the language-specific source-analysis capabilities to the sidecar model source. */
    get analysis(): GraphSourceAnalysis | undefined {
        return this.fallback.analysis;
    }

    async getGraph(sourceUri: string, options: ModelSourceOptions): Promise<SidecarModelSourceResult | undefined> {
        const opts = options.requestOptions ?? {};
        const workflowFilePath = URI.parse(sourceUri).fsPath;
        const graphSourceUri = typeof opts[GRAPH_SOURCE_URI_ARG] === 'string' && String(opts[GRAPH_SOURCE_URI_ARG]).trim() !== ''
            ? normalizeSourceUriKey(String(opts[GRAPH_SOURCE_URI_ARG]).trim())
            : sourceUri;
        const graphFilePath = URI.parse(graphSourceUri).fsPath;

        if (!this.cfg.cliGraphArgs) {
            throw new Error("SidecarRuntimeConfig.graphAcquisition 'cli-plan' requires a cliGraphArgs builder");
        }

        const { spawn } = await import('node:child_process');
        const cliInvocation = this.getCliInvocation();

        const localWorkflowNames = await this.getLocalWorkflowNames(workflowFilePath);
        const requestedWorkflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : undefined;
        const defaultWorkflowName = requestedWorkflowName
            ? undefined
            : this.fallback.analysis.pickDefaultWorkflowName(workflowFilePath, localWorkflowNames);
        const selectedWorkflowName = requestedWorkflowName ?? defaultWorkflowName;

        const args: string[] = [...cliInvocation.argsPrefix, ...this.cfg.cliGraphArgs(workflowFilePath, selectedWorkflowName)];
        if (selectedWorkflowName) {
            args.push('--workflow', selectedWorkflowName);
        }

        // Skip re-running the workflow when on-disk content is unchanged (e.g. debounced live
        // updates, reopen). The key includes the content hash, so a save misses and re-runs.
        const planCacheKey = await this.computePlanCacheKey(workflowFilePath, selectedWorkflowName);
        if (planCacheKey) {
            const cached = this.planGraphCache.get(planCacheKey);
            if (cached !== undefined) {
                this.planGraphCache.delete(planCacheKey);
                this.planGraphCache.set(planCacheKey, cached); // refresh LRU position
                try {
                    const doc = JSON.parse(cached) as GraphDocument;
                    return this.fallback.attachDiagnostics({ ...doc, resolvedOptions: opts });
                } catch {
                    this.planGraphCache.delete(planCacheKey); // corrupt entry; fall through to re-run
                }
            }
        }

        // Bounded on purpose: the plan command runs the user's own module, so import-time
        // code can hang it, and this run is what "model loading" is waiting on. An
        // unstartable command (ENOENT) reports as an event rather than a throw, which is
        // the other way this used to never settle. Both end up as `failure` below.
        const result = await runChildProcess(cliInvocation.cmd, args, {
            timeoutMs: this.graphLoadTimeoutMs(workflowFilePath)
        });
        const { stdout } = result;

        const failure = describeChildFailure(cliInvocation.cmd, result);
        if (failure) {
            const detail = result.spawnError
                ? `failed to start '${cliInvocation.cmd}': ${result.spawnError.message}`
                : result.timedOut
                  ? `${failure} ${graphLoadTimeoutHint(this.cfg)}`
                  : (result.stderr || String(result.code));
            const message = detail.includes('attempted relative import with no known parent package')
                ? `CLI plan failed: ${detail}\nHint: the selected workflow file uses relative imports (for example, from .agents import ...). The runtime CLI currently loads a file as a standalone module. Open the top-level workflow file instead, or switch those imports to package-absolute imports.`
                : `CLI plan failed: ${detail}`;
            const fallback = await this.fallback.renderStaticSidecarFallback(graphFilePath, opts, workflowFilePath, message);
            if (fallback) {
                return this.fallback.attachDiagnostics({ ...fallback.doc, resolvedOptions: opts }, fallback.rawDiagnosticsPayload);
            }
            void this.fallback.showGraphExportError(message);
            return this.fallback.attachDiagnostics(
                { ...this.fallback.createGraphExportFailureDoc(workflowFilePath, opts, message), resolvedOptions: opts },
                this.fallback.graphExportFailureDiagnosticsPayload(workflowFilePath, message)
            );
        }

        try {
            const parsed = JSON.parse(stdout);
            if (!parsed || typeof parsed !== 'object' || !('graph' in parsed) || typeof (parsed as any).graph !== 'object' || (parsed as any).graph === null) {
                throw new Error('parsed document missing graph payload');
            }
            if (planCacheKey) {
                this.planGraphCache.set(planCacheKey, stdout);
                while (this.planGraphCache.size > CliGraphModelSource.PLAN_GRAPH_CACHE_MAX) {
                    const oldest = this.planGraphCache.keys().next().value;
                    if (oldest === undefined) {
                        break;
                    }
                    this.planGraphCache.delete(oldest);
                }
            }
            return this.fallback.attachDiagnostics({ ...(parsed as GraphDocument), resolvedOptions: opts });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallback = await this.fallback.renderStaticSidecarFallback(graphFilePath, opts, workflowFilePath, `CLI plan returned invalid JSON: ${message}`);
            if (fallback) {
                return this.fallback.attachDiagnostics({ ...fallback.doc, resolvedOptions: opts }, fallback.rawDiagnosticsPayload);
            }
            void this.fallback.showGraphExportError(`CLI plan returned invalid JSON: ${message}`);
            return this.fallback.attachDiagnostics(
                { ...this.fallback.createGraphExportFailureDoc(workflowFilePath, opts, `CLI plan returned invalid JSON: ${message}`), resolvedOptions: opts },
                this.fallback.graphExportFailureDiagnosticsPayload(workflowFilePath, `CLI plan returned invalid JSON: ${message}`)
            );
        }
    }

    /**
     * Resolve node identities: attempt the sidecar first (via the fallback), then fall through to
     * the runtime CLI `plan`. Returns undefined when neither can produce a node list.
     */
    async getNodeIdentities(sourceUri: string, options: ModelSourceOptions): Promise<GraphNodeIdentity[] | undefined> {
        const opts = options.requestOptions ?? {};
        const filePath = URI.parse(sourceUri).fsPath;
        const workflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : '';

        const sidecarResult = await this.fallback.tryLoadGraphFromSidecar(filePath, { networkName: workflowName });
        if (sidecarResult.graph) {
            return nodeIdentitiesFromDoc(this.fallback.graphPayloadToDoc(sidecarResult.graph));
        }

        if (!this.cfg.cliGraphArgs) {
            return undefined;
        }
        const cliInvocation = this.getCliInvocation();
        const args: string[] = [...cliInvocation.argsPrefix, ...this.cfg.cliGraphArgs(filePath, workflowName), '--workflow', workflowName];
        // Same deadline as the plan run: this drills into a child workflow, which runs the
        // same user code and can wedge the same way. Identities are optional — a failure
        // here degrades the result rather than failing the load — but it must still END.
        const result = await runChildProcess(cliInvocation.cmd, args, {
            timeoutMs: this.graphLoadTimeoutMs(filePath)
        });
        if (result.code !== 0 || result.stdout.trim() === '') {
            const reason = describeChildFailure(cliInvocation.cmd, result) ?? 'no output';
            console.warn(`[CliGraphModelSource] Failed to resolve child workflow identities for ${filePath}#${workflowName}: ${reason}`);
            return undefined;
        }

        return nodeIdentitiesFromDoc(JSON.parse(result.stdout));
    }

    /** Produce a well-formed failure document when acquisition is impossible; delegates to the fallback. */
    createFailureDocument(sourceUri: string, message: string): GraphDocument {
        return this.fallback.createFailureDocument(sourceUri, message);
    }

    /**
     * Resolve the CLI command/args-prefix to invoke, from the current runtime config/VS Code
     * settings. Falls back to the configured default command outside a VS Code host (tests).
     */
    getCliInvocation(): { cmd: string; argsPrefix: string[] } {
        try {
            const vscode = require('vscode') as typeof import('vscode');
            return getCliInvocation(this.cfg, vscode);
        } catch {
            return { cmd: this.cfg.cliCommandDefault, argsPrefix: [] };
        }
    }

    /**
     * The graph-load deadline for this file, from settings.
     *
     * Falls back to the default outside a VS Code host (tests) — the point of the
     * deadline is that it always exists, so an unavailable setting must not remove it.
     */
    private graphLoadTimeoutMs(filePath: string): number {
        try {
            const vscode = require('vscode') as typeof import('vscode');
            return getGraphLoadTimeoutMs(this.cfg, vscode, vscode.Uri.file(filePath));
        } catch {
            return DEFAULT_GRAPH_LOAD_TIMEOUT_MS;
        }
    }

    private async getLocalWorkflowNames(filePath: string): Promise<string[]> {
        try {
            const sourceText = await fs.readFile(filePath, 'utf-8');
            return extractWorkflowDefinitionNames(sourceText);
        } catch {
            return [];
        }
    }

    /** Cache key for a runtime plan: (file, workflow, sha256 of on-disk content). undefined if unreadable. */
    private async computePlanCacheKey(filePath: string, workflowName: string | undefined): Promise<string | undefined> {
        try {
            const fsModule = await import('node:fs/promises');
            const crypto = await import('node:crypto');
            const content = await fsModule.readFile(filePath);
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            return `${filePath}::${workflowName ?? ''}::${hash}`;
        } catch {
            return undefined;
        }
    }
}

/**
 * Build a `DiagramModelSource` from a {@link SidecarRuntimeConfig}, picking the acquisition strategy
 * by `cfg.graphAcquisition` and composing the CLI→sidecar fallback chain exactly as before.
 */
export function createSidecarModelSource(cfg: SidecarRuntimeConfig): DiagramModelSource {
    const sidecar = new SidecarModelSource(cfg);
    if (cfg.graphAcquisition === 'sidecar-export') {
        return sidecar;
    }
    if (!cfg.cliGraphArgs) {
        throw new Error("SidecarRuntimeConfig.graphAcquisition 'cli-plan' requires a cliGraphArgs builder");
    }
    return new CliGraphModelSource(cfg, sidecar);
}
