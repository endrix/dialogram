/**
 * Sidecar runtime configuration.
 *
 * All product values a sidecar-backed model source needs, supplied by the consuming extension
 * (extension-core's diagram-profile adapter) as configuration. NO product defaults here — the
 * toolkit stays product-neutral; the concrete product values live in the adapter.
 */

import { inject, injectable } from 'inversify';

/** The kinds of definition create-node can produce. */
/**
 * The kinds create-node can produce.
 *
 * Open on purpose. The named ones are what the platform itself knows about; the
 * trailing `(string & {})` lets a product introduce a kind of its own and label
 * it through its profile, without the platform having to learn the word. The
 * literals still autocomplete.
 */
export type CreateNodeTypeKind =
    | 'workflow' | 'task' | 'tool' | 'agent' | 'viewer'
    // eslint-disable-next-line @typescript-eslint/ban-types
    | (string & {});

/**
 * User-visible vocabulary/messages for the create-node flow. Product-supplied — the toolkit
 * carries NO branded text; the consuming extension provides the exact strings per product.
 */
export interface CreateNodeStrings {
    /** Prompt shown when naming a brand-new top-level definition (varies by kind for some products). */
    newTypeNamePrompt: (kind: CreateNodeTypeKind) => string;
    /** Human label for a kind in pickers and error messages (e.g. 'workflow'/'task' vs 'network'/'actor'). */
    typeLabel: (kind: CreateNodeTypeKind) => string;
    /** Placeholder class name shown in the new-type input box (e.g. 'MyWorkflow' vs 'MyNetwork'). */
    classNamePlaceholder: (kind: CreateNodeTypeKind) => string;
    /** Display name of the sidecar used in failure messages (product-supplied, e.g. a 'Foo sidecar' label). */
    sidecarDisplayName: string;
    /** Shown when a capabilities probe response is malformed. */
    invalidCapabilitiesResponse: string;
    /** Shown when required sidecar operations are missing, given the missing op names. */
    missingCapabilities: (missingOps: string[]) => string;
    /** Shown when a list response is malformed, given the attempted action and the missing field. */
    invalidListResponse: (action: string, field: string) => string;
}

/**
 * How a follow-up value is collected once a variant is chosen.
 *
 * `file` and `folder` open the matching workspace dialog; `text` asks for it
 * by hand, which is the only option for a value that does not exist on disk —
 * a URL, or a file the workflow has yet to produce.
 */
export type CreateNodeVariantInput = 'file' | 'folder' | 'text';

/** The value a chosen variant still needs, and how to ask for it. */
export interface CreateNodeVariantFollowUp {
    /** Name of the `createTaskType` argument this fills in. */
    argName: string;
    /** Refuse to continue without it, rather than creating a node that cannot work. */
    required: boolean;
    input: CreateNodeVariantInput;
    /** Shown above the picker, or as the input box's prompt. */
    prompt: string;
    placeHolder?: string;
    /** Confirm label on the open dialog (`file`/`folder` only). */
    openLabel?: string;
    /** Extension filter for the open dialog, e.g. `{ Python: ['py'] }`. */
    filters?: Record<string, string[]>;
    /**
     * Offer to type the path by hand instead of browsing to it.
     *
     * For a target that may not exist yet — one the workflow has still to
     * produce, or a path filled in later — that escape is the whole point.
     * For one that must already exist it is a step in the way, so the dialog
     * opens directly. Defaults to offering it, which is the safe direction:
     * an extra choice beats no way to name the file.
     */
    allowTypedPath?: boolean;
    /** Wording for the browse / type-by-hand / skip choices offered before a dialog. */
    browseLabel?: string;
    typeLabel?: string;
    skipLabel?: string;
}

/** One answer to a variant's question, and what choosing it means. */
export interface CreateNodeVariantChoice {
    label: string;
    description?: string;
    detail?: string;
    /** Arguments this answer contributes to `createTaskType`. */
    args?: Record<string, string>;
    followUp?: CreateNodeVariantFollowUp;
}

/**
 * A palette entry whose shape is chosen in the wizard rather than by its
 * element type.
 *
 * Several such entries share one element type, so the arg is what tells them
 * apart. Everything a person reads here is product vocabulary — the names of
 * the variants, the question that picks between them — so it is declared by
 * the product and the toolkit only runs it. Without this the toolkit would
 * have to name products in its own prompts, which is exactly what it must not
 * do.
 */
export interface CreateNodeVariant {
    /** The palette entry's arg that selects this variant, e.g. `myNodeKind`. */
    paletteArg: string;
    /** The task kind sent to `createTaskType`. */
    kind: CreateNodeTypeKind;
    /** The decorator that identifies one already written in the project. */
    decorator: string;
    /** The question that picks between the choices. */
    prompt: string;
    choices: CreateNodeVariantChoice[];
    /** One last optional free-text value, asked after the choice is resolved. */
    extra?: {
        argName: string;
        prompt: string;
        placeHolder?: string;
    };
}

/**
 * Behavior axes the create-node flow branches on. Product-supplied booleans replace the old
 * product-profile checks — the toolkit no longer knows the product, only the behavior.
 */
export interface CreateNodeBehavior {
    /** Probe `getCapabilities` and validate `supportedOps` before creating a node. */
    capabilityProbeBeforeCreate: boolean;
    /** Merge locally source-scanned project type names into the sidecar-provided type list. */
    mergeProjectDiscoveredTypes: boolean;
    /** Surface sidecar list failures / malformed responses as errors (vs silently tolerating them). */
    surfaceSidecarListErrors: boolean;
}

/** All product values a sidecar-backed server needs. NO product defaults here. */
export interface SidecarRuntimeConfig {
    settingsNamespace: string;
    sidecarOperationPrefix: string;
    sidecarCommandSettingKey: string;
    sidecarCommandDefault: string;
    cliCommandSettingKey: string;
    cliCommandDefault: string;
    cliPythonModule?: string;
    operationKinds: { createEntityPort: string; deleteEntityPort: string };
    /** Op prefixes this runtime accepts when rewriting foreign-prefixed ops
     *  (replaces the hardcoded product-prefix literal check). */
    acceptedOperationPrefixes: string[];
    /** Graph acquisition strategy: 'sidecar-export' or 'cli-plan'. */
    graphAcquisition: 'sidecar-export' | 'cli-plan';
    /** argv builder for the 'cli-plan' path, e.g. (file) => ['plan', file, '--format', 'graph', '--best-effort']. */
    cliGraphArgs?: (file: string, requestedWorkflow?: string) => string[];
    /** Product-specific label prefix for the sidecar-export failure message (the toolkit carries no
     *  product literal); defaults to a neutral 'Graph export failed' when unset. */
    graphExportFailureLabel?: string;
    /** Undo/redo command-label suffix appended by every operation handler (the value your
     *  extension profile supplies, such as a ' (product)' tag). Product-branded, so the toolkit carries none. */
    undoLabelSuffix: string;
    /** User-visible create-node vocabulary/messages; product-supplied (no toolkit defaults). */
    createNodeStrings: CreateNodeStrings;
    /** Create-node behavior axes; product-supplied (replaces the old product-profile branches). */
    createNodeBehavior: CreateNodeBehavior;
    /** Palette entries whose shape is chosen in the wizard; product-supplied, since every
     *  word in them is product vocabulary. Absent means the product contributes none. */
    createNodeVariants?: CreateNodeVariant[];
}

export const SIDECAR_RUNTIME_CONFIG = Symbol('SidecarRuntimeConfig');

function toNonEmptyString(value: string | undefined, fallback: string): string {
    const next = String(value ?? '').trim();
    return next === '' ? fallback : next;
}

function isPythonInterpreterCommand(command: string): boolean {
    return /(^|\/)python(?:\d+(?:\.\d+)*)?$/i.test(command.trim());
}

/** `<prefix>.<opName>` — the fully-qualified sidecar op name for this runtime. */
export function sidecarOp(cfg: SidecarRuntimeConfig, opName: string): string {
    return `${cfg.sidecarOperationPrefix}.${opName}`;
}

/** Resolve the configured sidecar command from VS Code settings (falling back to the default). */
export function getSidecarCommand(
    cfg: SidecarRuntimeConfig,
    vscodeModule: typeof import('vscode'),
    scopeUri?: import('vscode').Uri
): string {
    const config = vscodeModule.workspace.getConfiguration(cfg.settingsNamespace, scopeUri);
    const configured = config.get<string>(cfg.sidecarCommandSettingKey, cfg.sidecarCommandDefault);
    return toNonEmptyString(configured, cfg.sidecarCommandDefault);
}

/**
 * Setting that raises the graph-load deadline, read under the product's own
 * namespace (`<namespace>.graphLoadTimeoutSeconds`).
 *
 * A deadline with no way to raise it turns a legitimately slow workflow into one
 * that can never be opened, so the escape hatch ships with the limit.
 */
export const GRAPH_LOAD_TIMEOUT_SETTING = 'graphLoadTimeoutSeconds';

/**
 * Default deadline for acquiring a graph, in ms.
 *
 * Generous on purpose: acquisition runs the user's own code (importing a module,
 * elaborating a workflow), and a first run can be slow for honest reasons. This
 * is here to catch the child that will NEVER answer, not to police slow ones.
 */
export const DEFAULT_GRAPH_LOAD_TIMEOUT_MS = 120_000;

/**
 * The sentence appended to a deadline-miss message, naming the setting that
 * raises it.
 *
 * A deadline the reader cannot see and cannot change reads as the tool refusing
 * to open their file. Naming the setting in the message is what turns it into a
 * decision they own — and it is the only place the setting is discoverable until
 * each product contributes it to its own `package.json`.
 */
export function graphLoadTimeoutHint(cfg: SidecarRuntimeConfig): string {
    return `If this workflow genuinely needs longer, raise \`${cfg.settingsNamespace}.${GRAPH_LOAD_TIMEOUT_SETTING}\`.`;
}

/** Resolve the graph-load deadline in ms from settings, falling back to the default. */
export function getGraphLoadTimeoutMs(
    cfg: SidecarRuntimeConfig,
    vscodeModule: typeof import('vscode'),
    scopeUri?: import('vscode').Uri
): number {
    const configured = vscodeModule.workspace
        .getConfiguration(cfg.settingsNamespace, scopeUri)
        .get<number>(GRAPH_LOAD_TIMEOUT_SETTING);
    // Zero or negative would mean "time out immediately", which nobody means by
    // it, and a non-number is a typo'd setting. Both fall back to the default.
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured * 1000
        : DEFAULT_GRAPH_LOAD_TIMEOUT_MS;
}

/** Resolve the CLI command from VS Code settings (falling back to the default). */
export function getCliCommand(
    cfg: SidecarRuntimeConfig,
    vscodeModule: typeof import('vscode'),
    scopeUri?: import('vscode').Uri
): string {
    const config = vscodeModule.workspace.getConfiguration(cfg.settingsNamespace, scopeUri);
    const configured = config.get<string>(cfg.cliCommandSettingKey, cfg.cliCommandDefault);
    return toNonEmptyString(configured, cfg.cliCommandDefault);
}

/** Resolve the CLI command + args-prefix (e.g. `python -m <module>` vs a bare binary). */
export function getCliInvocation(
    cfg: SidecarRuntimeConfig,
    vscodeModule: typeof import('vscode'),
    scopeUri?: import('vscode').Uri
): { cmd: string; argsPrefix: string[] } {
    const cmd = getCliCommand(cfg, vscodeModule, scopeUri);
    if (cfg.cliPythonModule && isPythonInterpreterCommand(cmd)) {
        return { cmd, argsPrefix: ['-m', cfg.cliPythonModule] };
    }
    return { cmd, argsPrefix: [] };
}

/**
 * Injectable façade over a {@link SidecarRuntimeConfig}. Was `DiagramServerRuntimeProfileService`
 * in diagram-server; its logic moved here verbatim, driven by the config instead of an injected
 * product profile. `rewriteSidecarOperation` accepts any prefix listed in
 * `cfg.acceptedOperationPrefixes` (the old hardcoded product-prefix literal check is gone).
 */
@injectable()
export class SidecarRuntimeService {
    constructor(
        @inject(SIDECAR_RUNTIME_CONFIG)
        private readonly cfg: SidecarRuntimeConfig
    ) {}

    get settingsNamespace(): string {
        return this.cfg.settingsNamespace;
    }

    get operationKinds(): { createEntityPort: string; deleteEntityPort: string } {
        return this.cfg.operationKinds;
    }

    get undoLabelSuffix(): string {
        return this.cfg.undoLabelSuffix;
    }

    get createNodeStrings(): CreateNodeStrings {
        return this.cfg.createNodeStrings;
    }

    get createNodeBehavior(): CreateNodeBehavior {
        return this.cfg.createNodeBehavior;
    }

    get createNodeVariants(): CreateNodeVariant[] {
        return this.cfg.createNodeVariants ?? [];
    }

    sidecarOp(opName: string): string {
        return sidecarOp(this.cfg, opName);
    }

    rewriteSidecarOperation(operation: string): string {
        const dot = operation.indexOf('.');
        if (dot <= 0) {
            return operation;
        }
        const prefix = operation.slice(0, dot);
        if (!this.cfg.acceptedOperationPrefixes.includes(prefix)) {
            return operation;
        }
        const suffix = operation.slice(dot + 1);
        return this.sidecarOp(suffix);
    }

    getSidecarCommand(vscodeModule: typeof import('vscode'), scopeUri?: import('vscode').Uri): string {
        return getSidecarCommand(this.cfg, vscodeModule, scopeUri);
    }

    getCliCommand(vscodeModule: typeof import('vscode'), scopeUri?: import('vscode').Uri): string {
        return getCliCommand(this.cfg, vscodeModule, scopeUri);
    }

    getCliInvocation(
        vscodeModule: typeof import('vscode'),
        scopeUri?: import('vscode').Uri
    ): { cmd: string; argsPrefix: string[] } {
        return getCliInvocation(this.cfg, vscodeModule, scopeUri);
    }
}
