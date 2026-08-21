import { codiconCSSClasses } from '@eclipse-glsp/sprotty';
import { VscodeUi } from './vscode-ui';
import { commandId, feedbackEdgesVisibleStorageKey, queueTraceVisibleStorageKey } from './profile';

type DiagramContext = {
    sourceUri?: string;
    workflowName?: string;
    runtimeProfile?: string;
    namespaceName?: string;
    queueTraceVisible?: boolean;
};

const QUEUE_TRACE_VISIBLE_STORAGE_KEY = queueTraceVisibleStorageKey();

function isQueueTraceVisible(): boolean {
    try {
        const raw = globalThis.localStorage?.getItem(QUEUE_TRACE_VISIBLE_STORAGE_KEY);
        return raw !== '0';
    } catch {
        return true;
    }
}

function setQueueTraceVisible(visible: boolean): void {
    try {
        globalThis.localStorage?.setItem(QUEUE_TRACE_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
    } catch {
        // ignore
    }
    document.body.classList.toggle('workflow-queue-hidden', !visible);
}

const FEEDBACK_EDGES_VISIBLE_STORAGE_KEY = feedbackEdgesVisibleStorageKey();

/**
 * Whether feedback loops are drawn apart from the other connections.
 *
 * On unless the reader turned it off — the highlight exists because a loop is
 * the thing worth spotting, and a marker nobody switches on marks nothing.
 */
function isFeedbackEdgesVisible(): boolean {
    try {
        return globalThis.localStorage?.getItem(FEEDBACK_EDGES_VISIBLE_STORAGE_KEY) !== '0';
    } catch {
        return true;
    }
}

function setFeedbackEdgesVisible(visible: boolean): void {
    try {
        globalThis.localStorage?.setItem(FEEDBACK_EDGES_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
    } catch {
        // ignore
    }
    // The whole toggle: the server has already marked the edges, so this is a
    // question about looking and never needs the host.
    document.body.classList.toggle('workflow-feedback-edges', visible);
}

function getDiagramContext(): DiagramContext | undefined {
    try {
        return (globalThis as any).__calDiagramContext as DiagramContext | undefined;
    } catch {
        return undefined;
    }
}

function createHeaderIcon(codiconId: string): HTMLElement {
    const icon = document.createElement('i');
    icon.classList.add(...codiconCSSClasses(codiconId));
    icon.tabIndex = 1;
    return icon;
}

function hasCodicon(icon: HTMLElement, id: string): boolean {
    return icon.classList.contains(`codicon-${id}`);
}

type HeaderToolGroup = 'run' | 'queue' | 'layout' | 'misc';

function classifyHeaderTool(icon: HTMLElement, index: number): { order: number; group: HeaderToolGroup } {
    if (icon.classList.contains('cal-run-workflow') || hasCodicon(icon, 'play')) {
        return { order: 10, group: 'run' };
    }
    if (icon.classList.contains('cal-stop-workflow') || hasCodicon(icon, 'debug-stop')) {
        return { order: 11, group: 'run' };
    }
    if (icon.classList.contains('cal-toggle-queues') || hasCodicon(icon, 'eye') || hasCodicon(icon, 'eye-closed')) {
        return { order: 20, group: 'queue' };
    }
    if (icon.classList.contains('cal-toggle-feedback-edges')) {
        return { order: 21, group: 'queue' };
    }

    // Layout/viewport cluster.
    if (hasCodicon(icon, 'screen-normal')) {
        return { order: 30, group: 'layout' };
    }
    if (hasCodicon(icon, 'symbol-property')) {
        return { order: 31, group: 'layout' };
    }
    if (hasCodicon(icon, 'target')) {
        return { order: 32, group: 'layout' };
    }
    if (hasCodicon(icon, 'split-horizontal')) {
        return { order: 33, group: 'layout' };
    }
    if (hasCodicon(icon, 'grid')) {
        return { order: 34, group: 'layout' };
    }

    if (hasCodicon(icon, 'search')) {
        return { order: 40, group: 'misc' };
    }

    return { order: 900 + index, group: 'misc' };
}

function createHeaderSeparator(): HTMLElement {
    const separator = document.createElement('span');
    separator.classList.add('workflow-header-separator');
    separator.setAttribute('aria-hidden', 'true');
    return separator;
}

function reorderAndGroupHeaderTools(headerTools: HTMLElement): void {
    const allChildren = Array.from(headerTools.children) as HTMLElement[];
    const icons = allChildren.filter(child => child.tagName.toLowerCase() === 'i');
    const others = allChildren.filter(child => child.tagName.toLowerCase() !== 'i' && !child.classList.contains('workflow-header-separator'));
    if (icons.length === 0) {
        return;
    }

    const sortedIcons = icons
        .map((icon, index) => ({ icon, ...classifyHeaderTool(icon, index) }))
        .sort((a, b) => a.order - b.order);

    for (const child of allChildren) {
        if (child.classList.contains('workflow-header-separator')) {
            child.remove();
        }
    }

    let previousGroup: HeaderToolGroup | undefined;
    for (const item of sortedIcons) {
        if (previousGroup && previousGroup !== item.group) {
            headerTools.appendChild(createHeaderSeparator());
        }
        headerTools.appendChild(item.icon);
        previousGroup = item.group;
    }

    for (const node of others) {
        headerTools.appendChild(node);
    }
}

async function exec(command: string, args: unknown[] = []): Promise<void> {
    const res: any = await VscodeUi.instance.executeCommand(command, args);
    if (res && typeof res === 'object' && typeof res.error === 'string') {
        VscodeUi.instance.errorMessage(res.error);
    }
}

function patchHeaderTools(headerTools: HTMLElement): void {
    // 1) Replace reset-viewport behavior: screen-normal -> fit + center
    const resetIcon = headerTools.querySelector('i.codicon.codicon-screen-normal') as HTMLElement | null;
    if (resetIcon) {
        resetIcon.title = 'Fit diagram into view (and center)';
        resetIcon.setAttribute('aria-label', resetIcon.title);
        resetIcon.onclick = () => {
            void (async () => {
                await exec(commandId('fitToScreen'));
                resetIcon.focus();
            })();
        };
    }

    // 2) Add Run button as first header tool.
    if (!headerTools.querySelector('i.codicon.codicon-play.cal-run-workflow')) {
        const runIcon = createHeaderIcon('play');
        runIcon.classList.add('cal-run-workflow');
        runIcon.title = 'Run workflow';
        runIcon.setAttribute('aria-label', runIcon.title);
        runIcon.onclick = () => {
            void (async () => {
                const ctx = getDiagramContext();
                if (ctx?.sourceUri && ctx?.workflowName) {
                    await exec(commandId('runWorkflow'), [ctx]);
                } else {
                    // Fallback: host command uses active diagram tab.
                    await exec(commandId('runWorkflow'));
                }
                runIcon.focus();
            })();
        };

        headerTools.insertBefore(runIcon, headerTools.firstChild);
    }

    // 3) Add Stop button to cancel an active workflow run.
    if (!headerTools.querySelector('i.codicon.codicon-debug-stop.cal-stop-workflow')) {
        const stopIcon = createHeaderIcon('debug-stop');
        stopIcon.classList.add('cal-stop-workflow');
        stopIcon.title = 'Stop workflow run';
        stopIcon.setAttribute('aria-label', stopIcon.title);
        stopIcon.onclick = () => {
            void (async () => {
                await exec(commandId('stopWorkflow'));
                stopIcon.focus();
            })();
        };

        headerTools.insertBefore(stopIcon, headerTools.firstChild);
    }

    // 4) Add queue visibility toggle icon.
    if (!headerTools.querySelector('i.cal-toggle-queues')) {
        const queueIcon = createHeaderIcon('eye');
        queueIcon.classList.add('cal-toggle-queues');

        const applyIconState = (visible: boolean): void => {
            queueIcon.classList.toggle('codicon-eye', visible);
            queueIcon.classList.toggle('codicon-eye-closed', !visible);
            queueIcon.classList.toggle('cal-queue-hidden-icon', !visible);
            queueIcon.title = visible ? 'Hide queue overlay' : 'Show queue overlay';
            queueIcon.setAttribute('aria-label', queueIcon.title);
        };

        const initialVisible = isQueueTraceVisible();
        setQueueTraceVisible(initialVisible);
        applyIconState(initialVisible);
        const ctx = getDiagramContext();
        void exec(commandId('setQueueTraceVisible'), [{
            visible: initialVisible,
            sourceUri: ctx?.sourceUri,
            workflowName: ctx?.workflowName
        }]);

        queueIcon.onclick = () => {
            void (async () => {
                const visible = !isQueueTraceVisible();
                setQueueTraceVisible(visible);
                applyIconState(visible);

                const ctx = getDiagramContext();
                await exec(commandId('setQueueTraceVisible'), [{
                    visible,
                    sourceUri: ctx?.sourceUri,
                    workflowName: ctx?.workflowName
                }]);

                queueIcon.focus();
            })();
        };

        headerTools.insertBefore(queueIcon, headerTools.firstChild);
    }

    // 5) Add the feedback-loop highlight toggle.
    if (!headerTools.querySelector('i.cal-toggle-feedback-edges')) {
        const loopIcon = createHeaderIcon('debug-step-back');
        loopIcon.classList.add('cal-toggle-feedback-edges');

        const applyIconState = (visible: boolean): void => {
            loopIcon.classList.toggle('cal-feedback-hidden-icon', !visible);
            loopIcon.title = visible
                ? 'Hide the feedback-loop highlight'
                : 'Highlight connections that close a feedback loop';
            loopIcon.setAttribute('aria-label', loopIcon.title);
            loopIcon.setAttribute('aria-pressed', String(visible));
        };

        const initialVisible = isFeedbackEdgesVisible();
        setFeedbackEdgesVisible(initialVisible);
        applyIconState(initialVisible);

        loopIcon.onclick = () => {
            const visible = !isFeedbackEdgesVisible();
            setFeedbackEdgesVisible(visible);
            applyIconState(visible);
            loopIcon.focus();
        };

        headerTools.insertBefore(loopIcon, headerTools.firstChild);
    }

    // 6) Normalize icon order + visual grouping separators.
    reorderAndGroupHeaderTools(headerTools);
}

export function installToolPaletteHeaderControls(): void {
    const tryPatch = (): boolean => {
        const headerTools = document.querySelector('.tool-palette .palette-header .header-tools') as HTMLElement | null;
        if (!headerTools) {
            return false;
        }
        patchHeaderTools(headerTools);
        return true;
    };

    if (tryPatch()) {
        return;
    }

    const observer = new MutationObserver(() => {
        if (tryPatch()) {
            observer.disconnect();
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
}
