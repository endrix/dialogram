import type { AcpConnectorInfo, DiagramClientBehavior, DiagramCommandIds } from '@dialogram/shared';

export type { AcpConnectorInfo, DiagramClientBehavior };

type DiagramOperationKinds = {
    createEntityPort?: string;
    deleteEntityPort?: string;
};

type DiagramIdentifier = {
    commandIds?: Partial<DiagramCommandIds>;
    operationKinds?: DiagramOperationKinds;
    settingsNamespace?: string;
    clientBehavior?: DiagramClientBehavior;
};

/** The commands the webview itself runs; the rest the host registers for its own menus. */
type DiagramCommandKey = 'fitToScreen' | 'runWorkflow' | 'stopWorkflow' | 'setQueueTraceVisible' | 'setAgentToolConfig' | 'getAgentToolConfig';
type DiagramOperationKey = keyof Required<DiagramOperationKinds>;

const DEFAULT_COMMAND_IDS: Record<DiagramCommandKey, string> = {
    fitToScreen: 'dialogram.glsp.fitToScreen',
    runWorkflow: 'dialogram.glsp.runWorkflow',
    stopWorkflow: 'dialogram.glsp.stopWorkflow',
    setQueueTraceVisible: 'dialogram.glsp.setQueueTraceVisible',
    setAgentToolConfig: 'dialogram.glsp.setAgentToolConfig',
    getAgentToolConfig: 'dialogram.glsp.getAgentToolConfig'
};

function getDiagramIdentifier(): DiagramIdentifier {
    const raw = (globalThis as any)?.diagramIdentifier;
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    return raw as DiagramIdentifier;
}

export function commandId(key: DiagramCommandKey): string {
    const configured = getDiagramIdentifier().commandIds?.[key];
    if (typeof configured === 'string' && configured.trim() !== '') {
        return configured;
    }
    return DEFAULT_COMMAND_IDS[key];
}

export function operationKind(key: DiagramOperationKey): string | undefined {
    const configured = getDiagramIdentifier().operationKinds?.[key];
    if (typeof configured === 'string' && configured.trim() !== '') {
        return configured;
    }
    return undefined;
}

export function settingsNamespace(): string {
    const configured = getDiagramIdentifier().settingsNamespace;
    if (typeof configured === 'string' && configured.trim() !== '') {
        return configured;
    }
    return 'dialogram';
}

export function queueTraceVisibleStorageKey(): string {
    return `${settingsNamespace()}.queueTraceVisible`;
}

/**
 * Where the feedback-loop highlight remembers its state.
 *
 * Namespaced like the queue key, so each profile keeps its own answer rather
 * than one product's choice following the reader into another.
 */
export function feedbackEdgesVisibleStorageKey(): string {
    return `${settingsNamespace()}.feedbackEdgesVisible`;
}

/**
 * Neutral, host-supplied client behavior flags. The webview consults these
 * instead of comparing a product-identity string to a literal. Returns an empty
 * object when nothing was injected (dev/standalone), which reads as all flags off.
 */
export function clientBehavior(): DiagramClientBehavior {
    const configured = getDiagramIdentifier().clientBehavior;
    return configured && typeof configured === 'object' ? configured : {};
}

/**
 * The host resolves part of the behavior after the webview is up (what depends
 * on the machine or the workspace, e.g. the ACP connectors the runtime knows)
 * and posts it as `dialogram.clientBehavior.merge`; it is folded into the
 * injected identifier so every later {@link clientBehavior} call sees it.
 */
export function mergeClientBehavior(extras: Partial<DiagramClientBehavior>): void {
    const g = globalThis as any;
    if (!g.diagramIdentifier || typeof g.diagramIdentifier !== 'object') {
        g.diagramIdentifier = {};
    }
    g.diagramIdentifier.clientBehavior = { ...(g.diagramIdentifier.clientBehavior ?? {}), ...extras };
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string; payload?: unknown } | undefined;
        if (data?.type === 'dialogram.clientBehavior.merge' && data.payload && typeof data.payload === 'object') {
            mergeClientBehavior(data.payload as Partial<DiagramClientBehavior>);
        }
    });
}
