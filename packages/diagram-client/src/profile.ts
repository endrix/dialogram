import type { NodeFamilySpec } from '@dialogram/shared';

type DiagramCommandIds = {
    fitToScreen?: string;
    runWorkflow?: string;
    stopWorkflow?: string;
    setQueueTraceVisible?: string;
    setAgentToolConfig?: string;
    getAgentToolConfig?: string;
};

type DiagramOperationKinds = {
    createEntityPort?: string;
    deleteEntityPort?: string;
};

type DiagramClientBehavior = {
    graphSourceNavigation?: boolean;
    networkPropertySections?: boolean;
    networkNavigationLabels?: boolean;
    noneSentinel?: string;
    scriptInterpreterCommands?: string[];
    paletteIcons?: Record<string, { dark: string; light?: string }>;
    nodeFamilies?: NodeFamilySpec[];
};

type DiagramIdentifier = {
    commandIds?: DiagramCommandIds;
    operationKinds?: DiagramOperationKinds;
    settingsNamespace?: string;
    clientBehavior?: DiagramClientBehavior;
};

type DiagramCommandKey = keyof Required<DiagramCommandIds>;
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
