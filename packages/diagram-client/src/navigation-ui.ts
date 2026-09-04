import { TYPES, type IActionDispatcher, EditorContextService } from '@eclipse-glsp/client';
import { NavigateToExternalTargetAction, RequestModelAction } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { VscodeUi } from './vscode-ui';
import { clientBehavior, queueTraceVisibleStorageKey } from './profile';
import {
    computeGraphLoadIssueOverlayState,
    type GraphLoadError,
    type GraphLoadIssueOverlayState
} from './graph-load-issue-overlay';

const OPEN_DIAGRAM_ARG = 'cal:openDiagram';
const NETWORK_NAME_ARG = 'cal:networkName';
const NAV_TRAIL_ARG = 'wf:navTrail';
const RUN_ID_ARG = 'wf:runId';

type NavigationCrumb = {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
};

type ParentWorkflowOption = {
    sourceUri: string;
    workflowName: string;
    label: string;
};

type RootArgs = {
    sourceUri?: string;
    'wf:availableWorkflows'?: string[];
    'wf:availableRuns'?: string | Array<{ runId?: string; label?: string; running?: boolean }>;
    'wf:errors'?: Array<{ message?: string; file?: string; line?: number; column?: number }>;
    'wf:parentWorkflows'?: Array<string | { sourceUri?: string; workflowName?: string }>;
    'wf:partial'?: boolean;
    'wf:rootWorkflows'?: string[];
    'wf:selectedRunId'?: string;
    'wf:selectedWorkflow'?: string;
    'wf:runtimeProfile'?: string;
    'wf:namespace'?: string;
    'cal:networkName'?: string;
    'wf:navTrail'?: string | Array<{ sourceUri?: string; workflowName?: string; workflowInstanceName?: string }>;
    'wf:queueTraceStep'?: number;
    'wf:queueTraceStepCount'?: number;
    'wf:queueTraceActor'?: string;
};

type QueueTraceMeta = {
    step: number;
    stepCount: number;
    actor?: string;
};

type RunOption = {
    runId: string;
    label: string;
    running?: boolean;
};

/**
 * What the warning chip says.
 *
 * "Partial graph" only when the graph really is partial. Every error used to
 * earn that prefix, which made a complete and correct picture of something
 * faulty announce itself as an incomplete picture. Those are opposite claims,
 * and the wrong one sends a reader hunting for missing nodes instead of reading
 * the problem being reported — the likelier case by far, since a producer able
 * to describe a fault precisely usually had no trouble drawing it.
 *
 * When the graph is whole the message stands on its own: it already says what
 * is wrong, and the chip's styling already says it is a warning.
 *
 * Exported for its own test. It is one line of string arithmetic, and it is
 * also the whole difference between telling a reader their picture is missing
 * something and telling them their subject has a fault.
 */
export function graphWarningText(messages: string[], graphIsTruncated: boolean): string {
    const first = messages[0] ?? 'Graph export completed with recoverable errors.';
    const extra = Math.max(0, messages.length - 1);
    const suffix = extra > 0 ? ` (+${extra} more)` : '';
    return graphIsTruncated ? `Partial graph: ${first}${suffix}` : `${first}${suffix}`;
}

type RenderMeta = {
    available: string[];
    availableRuns: RunOption[];
    entryWorkflows: string[];
    graphErrors: GraphLoadError[];
    isPartialGraph: boolean;
    /**
     * Whether the graph itself is incomplete, as opposed to complete but
     * describing something that has problems.
     *
     * `isPartialGraph` above is "is there anything to warn about" and stays
     * that, because the overlay keys on it. This is the narrower fact, and it
     * is the one the wording has to follow.
     */
    graphIsTruncated: boolean;
    parentWorkflows: ParentWorkflowOption[];
    renderableNodeCount: number;
    runtimeProfile?: string;
    selected: string;
    selectedRunId?: string;
    queueTrace?: QueueTraceMeta;
};

const QUEUE_TRACE_VISIBLE_STORAGE_KEY = queueTraceVisibleStorageKey();

function normalizeSourceUriKey(sourceUri: string): string {
    const trimmed = sourceUri.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const parsed = new URL(trimmed);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString();
    } catch {
        return trimmed;
    }
}

function isQueueTraceVisible(): boolean {
    try {
        const raw = globalThis.localStorage?.getItem(QUEUE_TRACE_VISIBLE_STORAGE_KEY);
        return raw !== '0';
    } catch {
        return true;
    }
}

function labelForParentWorkflow(option: { sourceUri: string; workflowName: string }, currentSourceUri: string): string {
    if (normalizeSourceUriKey(option.sourceUri) === normalizeSourceUriKey(currentSourceUri)) {
        return option.workflowName;
    }
    try {
        const parsed = new URL(option.sourceUri);
        const fileName = parsed.pathname.split('/').filter(Boolean).pop();
        if (fileName) {
            return `${option.workflowName} (${decodeURIComponent(fileName)})`;
        }
    } catch {
        // Fall through to raw source URI label.
    }
    return `${option.workflowName} (${option.sourceUri})`;
}

function navigationEntityLabel(plural = false): string {
    if (clientBehavior().networkNavigationLabels === true) {
        return plural ? 'Networks' : 'Network';
    }
    return plural ? 'Workflows' : 'Workflow';
}

@injectable()
export class WorkflowNavigationUi {
    private breadcrumbEl?: HTMLDivElement;
    private graphWarningEl?: HTMLDivElement;
    private centerIssueEl?: HTMLDivElement;
    private fabStackEl?: HTMLDivElement;
    private debugRowEl?: HTMLDivElement;
    private debugFabEl?: HTMLButtonElement;
    private runsFabEl?: HTMLButtonElement;
    private workflowsFabEl?: HTMLButtonElement;
    private usedByFabEl?: HTMLButtonElement;
    private debugClusterEl?: HTMLDivElement;
    private debugExpanded = false;
    private lastDebugCtx?: { sourceUri: string; stack: NavigationCrumb[]; meta: RenderMeta };
    private readonly stacksBySourceUri = new Map<string, NavigationCrumb[]>();
    private readonly promptedSourceUris = new Set<string>();
    private readonly queueTraceBySourceUri = new Map<string, QueueTraceMeta>();

    constructor(
        @inject(TYPES.IActionDispatcher) private readonly actionDispatcher: IActionDispatcher,
        @inject(EditorContextService) private readonly editorContext: EditorContextService
    ) {}

    buildNavigationTrail(
        currentSourceUri: string | undefined,
        targetSourceUri: string,
        targetWorkflowName: string,
        targetWorkflowInstanceName?: string
    ): NavigationCrumb[] {
        const currentSourceKey = currentSourceUri ? normalizeSourceUriKey(currentSourceUri) : undefined;
        const targetSourceKey = normalizeSourceUriKey(targetSourceUri);
        const fromCurrent = currentSourceKey ? (this.stacksBySourceUri.get(currentSourceKey) ?? []) : [];
        const trail = [...fromCurrent];

        if (trail.length === 0 && currentSourceKey) {
            const context = (globalThis as any).__calDiagramContext;
            const currentWorkflowName = typeof context?.workflowName === 'string' ? context.workflowName.trim() : '';
            if (currentWorkflowName !== '') {
                trail.push({ sourceUri: currentSourceKey, workflowName: currentWorkflowName });
            }
        }

        const normalized = this.normalizeTrail(trail);
        const next = [...normalized, {
            sourceUri: targetSourceKey,
            workflowName: targetWorkflowName,
            ...(typeof targetWorkflowInstanceName === 'string' && targetWorkflowInstanceName.trim() !== ''
                ? { workflowInstanceName: targetWorkflowInstanceName.trim() }
                : {})
        }];
        return this.normalizeTrail(next);
    }

    noteNavigate(sourceUri: string | undefined, workflowName: string, trail?: NavigationCrumb[]): void {
        if (!sourceUri) {
            return;
        }
        const sourceKey = normalizeSourceUriKey(sourceUri);

        if (Array.isArray(trail) && trail.length > 0) {
            this.stacksBySourceUri.set(sourceKey, this.normalizeTrail(trail));
            return;
        }

        const stack = this.stacksBySourceUri.get(sourceKey) ?? [];
        if (stack.length === 0) {
            this.stacksBySourceUri.set(sourceKey, [{ sourceUri: sourceKey, workflowName }]);
            return;
        }
        const last = stack[stack.length - 1];
        if (last?.sourceUri === sourceKey && last?.workflowName === workflowName) {
            return;
        }
        this.stacksBySourceUri.set(sourceKey, [...stack, { sourceUri: sourceKey, workflowName }]);
    }

    onModelChanged(root: unknown): void {
        const args = ((root as any)?.args ?? {}) as RootArgs;
        const sourceUriRaw = args.sourceUri ?? this.editorContext.sourceUri;
        if (!sourceUriRaw) {
            return;
        }
        const sourceUri = normalizeSourceUriKey(sourceUriRaw);

        const available = Array.isArray(args['wf:availableWorkflows']) ? args['wf:availableWorkflows'] : [];
        const availableRuns = this.parseRunOptions(args['wf:availableRuns']);
        const entryWorkflows = Array.isArray(args['wf:rootWorkflows']) ? args['wf:rootWorkflows'] : [];
        const graphErrors = this.parseGraphLoadErrors(args['wf:errors']);
        const graphIsTruncated = args['wf:partial'] === true;
        const isPartialGraph = graphIsTruncated || graphErrors.length > 0;
        const renderableNodeCount = this.countRenderableNodes(root);
        const parentWorkflows = this.parseParentWorkflowOptions(args['wf:parentWorkflows'], sourceUri);
        const selected = args['wf:selectedWorkflow'] ?? args['cal:networkName'];
        const selectedRunId = typeof args['wf:selectedRunId'] === 'string' && args['wf:selectedRunId'].trim() !== ''
            ? args['wf:selectedRunId'].trim()
            : undefined;
        if (!selected) {
            return;
        }

        const stepRaw = args['wf:queueTraceStep'];
        const stepCountRaw = args['wf:queueTraceStepCount'];
        const step = typeof stepRaw === 'number' && Number.isFinite(stepRaw) ? Math.max(0, Math.trunc(stepRaw)) : 0;
        const stepCount = typeof stepCountRaw === 'number' && Number.isFinite(stepCountRaw) ? Math.max(0, Math.trunc(stepCountRaw)) : 0;
        const actor = typeof args['wf:queueTraceActor'] === 'string' && args['wf:queueTraceActor'].trim() !== ''
            ? args['wf:queueTraceActor'].trim()
            : undefined;
        if (isQueueTraceVisible() && stepCount > 0) {
            this.queueTraceBySourceUri.set(sourceUri, { step, stepCount, actor });
        } else {
            this.queueTraceBySourceUri.delete(sourceUri);
        }

        // Expose latest context for UI bits that are not DI-managed (e.g. GLSP tool palette header).
        try {
            (globalThis as any).__calDiagramContext = {
                sourceUri,
                workflowName: selected,
                runtimeProfile: typeof args['wf:runtimeProfile'] === 'string' ? args['wf:runtimeProfile'] : undefined,
                namespaceName: args['wf:namespace'],
                selectedRunId,
                queueTraceVisible: isQueueTraceVisible()
            };
        } catch {
            // ignore
        }

        const incomingTrail = this.parseTrail(args[NAV_TRAIL_ARG]);
        const nextStack = this.reconcileStack(sourceUri, selected, entryWorkflows, incomingTrail);
        this.stacksBySourceUri.set(sourceUri, nextStack);

        const runtimeProfile = typeof args['wf:runtimeProfile'] === 'string' ? args['wf:runtimeProfile'] : undefined;

        this.render(sourceUri, nextStack, {
            available,
            availableRuns,
            entryWorkflows,
            graphErrors,
            isPartialGraph,
            graphIsTruncated,
            parentWorkflows,
            renderableNodeCount,
            runtimeProfile,
            selected,
            selectedRunId,
            queueTrace: this.queueTraceBySourceUri.get(sourceUri)
        });

        this.maybePromptForEntryWorkflow(sourceUri, entryWorkflows, selected, runtimeProfile);
    }

    private reconcileStack(
        sourceUri: string,
        selected: string,
        roots: string[],
        incomingTrail: NavigationCrumb[]
    ): NavigationCrumb[] {
        if (incomingTrail.length > 0) {
            const last = incomingTrail[incomingTrail.length - 1];
            if (last.sourceUri === sourceUri && last.workflowName === selected) {
                return incomingTrail;
            }
        }

        const current = this.stacksBySourceUri.get(sourceUri) ?? [];
        if (current.length === 0) {
            return [{ sourceUri, workflowName: selected }];
        }

        // If server switched to a different root, reset the stack.
        const hasCrossFileTrail = current.some(entry => entry.sourceUri !== sourceUri);
        if (roots.includes(selected) && current[0]?.workflowName !== selected && !hasCrossFileTrail) {
            return [{ sourceUri, workflowName: selected }];
        }

        const idx = current.findIndex(entry => entry.sourceUri === sourceUri && entry.workflowName === selected);
        if (idx >= 0) {
            return current.slice(0, idx + 1);
        }

        return [...current, { sourceUri, workflowName: selected }];
    }

    private async maybePromptForEntryWorkflow(
        sourceUri: string,
        roots: string[],
        selected: string,
        runtimeProfile?: string
    ): Promise<void> {
        if (roots.length <= 1) {
            return;
        }

        // Avoid annoying prompts when there is an obvious entry point.
        const preferred = new Set(['BuildAndRun', 'Main', 'main', 'Entry', 'entry']);
        if (preferred.has(selected)) {
            return;
        }

        const stored = this.getStoredEntryWorkflow(sourceUri);
        if (stored && roots.includes(stored)) {
            return;
        }

        if (this.promptedSourceUris.has(sourceUri)) {
            return;
        }
        this.promptedSourceUris.add(sourceUri);

        queueMicrotask(async () => {
            const entryLabel = navigationEntityLabel();
            const picked = await VscodeUi.instance.quickPick({
                placeHolder: `Select entry ${entryLabel.toLowerCase()} to display`,
                items: roots.map((r) => ({ id: r, label: r }))
            });
            if (!picked || picked === selected) {
                return;
            }
            this.setStoredEntryWorkflow(sourceUri, picked);
            const nextTrail = [{ sourceUri, workflowName: picked }];
            this.stacksBySourceUri.set(sourceUri, nextTrail);
            void this.actionDispatcher.dispatch(this.requestModel(sourceUri, picked, undefined, nextTrail));
        });
    }

    private render(
        sourceUri: string,
        stack: NavigationCrumb[],
        meta: RenderMeta
    ): void {
        // The breadcrumb trail lives in its own always-visible floating overlay
        // on the canvas (bottom-left), so it stays visible regardless of the
        // property panel.
        this.renderBreadcrumbOverlay(sourceUri, stack, meta.selectedRunId);

        // Queue-trace, runs, workflow-switch and caller pickers live in a
        // floating button stack (bottom-right, above the chat FAB).
        this.renderFabs(sourceUri, stack, meta);

        // Partial-graph warning is a small floating chip (top-center).
        this.renderGraphWarning(meta);

        this.renderCenterIssueOverlay(
            computeGraphLoadIssueOverlayState({
                isPartialGraph: meta.isPartialGraph,
                graphErrors: meta.graphErrors,
                renderableNodeCount: meta.renderableNodeCount
            }),
            meta.graphErrors
        );
    }

    /**
     * Small floating "partial graph" warning chip (top-center). Replaces the
     * banner that used to live in the now-removed bottom bar; the prominent
     * center overlay still handles severe cases separately.
     */
    private renderGraphWarning(meta: RenderMeta): void {
        if (!meta.isPartialGraph) {
            if (this.graphWarningEl) {
                this.graphWarningEl.hidden = true;
            }
            return;
        }
        if (!this.graphWarningEl) {
            const chip = document.createElement('div');
            chip.className = 'workflow-graph-warning';
            chip.id = 'workflow-graph-warning';
            document.body.appendChild(chip);
            this.graphWarningEl = chip;
        }
        this.graphWarningEl.textContent = graphWarningText(
            meta.graphErrors.map(error => error.message),
            meta.graphIsTruncated
        );
        this.graphWarningEl.title = meta.graphErrors.length > 0
            ? meta.graphErrors.map(error => this.describeGraphLoadError(error)).join('\n')
            : 'Graph export completed with recoverable errors.';
        this.graphWarningEl.hidden = false;
    }

    /**
     * Build a fresh breadcrumb element for the given navigation stack. Each
     * ancestor crumb is clickable (same-file → RequestModel, cross-file →
     * NavigateToExternalTarget); the current (last) crumb is inert. A new node
     * is returned on every call so the same trail can be mounted in more than
     * one place (bar + property-panel footer).
     */
    private buildBreadcrumbEl(
        sourceUri: string,
        stack: NavigationCrumb[],
        selectedRunId?: string
    ): HTMLDivElement {
        const crumb = document.createElement('div');
        crumb.className = 'workflow-wf-breadcrumbs';

        const currentSourceKey = normalizeSourceUriKey(sourceUri);

        stack.forEach((entry, idx) => {
            if (idx > 0) {
                const sep = document.createElement('span');
                sep.className = 'workflow-wf-breadcrumb-sep';
                sep.textContent = '/';
                crumb.appendChild(sep);
            }

            const btn = document.createElement('button');
            btn.className = 'workflow-wf-breadcrumb';
            const displayName = entry.workflowInstanceName || entry.workflowName;
            btn.textContent = displayName;
            const isCrossFile = entry.sourceUri !== currentSourceKey;
            btn.title = idx === stack.length - 1
                ? `Current: ${displayName}`
                : (isCrossFile ? `Open ${displayName} in referenced file` : `Go back to ${displayName}`);
            btn.disabled = idx === stack.length - 1;
            btn.addEventListener('click', () => {
                const nextTrail = stack.slice(0, idx + 1);
                const next = nextTrail[nextTrail.length - 1];
                this.stacksBySourceUri.set(next.sourceUri, nextTrail);
                if (next.sourceUri === currentSourceKey) {
                    void this.actionDispatcher.dispatch(this.requestModel(next.sourceUri, next.workflowName, undefined, nextTrail, selectedRunId));
                    return;
                }
                void this.actionDispatcher.dispatch(
                    NavigateToExternalTargetAction.create({
                        uri: next.sourceUri,
                        args: {
                            [OPEN_DIAGRAM_ARG]: true,
                            [NETWORK_NAME_ARG]: next.workflowName,
                            [NAV_TRAIL_ARG]: this.serializeTrail(nextTrail),
                            ...(selectedRunId ? { [RUN_ID_ARG]: selectedRunId } : {})
                        }
                    })
                );
            });
            crumb.appendChild(btn);
        });

        return crumb;
    }

    /**
     * Render the breadcrumb trail into its own always-visible floating overlay
     * pinned to the bottom-left of the canvas. Shown only when a trail exists,
     * so navigation stays available with nothing selected and regardless of the
     * property panel's visibility.
     */
    private renderBreadcrumbOverlay(
        sourceUri: string,
        stack: NavigationCrumb[],
        selectedRunId?: string
    ): void {
        if (!this.breadcrumbEl) {
            const overlay = document.createElement('div');
            overlay.className = 'workflow-breadcrumb-overlay';
            overlay.id = 'workflow-breadcrumb-overlay';
            document.body.appendChild(overlay);
            this.breadcrumbEl = overlay;
        }
        if (stack.length === 0) {
            this.breadcrumbEl.replaceChildren();
            this.breadcrumbEl.hidden = true;
            return;
        }
        this.breadcrumbEl.replaceChildren(this.buildBreadcrumbEl(sourceUri, stack, selectedRunId));
        this.breadcrumbEl.hidden = false;
    }

    private renderCenterIssueOverlay(
        issue: GraphLoadIssueOverlayState | undefined,
        graphErrors: GraphLoadError[]
    ): void {
        if (!issue) {
            if (this.centerIssueEl) {
                this.centerIssueEl.remove();
                this.centerIssueEl = undefined;
            }
            return;
        }

        if (!this.centerIssueEl) {
            const overlay = document.createElement('div');
            overlay.className = 'workflow-center-issue-overlay';
            overlay.id = 'workflow-center-issue-overlay';
            document.body.appendChild(overlay);
            this.centerIssueEl = overlay;
        }

        const card = document.createElement('div');
        card.className = 'workflow-center-issue-card';
        if (graphErrors.length > 0) {
            card.title = graphErrors.map(error => this.describeGraphLoadError(error)).join('\n');
        }

        const title = document.createElement('div');
        title.className = 'workflow-center-issue-title';
        title.textContent = issue.title;

        const body = document.createElement('div');
        body.className = 'workflow-center-issue-body';
        body.textContent = issue.message;

        card.appendChild(title);
        card.appendChild(body);

        if (issue.hint) {
            const hint = document.createElement('div');
            hint.className = 'workflow-center-issue-hint';
            hint.textContent = issue.hint;
            card.appendChild(hint);
        }

        this.centerIssueEl.replaceChildren(card);
    }

    private requestModel(
        sourceUri: string,
        workflowName: string,
        queueTraceStep?: number,
        trail?: NavigationCrumb[],
        runId?: string
    ): RequestModelAction {
        const sourceKey = normalizeSourceUriKey(sourceUri);
        return RequestModelAction.create({
            requestId: `nav-${Date.now()}`,
            options: {
                sourceUri: sourceKey,
                diagramType: this.editorContext.diagramType,
                networkName: workflowName,
                queueTraceVisible: isQueueTraceVisible(),
                ...(typeof queueTraceStep === 'number' ? { queueTraceStep } : {}),
                ...(typeof runId === 'string' && runId.trim() !== '' ? { [RUN_ID_ARG]: runId.trim() } : {}),
                ...(Array.isArray(trail) && trail.length > 0 ? { [NAV_TRAIL_ARG]: this.serializeTrail(trail) } : {}),
            }
        });
    }

    /**
     * Floating button stack (bottom-right, above the chat FAB). A flex column
     * (column-reverse) so hidden buttons collapse without leaving gaps. Order
     * bottom→top (above the chat FAB): Runs, Workflows, Debug, Used By. The
     * Debug button sits in a row with its inline queue-trace cluster
     * (◀ / step / ▶) so the cluster stays aligned regardless of which other
     * buttons are visible. Created lazily, once.
     */
    private ensureFabs(): void {
        if (this.fabStackEl) {
            return;
        }

        const stack = document.createElement('div');
        stack.className = 'workflow-fab-stack';
        stack.id = 'workflow-fab-stack';
        document.body.appendChild(stack);
        this.fabStackEl = stack;

        // Debug row: inline cluster (left) + toggle button (right).
        const debugRow = document.createElement('div');
        debugRow.className = 'workflow-fab-row';
        debugRow.hidden = true;

        const cluster = document.createElement('div');
        cluster.className = 'workflow-debug-cluster';
        cluster.hidden = true;
        this.debugClusterEl = cluster;

        const debug = this.createFabButton('debug-alt', 'Queue-trace navigation', () => {
            this.debugExpanded = !this.debugExpanded;
            const ctx = this.lastDebugCtx;
            if (ctx) {
                this.renderFabs(ctx.sourceUri, ctx.stack, ctx.meta);
            }
        });
        debug.classList.add('workflow-debug-toggle-btn');
        this.debugFabEl = debug;
        debugRow.appendChild(cluster);
        debugRow.appendChild(debug);
        this.debugRowEl = debugRow;

        const runs = this.createFabButton('history', 'Run history', () => {
            const ctx = this.lastDebugCtx;
            if (ctx) {
                void this.pickRun(ctx.sourceUri, ctx.stack, ctx.meta);
            }
        });
        runs.hidden = true;
        this.runsFabEl = runs;

        const workflows = this.createFabButton('list-tree', 'Switch workflow', () => {
            const ctx = this.lastDebugCtx;
            if (ctx) {
                void this.pickWorkflow(ctx.sourceUri, ctx.stack, ctx.meta);
            }
        });
        workflows.hidden = true;
        this.workflowsFabEl = workflows;

        const usedBy = this.createFabButton('references', 'Jump to a caller', () => {
            const ctx = this.lastDebugCtx;
            if (ctx) {
                void this.pickParentWorkflow(ctx.sourceUri, ctx.stack, ctx.meta);
            }
        });
        usedBy.hidden = true;
        this.usedByFabEl = usedBy;

        // Append bottom→top (column-reverse): Used By, Debug, Workflows, Runs.
        // The chat button is reparented in on top of these (see renderFabs),
        // giving a final top→bottom order of Chat, Runs, Workflows, Debug, Used By.
        stack.appendChild(usedBy);
        stack.appendChild(debugRow);
        stack.appendChild(workflows);
        stack.appendChild(runs);
    }

    /**
     * Pull the chat toggle button (owned by the chat panel, created as a direct
     * child of <body>) into the FAB stack as its last child, so it renders at
     * the TOP of the column (column-reverse) with the nav buttons beneath it —
     * and the whole column stays gap-free when buttons hide. No-op once moved,
     * and harmless when chat is disabled (e.g. a run-only profile) and the button is absent.
     */
    private attachChatButtonToStack(): void {
        if (!this.fabStackEl) {
            return;
        }
        const chatBtn = document.getElementById('workflow-chat-toggle-btn');
        if (chatBtn && chatBtn.parentElement !== this.fabStackEl) {
            this.fabStackEl.appendChild(chatBtn);
        }
    }

    private createFabButton(codicon: string, title: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'workflow-fab-btn';
        btn.innerHTML = `<span class="codicon codicon-${codicon}"></span>`;
        btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    private renderFabs(sourceUri: string, stack: NavigationCrumb[], meta: RenderMeta): void {
        this.ensureFabs();
        if (!this.debugFabEl || !this.debugClusterEl || !this.debugRowEl
            || !this.runsFabEl || !this.workflowsFabEl || !this.usedByFabEl) {
            return;
        }
        this.attachChatButtonToStack();
        this.lastDebugCtx = { sourceUri, stack, meta };

        const singularLabel = navigationEntityLabel();
        const pluralLabel = navigationEntityLabel(true);

        // Workflows / Used By: shown when there's something to pick.
        this.workflowsFabEl.hidden = meta.available.length === 0;
        this.workflowsFabEl.title = `Switch ${singularLabel.toLowerCase()} (${pluralLabel.toLowerCase()} in this file)`;
        this.usedByFabEl.hidden = meta.parentWorkflows.length === 0;
        this.usedByFabEl.title = `Jump to a caller ${singularLabel.toLowerCase()}`;

        // Runs button: shown whenever there's run history to pick from.
        const runsCurrent = meta.availableRuns.find(run => run.runId === meta.selectedRunId) ?? meta.availableRuns[0];
        this.runsFabEl.hidden = meta.availableRuns.length === 0;
        this.runsFabEl.title = runsCurrent ? `Run history — current: ${runsCurrent.label}` : 'Run history';

        // Debug row: shown when there's a queue-trace context to step through.
        const hasQueueContext = isQueueTraceVisible() && (!!meta.selectedRunId || !!meta.queueTrace);
        if (!hasQueueContext) {
            this.debugRowEl.hidden = true;
            this.debugClusterEl.hidden = true;
            this.debugClusterEl.replaceChildren();
            this.debugExpanded = false;
            return;
        }

        this.debugRowEl.hidden = false;
        this.debugFabEl.classList.toggle('active', this.debugExpanded);

        if (!this.debugExpanded) {
            this.debugClusterEl.hidden = true;
            this.debugClusterEl.replaceChildren();
            return;
        }

        this.renderDebugCluster(this.debugClusterEl, sourceUri, stack, meta);
        this.debugClusterEl.hidden = false;
    }

    private async pickWorkflow(sourceUri: string, stack: NavigationCrumb[], meta: RenderMeta): Promise<void> {
        if (meta.available.length === 0) {
            return;
        }
        const singularLabel = navigationEntityLabel();
        const picked = await VscodeUi.instance.quickPick({
            placeHolder: `Select ${singularLabel.toLowerCase()} to display`,
            items: meta.available.map((w) => ({ id: w, label: w }))
        });
        if (!picked || picked === meta.selected) {
            return;
        }
        this.setStoredEntryWorkflow(sourceUri, picked);
        const nextTrail = [{ sourceUri, workflowName: picked }];
        this.stacksBySourceUri.set(sourceUri, nextTrail);
        void this.actionDispatcher.dispatch(this.requestModel(sourceUri, picked, undefined, nextTrail, meta.selectedRunId));
    }

    private async pickParentWorkflow(sourceUri: string, stack: NavigationCrumb[], meta: RenderMeta): Promise<void> {
        if (meta.parentWorkflows.length === 0) {
            return;
        }
        const singularLabel = navigationEntityLabel();
        const picked = await VscodeUi.instance.quickPick({
            placeHolder: `Select caller ${singularLabel.toLowerCase()}`,
            items: meta.parentWorkflows.map((workflow) => ({ id: `${workflow.sourceUri}::${workflow.workflowName}`, label: workflow.label }))
        });
        if (!picked) {
            return;
        }
        const selectedParent = meta.parentWorkflows.find(workflow => `${workflow.sourceUri}::${workflow.workflowName}` === picked);
        if (!selectedParent) {
            return;
        }
        const existingParentIndex = stack.findIndex(
            entry => entry.sourceUri === selectedParent.sourceUri && entry.workflowName === selectedParent.workflowName
        );
        const nextTrail = existingParentIndex >= 0
            ? stack.slice(0, existingParentIndex + 1)
            : [{ sourceUri: selectedParent.sourceUri, workflowName: selectedParent.workflowName }];
        this.stacksBySourceUri.set(selectedParent.sourceUri, nextTrail);
        if (selectedParent.sourceUri === sourceUri) {
            void this.actionDispatcher.dispatch(this.requestModel(sourceUri, selectedParent.workflowName, undefined, nextTrail, meta.selectedRunId));
            return;
        }
        void this.actionDispatcher.dispatch(
            NavigateToExternalTargetAction.create({
                uri: selectedParent.sourceUri,
                args: {
                    [OPEN_DIAGRAM_ARG]: true,
                    [NETWORK_NAME_ARG]: selectedParent.workflowName,
                    [NAV_TRAIL_ARG]: this.serializeTrail(nextTrail),
                    ...(meta.selectedRunId ? { [RUN_ID_ARG]: meta.selectedRunId } : {})
                }
            })
        );
    }

    private async pickRun(sourceUri: string, stack: NavigationCrumb[], meta: RenderMeta): Promise<void> {
        if (meta.availableRuns.length === 0) {
            return;
        }
        const picked = await VscodeUi.instance.quickPick({
            placeHolder: 'Select a run from wf-out history',
            items: meta.availableRuns.map(run => ({
                id: run.runId,
                label: run.running ? `$(loading~spin) ${run.label}` : run.label
            }))
        });
        if (!picked || picked === meta.selectedRunId) {
            return;
        }
        void this.actionDispatcher.dispatch(this.requestModel(sourceUri, meta.selected, undefined, stack, picked));
    }

    private renderDebugCluster(
        container: HTMLDivElement,
        sourceUri: string,
        stack: NavigationCrumb[],
        meta: RenderMeta
    ): void {
        container.replaceChildren();

        const queueTrace = meta.queueTrace && meta.queueTrace.stepCount > 0 ? meta.queueTrace : undefined;

        const prev = document.createElement('button');
        prev.className = 'workflow-wf-nav-button';
        prev.textContent = '◀';
        prev.title = queueTrace ? 'Previous queue-trace step' : 'Queue trace unavailable for this run';
        prev.disabled = !queueTrace || queueTrace.step <= 0;
        prev.addEventListener('click', () => {
            if (!queueTrace) {
                return;
            }
            const nextStep = Math.max(0, queueTrace.step - 1);
            void this.actionDispatcher.dispatch(this.requestModel(sourceUri, meta.selected, nextStep, stack, meta.selectedRunId));
        });

        const status = document.createElement('span');
        status.className = 'workflow-wf-nav-queue-status';
        if (queueTrace) {
            const stepLabel = `${queueTrace.step + 1}/${queueTrace.stepCount}`;
            status.textContent = queueTrace.actor ? `${stepLabel} · ${queueTrace.actor}` : stepLabel;
        } else {
            status.textContent = 'No queue trace';
        }
        status.title = status.textContent;

        const next = document.createElement('button');
        next.className = 'workflow-wf-nav-button';
        next.textContent = '▶';
        next.title = queueTrace ? 'Next queue-trace step' : 'Queue trace unavailable for this run';
        next.disabled = !queueTrace || queueTrace.step >= queueTrace.stepCount - 1;
        next.addEventListener('click', () => {
            if (!queueTrace) {
                return;
            }
            const nextStep = Math.min(queueTrace.stepCount - 1, queueTrace.step + 1);
            void this.actionDispatcher.dispatch(this.requestModel(sourceUri, meta.selected, nextStep, stack, meta.selectedRunId));
        });

        container.appendChild(prev);
        container.appendChild(status);
        container.appendChild(next);
    }

    private parseRunOptions(raw: unknown): RunOption[] {
        const parsed = typeof raw === 'string' ? this.tryParseTrailString(raw) : raw;
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: RunOption[] = [];
        for (const item of parsed) {
            const runId = typeof (item as any)?.runId === 'string' ? (item as any).runId.trim() : '';
            const label = typeof (item as any)?.label === 'string' ? (item as any).label.trim() : '';
            const running = (item as any)?.running === true;
            if (runId !== '' && label !== '') {
                out.push({ runId, label, ...(running ? { running: true } : {}) });
            }
        }
        return out;
    }

    private countRenderableNodes(root: unknown): number {
        const stack: unknown[] = Array.isArray((root as any)?.children)
            ? [...((root as any).children as unknown[])]
            : [];
        let count = 0;

        while (stack.length > 0) {
            const current = stack.pop() as any;
            if (!current || typeof current !== 'object') {
                continue;
            }

            const type = typeof current.type === 'string' ? current.type : '';
            if (type.startsWith('node')) {
                count += 1;
            }

            if (Array.isArray(current.children)) {
                for (const child of current.children) {
                    stack.push(child);
                }
            }
        }

        return count;
    }

    private parseGraphLoadErrors(raw: unknown): GraphLoadError[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        return raw
            .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            .map(entry => {
                const message = typeof entry.message === 'string' ? entry.message.trim() : '';
                if (message === '') {
                    return undefined;
                }
                return {
                    message,
                    ...(typeof entry.file === 'string' && entry.file.trim() !== '' ? { file: entry.file.trim() } : {}),
                    ...(typeof entry.line === 'number' && Number.isFinite(entry.line) ? { line: entry.line } : {}),
                    ...(typeof entry.column === 'number' && Number.isFinite(entry.column) ? { column: entry.column } : {})
                };
            })
            .filter((entry): entry is GraphLoadError => entry !== undefined);
    }

    private describeGraphLoadError(error: GraphLoadError): string {
        const locationParts: string[] = [];
        if (error.file) {
            locationParts.push(error.file);
        }
        if (typeof error.line === 'number') {
            locationParts.push(typeof error.column === 'number' ? `${error.line}:${error.column}` : String(error.line));
        }
        return locationParts.length > 0 ? `${error.message} (${locationParts.join(' ')})` : error.message;
    }

    private parseParentWorkflowOptions(raw: unknown, currentSourceUri: string): ParentWorkflowOption[] {
        const parsed = typeof raw === 'string' ? this.tryParseTrailString(raw) : raw;
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: ParentWorkflowOption[] = [];
        const seen = new Set<string>();
        for (const item of parsed) {
            const workflowName = typeof (item as any)?.workflowName === 'string'
                ? (item as any).workflowName.trim()
                : (typeof item === 'string' ? item.trim() : '');
            const sourceUri = typeof (item as any)?.sourceUri === 'string' && (item as any).sourceUri.trim() !== ''
                ? normalizeSourceUriKey((item as any).sourceUri)
                : currentSourceUri;
            if (workflowName === '') {
                continue;
            }
            const dedupeKey = `${sourceUri}::${workflowName}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            out.push({
                sourceUri,
                workflowName,
                label: labelForParentWorkflow({ sourceUri, workflowName }, currentSourceUri)
            });
        }
        return out;
    }

    private parseTrail(raw: unknown): NavigationCrumb[] {
        const parsed = typeof raw === 'string' ? this.tryParseTrailString(raw) : raw;
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: NavigationCrumb[] = [];
        for (const item of parsed) {
            const sourceUri = typeof (item as any)?.sourceUri === 'string' ? (item as any).sourceUri.trim() : '';
            const workflowName = typeof (item as any)?.workflowName === 'string' ? (item as any).workflowName.trim() : '';
            const workflowInstanceName = typeof (item as any)?.workflowInstanceName === 'string'
                ? (item as any).workflowInstanceName.trim()
                : '';
            if (sourceUri !== '' && workflowName !== '') {
                out.push({
                    sourceUri,
                    workflowName,
                    ...(workflowInstanceName !== '' ? { workflowInstanceName } : {})
                });
            }
        }
        return this.normalizeTrail(out);
    }

    private tryParseTrailString(raw: string): unknown {
        try {
            return JSON.parse(raw);
        } catch {
            return undefined;
        }
    }

    private serializeTrail(trail: NavigationCrumb[]): string {
        return JSON.stringify(this.normalizeTrail(trail));
    }

    private normalizeTrail(trail: NavigationCrumb[]): NavigationCrumb[] {
        const normalized: NavigationCrumb[] = [];
        for (const entry of trail) {
            if (!entry || entry.sourceUri.trim() === '' || entry.workflowName.trim() === '') {
                continue;
            }
            const next = {
                sourceUri: normalizeSourceUriKey(entry.sourceUri),
                workflowName: entry.workflowName.trim(),
                ...(typeof entry.workflowInstanceName === 'string' && entry.workflowInstanceName.trim() !== ''
                    ? { workflowInstanceName: entry.workflowInstanceName.trim() }
                    : {})
            };
            const prev = normalized[normalized.length - 1];
            if (
                !prev
                || prev.sourceUri !== next.sourceUri
                || prev.workflowName !== next.workflowName
                || prev.workflowInstanceName !== next.workflowInstanceName
            ) {
                normalized.push(next);
            }
        }
        return normalized;
    }

    private storageKey(sourceUri: string): string {
        return `workflow.entryWorkflow:${normalizeSourceUriKey(sourceUri)}`;
    }

    private getStoredEntryWorkflow(sourceUri: string): string | undefined {
        try {
            return globalThis.localStorage?.getItem(this.storageKey(sourceUri)) ?? undefined;
        } catch {
            return undefined;
        }
    }

    private setStoredEntryWorkflow(sourceUri: string, workflowName: string): void {
        try {
            globalThis.localStorage?.setItem(this.storageKey(sourceUri), workflowName);
        } catch {
            // ignore
        }
    }
}
