/**
 * What the webview is told about the product behind a diagram, through
 * `window.diagramIdentifier.clientBehavior`. Each field names a behaviour;
 * the product supplies its truth value, and the client reads these instead of
 * comparing a product-identity string. One declaration for the host, the
 * toolkit and the webview.
 */
import type { NodeFamilySpec } from './diagram-seams';

/** One ACP connector as the platform read it (the known agents, the user's
 *  and the workspace's files): what an agent node may name. */
export interface AcpConnectorInfo {
    name: string;
    /** The connector's command resolves on the PATH. */
    available: boolean;
    /** discovered | user | workspace */
    source: string;
    command: string;
    /** The process also serves opencode's HTTP API (revert, message ids). */
    httpApi?: boolean;
    model?: string | null;
    mode?: string | null;
    env?: Record<string, string>;
}

export interface DiagramClientBehavior {
    /** The ACP connectors the property panel offers on an agent's `connector`;
     *  listed per document by the platform from the profile's `chat.acpConnector`. */
    acpConnectors?: AcpConnectorInfo[];
    /** Cross-file drill-down navigation resolves through the graph source model. */
    graphSourceNavigation?: boolean;
    /** Property panel renders the network-model sections and labels. */
    networkPropertySections?: boolean;
    /** Cross-file navigation UI uses the network entity vocabulary. */
    networkNavigationLabels?: boolean;
    /** Sentinel option value/default for the agent CLI-tools "none" selection. */
    noneSentinel?: string;
    /** @deprecated Nothing reads it (node families decide the icon); accepted and ignored. */
    scriptInterpreterCommands?: string[];
    /**
     * Artwork for icon ids this product uses, keyed by id.
     *
     * A palette icon is only a CSS class — GLSP renders `<i class="codicon
     * codicon-<id>">` — so an icon exists only if some rule draws it. The
     * platform's own rules cannot carry a product's mark, so a product supplies
     * the image and the webview writes the rule.
     *
     * Each value is a complete `url(...)` source: a `data:image/svg+xml,...` URI
     * is the portable choice, since a webview cannot load arbitrary file paths.
     * `light`/`dark` are picked by the viewer's theme; give only `dark` and it is
     * used for both.
     */
    paletteIcons?: Record<string, { dark: string; light?: string }>;
    nodeFamilies?: NodeFamilySpec[];
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
    /** Whether selecting an element draws its path: what leads to it in one
     *  colour, what it leads to in another, the rest faded. A node traces every
     *  path through it, an edge itself and its two ends, a container what feeds
     *  it and what it feeds across its frame; a path crosses group frames as
     *  its edge does. Off by default. */
    selectionTrace?: boolean;
    /** Property-panel sections a product does without, each `false` to hide it:
     *  `ports` (the input and output port lists), `annotations` (the raw
     *  definition annotations), `parameters` (the definition's parameters; a
     *  producer's editable fields still show), `entityType` (Basic Info's Type
     *  row and its change-type button). All shown by default. */
    propertySections?: { ports?: boolean; annotations?: boolean; parameters?: boolean; entityType?: boolean };
    /** What the hierarchy outline panel is called (its title and its button's
     *  tooltip); "Hierarchy" by default. */
    outlineTitle?: string;
    /**
     * Whether the host has a chat backend behind this diagram.
     *
     * Derived by the platform from `DiagramProfile.chat`, not supplied by a
     * product: the two must agree, and a field a product sets by hand is a field
     * it can set wrongly. Read it, do not write it.
     *
     * The stock feature module boots a chat panel eagerly. When the host has no
     * chat backend, that panel opened, sent its first message into a host with no
     * handler for it, logged an unknown-method error, and timed out five seconds
     * later — leaving a chat button that could never answer. A consumer that
     * composes the stock features without configuring chat is a normal thing to
     * be; the platform documents that module as the stock product's feature set,
     * which is precisely the case that has to degrade quietly.
     */
    chatBackend?: boolean;
    /**
     * Whether a run can be resumed at a step of its queue trace, which turns on
     * the stepper's resume button and "Rerun from here". Derived from the
     * product's run arguments for it (`cliResumeArgs`), not set by hand.
     */
    resumeAtStep?: boolean;
    /**
     * The profile's status source, as the diagram's context menu offers it:
     * its label and its two commands. Derived by the platform from
     * `DiagramProfile.statusSource`, like {@link chatBackend}; read it, do not
     * write it.
     */
    statusSource?: { label: string; showCommand: string; clearCommand: string };
}

/**
 * The fields a product may set. The other four ({@link DiagramClientBehavior.chatBackend},
 * `acpConnectors`, `resumeAtStep`, `statusSource`) the platform derives on
 * the way to the webview; a product-facing type that declared them would
 * invite setting them by hand, the one way the two halves could disagree.
 */
export type ProductClientBehavior = Omit<DiagramClientBehavior, 'chatBackend' | 'acpConnectors' | 'resumeAtStep' | 'statusSource'>;
