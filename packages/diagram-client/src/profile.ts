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
    /** Whether the host has a chat backend; derived by the platform. */
    chatBackend?: boolean;
    /** The ACP connectors the runtime discovered or the user declared, for an
     *  agent's `connector` (extension-core `AcpConnectorInfo`). */
    acpConnectors?: AcpConnectorInfo[];
    /** Whether a run can be resumed at a step of its queue trace. */
    resumeAtStep?: boolean;
    /** Where a nested workflow defined in another file opens: `in-place` shows it in
     *  this editor, as a view of the editor's root (one editor per hierarchy);
     *  `new-editor` (the default) opens the file in its own editor. */
    nestedNavigation?: 'in-place' | 'new-editor';
    /** Whether a double-click on a node that is not a network instance opens the
     *  source it references in the text editor. Off (the default), such a node
     *  does nothing on double-click. For a product whose leaves have a body of
     *  their own that no diagram shows yet: an HDL module or entity of processes
     *  and assignments lands at its definition. */
    doubleClickOpensSource?: boolean;
    /** Whether anything is written on a wire: the carried label (a width, a
     *  payload type), the queue badge and last-token button of a run, the
     *  index labels of a list connection. Default true. Off, an edge is its
     *  line, and the tooltip on hover still says what it carries. 'once': as
     *  true, but of the edges that leave or reach one port together with the
     *  same carried label, only the first writes it; the others say it in
     *  their tooltip (a node with many edges of one type, all on one trunk). */
    edgeCaptions?: boolean | 'once';
    /** Property-panel sections a product does without, each `false` to hide
     *  it (all shown by default): `ports`, the input and output port lists, for
     *  a product whose pins carry no meaning; `annotations`, the raw
     *  definition annotations, for one whose facts already say it all;
     *  `parameters`, the definition's parameters, for one whose nodes have
     *  none (its own editable fields still show); `entityType`, Basic Info's
     *  Type row (task, workflow) and its change-type button, for one whose
     *  node kinds are its own. */
    propertySections?: { ports?: boolean; annotations?: boolean; parameters?: boolean; entityType?: boolean };
    /** The profile's status source, as the context menu offers it: "Show
     *  <label>" runs `showCommand`, "Clear <label>" runs `clearCommand`.
     *  Derived by the platform from the profile. */
    statusSource?: { label: string; showCommand: string; clearCommand: string };
    /** Whether selecting an element draws its path: what leads to it in one
     *  colour, what it leads to in another, the rest faded. A node traces
     *  every path through it, an edge itself and its two ends, a container
     *  what feeds it and what it feeds across its frame; a path crosses group
     *  frames as its edge does. Off by default. See selection-trace.ts. */
    selectionTrace?: boolean;
    /** What the hierarchy outline panel is called (its title, its button's
     *  tooltip): plain words, "Hierarchy" by default. */
    outlineTitle?: string;
};

export type AcpConnectorInfo = {
    name: string;
    available: boolean;
    source: string;
    command: string;
    httpApi?: boolean;
    model?: string | null;
    mode?: string | null;
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
