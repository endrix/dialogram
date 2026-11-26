/**
 * CLI-plan Diagram Model Source (cli-plan path)
 *
 * `DiagramModelSource` implementation that acquires a workflow graph by spawning the runtime CLI's
 * `plan --format graph` (the cli-plan acquisition strategy), with a plan-result cache and a static-sidecar
 * fallback (composed via a {@link SidecarModelSource}) when the runtime CLI can't produce a graph.
 * argv comes from `cfg.cliGraphArgs` — the toolkit carries no product argv literals. Every plan
 * starts where a run of the file starts (`resolveRunRoot`).
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
import { hierarchyRootAt, trailInstancePath } from '@dialogram/shared';
import {
    GRAPH_SOURCE_URI_ARG,
    NAV_TRAIL_ARG,
    VIEW_ARG,
    parseNavigationTrailArg,
    parseViewArg
} from '@dialogram/diagram-server/server/graph-load-request-options';
import { HierarchyCache, definitionFiles, fileHash, findInstance, graphsOf, outlineOf, withRecordedUnits, type HierarchyExport } from './hierarchy-cache';
import { FileMemo } from '@dialogram/diagram-server/services/file-memo';
import { extractWorkflowDefinitionNames } from './source-analysis';
import { normalizeSourceUriKey } from '@dialogram/diagram-server/server/uri-keys';
import {
    type SidecarRuntimeConfig,
    DEFAULT_GRAPH_LOAD_TIMEOUT_MS,
    cliProcessEnv,
    getCliInvocation,
    getCliVariables,
    getGraphLoadTimeoutMs,
    graphLoadTimeoutHint
} from './sidecar-runtime-config';
import { describeChildFailure, runChildProcess } from '../run-child-process';
import { resolveRunRoot } from '../run-root';
import { SidecarModelSource, type SidecarModelSourceResult, nodeIdentitiesFromDoc } from './sidecar-model-source';

/**
 * A plan kept: its output, and the files the definitions it draws are
 * declared in, as they read when it was made. The key hashes the workflow's
 * own file; a class it imports is in another.
 */
interface CachedPlan {
    json: string;
    definitions: Map<string, string | undefined>;
}

/**
 * The units a file declares. A large file is read for them once while it
 * stays as it was (file-memo.ts), whichever editor asks.
 */
const LOCAL_WORKFLOW_NAMES = new FileMemo<string[]>();

/**
 * Acquires workflow graph documents via the runtime CLI's `plan --format graph`, falling back to
 * the static sidecar (via the injected {@link SidecarModelSource}) when the CLI can't elaborate.
 */
export class CliGraphModelSource implements DiagramModelSource {

    /**
     * Cache of runtime `plan` output keyed by (file, workflow, on-disk content hash, the folder
     * the plan started in). The runtime path re-elaborates the workflow on every load/refresh;
     * debounced live updates and reopens of an unchanged file re-read identical disk content and
     * become cache hits. A save changes the content hash and misses, so edits always re-run; a
     * workspace folder opened since moves the run root and misses too. Bounded LRU-ish.
     */
    private readonly planGraphCache = new Map<string, CachedPlan>();
    private static readonly PLAN_GRAPH_CACHE_MAX = 24;

    /** One export per hierarchy root, when the runtime can make one. */
    private readonly hierarchyCache = new HierarchyCache((rootFile, rootWorkflow, cwd, variables) =>
        this.exportHierarchy(rootFile, rootWorkflow, cwd, variables));

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
        const cliInvocation = this.getCliInvocation(workflowFilePath);

        const localWorkflowNames = await this.getLocalWorkflowNames(workflowFilePath);
        const requestedWorkflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : undefined;
        const defaultWorkflowName = requestedWorkflowName
            ? undefined
            : this.fallback.analysis.pickDefaultWorkflowName(workflowFilePath, localWorkflowNames);
        const selectedWorkflowName = requestedWorkflowName ?? defaultWorkflowName;

        // Where a run of the file starts, so the plan, a run, `runCli` and a status source agree
        // on the folder (its workspace folder, its own folder outside every folder).
        const cwd = await resolveRunRoot(workflowFilePath);

        // A view other than the structure is not in the hierarchy export: the
        // plan command makes it, told which view with `--view <id>`.
        const view = parseViewArg(opts[VIEW_ARG]);
        const fromHierarchy = view ? undefined : await this.viewFromHierarchy(sourceUri, workflowFilePath, selectedWorkflowName, opts, cwd);
        if (fromHierarchy) {
            return this.fallback.attachDiagnostics({ ...fromHierarchy, resolvedOptions: opts });
        }

        const args: string[] = [...cliInvocation.argsPrefix, ...this.cfg.cliGraphArgs(workflowFilePath, selectedWorkflowName)];
        if (selectedWorkflowName) {
            args.push('--workflow', selectedWorkflowName);
        }
        if (view) {
            args.push('--view', view);
        }

        // Skip re-running the workflow when on-disk content is unchanged (e.g. debounced live
        // updates, reopen). The key includes the content hash, so a save misses and re-runs,
        // and the folder the plan starts in, which a workspace folder opened since moves.
        const variables = this.cliVariables(workflowFilePath, cwd);
        const planCacheKey = await this.computePlanCacheKey(
            workflowFilePath, view ? `${selectedWorkflowName ?? ''}@${view}` : selectedWorkflowName, cwd, variables);
        if (planCacheKey) {
            const entry = this.planGraphCache.get(planCacheKey);
            const cached = entry && (await this.definitionsUnchanged(entry)) ? entry.json : undefined;
            if (entry && cached === undefined) {
                this.planGraphCache.delete(planCacheKey); // a file a definition is in changed
            }
            if (entry && cached !== undefined) {
                this.planGraphCache.delete(planCacheKey);
                this.planGraphCache.set(planCacheKey, entry); // refresh LRU position
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
            cwd,
            timeoutMs: this.graphLoadTimeoutMs(workflowFilePath),
            env: cliProcessEnv(variables)
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
                const definitions = new Map<string, string | undefined>();
                for (const file of definitionFiles(parsed)) {
                    definitions.set(file, await fileHash(file));
                }
                this.planGraphCache.set(planCacheKey, { json: stdout, definitions });
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
        const cliInvocation = this.getCliInvocation(filePath);
        const args: string[] = [...cliInvocation.argsPrefix, ...this.cfg.cliGraphArgs(filePath, workflowName), '--workflow', workflowName];
        // Same deadline as the plan run: this drills into a child workflow, which runs the
        // same user code and can wedge the same way. Identities are optional — a failure
        // here degrades the result rather than failing the load — but it must still END.
        const cwd = await resolveRunRoot(filePath);
        const result = await runChildProcess(cliInvocation.cmd, args, {
            cwd,
            timeoutMs: this.graphLoadTimeoutMs(filePath),
            env: cliProcessEnv(this.cliVariables(filePath, cwd))
        });
        if (result.code !== 0 || result.stdout.trim() === '') {
            const reason = describeChildFailure(cliInvocation.cmd, result) ?? 'no output';
            console.warn(`[CliGraphModelSource] Failed to resolve child workflow identities for ${filePath}#${workflowName}: ${reason}`);
            return undefined;
        }

        return nodeIdentitiesFromDoc(JSON.parse(result.stdout));
    }

    /**
     * The view, read from its hierarchy's export, with the outline attached.
     *
     * The root is the trail's first crumb, or the view itself without a trail;
     * the view is the instance at the trail's instance path. Under a unit
     * answered by a past run, the root is that unit's crumb and the path the
     * names below it (`hierarchyRootAt`). Anything that does not line up -- no
     * export, an instance that did not elaborate, unsaved text being previewed
     * -- leaves the view to a plan of its own.
     */
    private async viewFromHierarchy(
        sourceUri: string,
        workflowFilePath: string,
        workflowName: string | undefined,
        opts: Record<string, unknown>,
        /** The run root of `workflowFilePath`, already resolved. */
        cwd: string
    ): Promise<GraphDocument | undefined> {
        if (!this.cfg.cliHierarchyArgs || typeof opts.content === 'string') {
            return undefined;
        }
        const trail = parseNavigationTrailArg(opts[NAV_TRAIL_ARG]);
        // Exported from the root file's run root, as a run of the root starts, and kept per folder
        // as the plan is.
        const exportOf = async (crumb: { file: string; workflow: string }): Promise<HierarchyExport | undefined> => {
            const rootCwd = crumb.file === workflowFilePath ? cwd : await resolveRunRoot(crumb.file);
            return this.hierarchyCache.get(crumb.file, crumb.workflow, rootCwd, this.cliVariables(crumb.file, rootCwd));
        };
        const crumbAt = (at: number) => ({ file: URI.parse(trail[at].sourceUri).fsPath, workflow: trail[at].workflowName });
        // Under a unit answered by a past run, the hierarchy is that unit's
        // (`hierarchyRootAt`): its parent's export has nothing under it.
        const at = hierarchyRootAt(trail);
        const root = trail.length > 0
            ? crumbAt(at)
            : workflowName ? { file: workflowFilePath, workflow: workflowName } : undefined;
        if (!root) {
            return undefined;
        }
        // The outline is the trail root's: its paths are the trail's, from its
        // first crumb, and it is the one the reader navigates by. A unit
        // answered by a past run is not in it, and a view under one is marked
        // in it as any view it does not list is. Both exports are asked at once.
        const [exported, navigated] = await Promise.all([exportOf(root), at === 0 ? undefined : exportOf(crumbAt(0))]);
        if (!exported) {
            return undefined;
        }
        if (at > 0 && !navigated) {
            console.warn(`[CliGraphModelSource] No outline for ${workflowFilePath}#${workflowName ?? ''}: the hierarchy of ${trail[0].workflowName} was not exported`);
        }
        const path = trailInstancePath(trail.slice(at));
        let view: GraphDocument;
        if (path.length === 0) {
            if (workflowFilePath !== root.file || (workflowName && workflowName !== root.workflow)) {
                return undefined;
            }
            const { hierarchy: _tree, ...rootDoc } = exported;
            view = rootDoc as unknown as GraphDocument;
        } else {
            const instance = findInstance(exported.hierarchy, path);
            if (
                !instance?.graph
                || (workflowName && instance.workflowName !== workflowName)
                || (instance.sourcePath && URI.file(instance.sourcePath).fsPath !== workflowFilePath)
            ) {
                return undefined;
            }
            view = instance.graph as GraphDocument;
        }
        // The graphs a list of nodes is read from go with the outline, with
        // what each unit answered by a past run elaborated grafted under it
        // (`withRecordedUnits`) when the product lists nodes: the list is the
        // trail root's wherever the view is, and each unit's nodes are its run's.
        const listed = at === 0 ? exported : navigated;
        if (!listed) {
            return view;
        }
        const graphs = this.cfg.listsNodes ? await withRecordedUnits(graphsOf(listed), exportOf) : graphsOf(listed);
        return { ...view, hierarchy: outlineOf(listed.hierarchy), hierarchyGraphs: graphs };
    }

    /** Runs the runtime's hierarchy export from `cwd`, the root file's run root, with `variables`; its stdout, or undefined when it fails. */
    private async exportHierarchy(
        rootFile: string, rootWorkflow: string, cwd: string, variables: Record<string, string>
    ): Promise<string | undefined> {
        if (!this.cfg.cliHierarchyArgs) {
            return undefined;
        }
        const cliInvocation = this.getCliInvocation(rootFile);
        const result = await runChildProcess(
            cliInvocation.cmd,
            [...cliInvocation.argsPrefix, ...this.cfg.cliHierarchyArgs(rootFile, rootWorkflow)],
            { cwd, timeoutMs: this.graphLoadTimeoutMs(rootFile), env: cliProcessEnv(variables) }
        );
        const failure = describeChildFailure(cliInvocation.cmd, result);
        if (failure || result.stdout.trim() === '') {
            console.warn(`[CliGraphModelSource] Hierarchy export failed for ${rootFile}#${rootWorkflow}: ${failure ?? 'no output'}`);
            return undefined;
        }
        return result.stdout;
    }

    /** Produce a well-formed failure document when acquisition is impossible; delegates to the fallback. */
    createFailureDocument(sourceUri: string, message: string): GraphDocument {
        return this.fallback.createFailureDocument(sourceUri, message);
    }

    /**
     * Resolve the CLI command/args-prefix to invoke, from the current runtime config/VS Code
     * settings scoped to `filePath` when given (a folder's own setting, as a run, `runCli`, the
     * chat's graph and a status source read it). Falls back to the configured default command
     * outside a VS Code host (tests).
     */
    getCliInvocation(filePath?: string): { cmd: string; argsPrefix: string[] } {
        try {
            const vscode = require('vscode') as typeof import('vscode');
            return getCliInvocation(this.cfg, vscode, filePath !== undefined ? vscode.Uri.file(filePath) : undefined);
        } catch {
            return { cmd: this.cfg.cliCommandDefault, argsPrefix: [] };
        }
    }

    /**
     * The variables the product's settings give the CLI started for `filePath` in `cwd`, its run
     * root (`getCliVariables`); none outside a VS Code host (tests).
     */
    cliVariables(filePath: string, cwd: string): Record<string, string> {
        let vscode: typeof import('vscode');
        try {
            vscode = require('vscode') as typeof import('vscode');
        } catch {
            return {};
        }
        return getCliVariables(this.cfg, vscode, vscode.Uri.file(filePath), cwd);
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

    /** A file that cannot be read declares nothing, and that is not kept: it is read again at the next ask. */
    private async getLocalWorkflowNames(filePath: string): Promise<string[]> {
        try {
            return await LOCAL_WORKFLOW_NAMES.get(filePath, async () => extractWorkflowDefinitionNames(await fs.readFile(filePath, 'utf-8')));
        } catch {
            return [];
        }
    }

    /** Whether every file a definition drawn in `entry` is declared in reads as it did. */
    private async definitionsUnchanged(entry: CachedPlan): Promise<boolean> {
        for (const [file, hash] of entry.definitions) {
            if ((await fileHash(file)) !== hash) {
                return false;
            }
        }
        return true;
    }

    /**
     * Cache key for a runtime plan: (file, workflow, sha256 of on-disk content, the folder it
     * starts in). undefined if unreadable.
     */
    private async computePlanCacheKey(
        filePath: string, workflowName: string | undefined, cwd: string, variables: Record<string, string>
    ): Promise<string | undefined> {
        // The same hash the definition files are checked by: a large file's is kept (file-memo.ts).
        // A plan made with other variables is another plan.
        const hash = await fileHash(filePath);
        return hash === undefined ? undefined : `${filePath}::${workflowName ?? ''}::${hash}::${cwd}::${JSON.stringify(variables)}`;
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
