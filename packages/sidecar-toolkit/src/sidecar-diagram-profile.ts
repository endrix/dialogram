/**
 * Assemble a sidecar-backed diagram profile from one flat literal of product
 * values.
 *
 * This is the seam between the product shells and the neutral platform: the
 * shell owns every product string/behavior and passes it here as
 * {@link SidecarProfileInput}; this helper wires the toolkit's model source,
 * server/operation modules, edit backend, openability check, run driver,
 * status source, navigation provider and new-source-file commands into the shape the platform's
 * `DiagramProfile` expects. The return type is left to inference so the toolkit
 * needs no `@dialogram/extension-core` dependency; the shell annotates the
 * result as `DiagramProfile` at the assignment site.
 */
import type { DiagramClientAssets, DiagramCommandIds, EntityPaletteItemSpec, NodeFamilySpec, ProductClientBehavior } from '@dialogram/shared';
import * as vscode from 'vscode';
import { DEFAULT_EXPORT_OP, invokeSidecarOp } from './sidecar-graph-export.js';
import { createSourceReferenceContext } from './chat-source-reference.js';
import { createRegistryChatTools, type RegistryChatTool } from './registry-tools.js';
import { RESUME_TOOL } from './run-failure.js';
import { getCliInvocation,
    getGraphLoadTimeoutMs,
    getSidecarCommand,
    type SidecarRuntimeConfig,
    type CreateNodeStrings,
    type CreateNodeVariant,
    type CreateNodeBehavior
} from './server/sidecar-runtime-config.js';
import { createSidecarModelSource } from './server/cli-graph-model-source.js';
import { createSidecarServerModule } from './server/sidecar-server-module.js';
import { createSidecarOperationModules } from './server/operation-modules.js';
import { exportGraphFromCli } from './cli-graph-export.js';
import {
    createDiagramOpenabilityCheck,
    createPredicateOpenabilityCheck,
    type DiagramOpenabilityPredicate
} from './diagram-openability.js';
import { createSidecarEditBackend } from './chat-edit-backend.js';
import { createPythonNavigationProvider } from './python-navigation.js';
import { registerSidecarCommands } from './sidecar-commands.js';
import { registerNewSourceFileCommand } from './new-source-file-command.js';
import { createCliStatusSource, type SidecarStatusSourceInput } from './cli-status-source.js';
import {
    CliRunDriver,
    resumeFailedRunCommandId,
    type CliRunDriverConfig,
    type CliRunDriverHost,
    type AgentToolEntitySettings
} from './cli-run-driver.js';

/**
 * FROZEN workspaceState key for the per-entity agent-tool overrides. Shared by
 * every sidecar-backed product (not per-runtime). Migration is a later concern;
 * the value stays byte-identical here.
 */
const AGENT_TOOL_OVERRIDES_STATE_KEY = 'workflow.agentToolEntityOverrides';

/** The webview behaviour flags a product sets; the platform's `DiagramClientBehavior` minus what it derives itself. */
export type SidecarClientBehavior = ProductClientBehavior;

/**
 * The command ids a sidecar diagram profile carries. A product may name any of
 * them; the ones it leaves out are derived (see {@link resolveSidecarProfileInput}):
 * `<glspClientName>.glsp.<field>` for the diagram commands, and
 * `<sidecarOperationPrefix>.sidecar.edit` / `.send` for the two raw sidecar
 * commands. The derived id is what every product spelled by hand before.
 */
export interface SidecarProfileCommandIds extends DiagramCommandIds {
    sidecarEdit: string;
    sidecarSend: string;
}

/**
 * The live-overlay signature source hookup a run host exposes so the platform's
 * editor provider can drive live-execution glow. Structural twin of the
 * platform's `DiagramRunHost.useLiveOverlaySignatureSource` argument.
 */
interface RunHost extends CliRunDriverHost {
    useLiveOverlaySignatureSource(source: {
        watch(sourceUri: vscode.Uri): { dispose(): void };
        onSignature(listener: (sourceUri: string, signature: string | undefined) => void): { dispose(): void };
    }): void;
}

/**
 * One flat literal of the product values a shell owns: everything sidecar- or
 * product-specific the platform needs enters here.
 */
export interface SidecarProfileInput {
    // Identity + GLSP.
    key: string;
    displayName: string;
    settingsNamespace: string;
    customEditorViewType: string;
    /** Default `glsp.<glspClientName>`. */
    glspClientId?: string;
    /** The first segment of the derived command ids. Default `key`. */
    glspClientName?: string;
    /** Command ids the product spells itself; the rest are derived (see {@link SidecarProfileCommandIds}). */
    commands?: Partial<SidecarProfileCommandIds>;
    /** Default `<sidecarOperationPrefix>.createEntityPort` / `.deleteEntityPort`. */
    operationKinds?: { createEntityPort: string; deleteEntityPort: string };
    /** Neutral behavior flags forwarded into the diagram webview. */
    clientBehavior?: SidecarClientBehavior;
    /**
     * The product's own stylesheets, absolute paths, served into the stock
     * webview after the platform's: how the product's `<kind>-node`,
     * `edge-role-<role>` and family hooks look. Data only; threaded straight
     * onto `DiagramProfile.clientStylesheets`.
     */
    clientStylesheets?: string[];
    /**
     * The product's own webview bundle, absolute paths: a script that calls
     * `startStockDiagram` from `@dialogram/diagram-client/stock-starter` with
     * the product's feature modules, its stylesheet and the directories they
     * load from. Absent, the platform serves its stock bundle. Data only;
     * threaded straight onto `DiagramProfile.clientAssets`.
     */
    clientAssets?: DiagramClientAssets;

    /**
     * A diagram that is a projection of a file drawn by the CLI, with nothing to
     * edit and no sidecar. Default `false`, which changes nothing. `true`:
     *
     * - the profile's `edits` is `'read-only'` and `supportsElementCreation` is
     *   `false` whatever the input says;
     * - the toolkit spawns no sidecar: no capability probe, no openability
     *   probe, no create-node type listing, no sidecar graph export when the
     *   plan fails. `graphAcquisition` must be `'cli-plan'` (assembly throws
     *   otherwise) and the model source reads the graph from the CLI alone;
     * - the chat works read-only: `get_graph` and the session's graph context
     *   come from the CLI plan document, there is no `editBackend` (so the
     *   platform offers no edit slash commands), and the registry listings
     *   and validation verdict, which only a sidecar answers, are not offered;
     * - `sidecarCommandSettingKey`, `sidecarCommandDefault` and `exportOp` may
     *   be left out, and the raw sidecar commands (`commands.sidecarEdit`,
     *   `commands.sidecarSend`) are not registered.
     */
    readOnly?: boolean;

    // Sidecar/CLI transport.
    sidecarOperationPrefix: string;
    /** The setting and default naming the sidecar command. The default is
     *  required unless `readOnly` (assembly throws without it otherwise); the
     *  setting key defaults to `sidecarCommand` when the default is given. */
    sidecarCommandSettingKey?: string;
    sidecarCommandDefault?: string;
    /** The setting naming the CLI command, under `settingsNamespace`. Default `cliCommand`. */
    cliCommandSettingKey?: string;
    cliCommandDefault: string;
    cliPythonModule?: string;
    /** Default `[sidecarOperationPrefix]`. */
    acceptedOperationPrefixes?: string[];
    graphAcquisition: 'sidecar-export' | 'cli-plan';
    cliGraphArgs?: (file: string, requestedWorkflow?: string) => string[];
    /**
     * The runtime arguments that export the whole hierarchy rooted at
     * `rootWorkflow` in `file` (product syntax). With it, a view of a nested
     * workflow, and the outline, are read from one cached export per root
     * instead of a plan per view (see `hierarchy-cache.ts`).
     */
    cliHierarchyArgs?: (file: string, rootWorkflow: string) => string[];
    graphExportFailureLabel?: string;
    /**
     * The run arguments that resume the run in `runDir` at `step` of its queue
     * trace (the step the stepper shows). Product syntax, so the product says
     * it; without it the stepper offers no resume.
     */
    cliResumeArgs?: (runDir: string, step: number) => string[];

    // User-visible strings / behavior.
    /** Appended to every undo label. Default ` (<key>)`. */
    undoLabelSuffix?: string;
    createNodeStrings: CreateNodeStrings;
    createNodeBehavior: CreateNodeBehavior;
    createNodeVariants?: CreateNodeVariant[];

    // Source file + palette.
    /** The extension the product's source files have, with the dot (`.py`). */
    sourceExtension: string;
    /**
     * Every extension the product's source files may have (`['.sv', '.v']`),
     * for a language with more than one. The platform's open/rename commands,
     * the file watcher, the openability probe and the raw sidecar commands
     * accept any of them; new files take the first. `sourceExtension` stays
     * honoured: alone it is the one extension, beside this it is ignored.
     */
    sourceExtensions?: string[];
    /** @deprecated The platform's two Entities lists are gone; declare the rows in `entityPaletteItems`. Accepted and ignored. */
    useAlternateEntityPalette?: boolean;
    /** `false` empties the creation palette — for a diagram that is a projection
     *  of a source artifact and so has nothing to create. Default `true`. */
    supportsElementCreation?: boolean;
    /** The Entities palette: the product's rows, in its order. Plain data; the platform adds none of its own. */
    entityPaletteItems?: EntityPaletteItemSpec[];
    /** @deprecated The platform has no Entities entries of its own any more. Accepted and ignored. */
    platformEntityItems?: boolean;
    nodeFamilies?: NodeFamilySpec[];
    /**
     * The layout the diagrams open with and Layout Diagram runs: `untangled`
     * or `free-ports`, the Layout menu's other two. Absent, Layout Diagram's
     * own.
     */
    defaultLayout?: 'untangled' | 'free-ports';

    // Chat edit backend.
    exportOp?: string;
    /** @deprecated Nothing reads it (the MCP rollback lever is the platform's `dialogram.chat.useGlspMcp`); accepted and ignored. */
    mcpEnabledSetting?: { section: string; key: string; default: boolean };
    /** The op argument that scopes an edit to a sub-graph. Default `workflow`, the sidecar protocol's name for it. */
    scopeArgKey?: string;

    /**
     * The Java ELK server the product ships, for large graphs: its fat jar,
     * relative to the extension's root. Threaded onto `profile.elkServer`; the
     * engine is the person's choice, under `<settingsNamespace>.layout.*`.
     */
    elkServer?: { jar: string };

    // New-source-file scaffold. `template` gives the whole text from the name,
    // for a product whose file is not a decorated Python function; absent, the
    // scaffold is the import line, the decorator and an empty function.
    newContainer: { label: string; decorator: string; importLine: string; template?: (name: string) => string };
    identifierNoun?: string;

    // Openability (omit for "always openable"). With only `probeOp`, the
    // sidecar's answer decides and an undecidable probe opens the file.
    openability?: {
        probeOp?: string;
        decoratorName?: string;
        /**
         * The product's own answer, from the file's text and path. Given, it
         * decides alone: no sidecar probe and no decorator scan run, whatever
         * else is set here (and it is the only form a `readOnly` profile may
         * probe with). A closure crosses the extension API, so it threads
         * straight into the profile's `canOpenSource`.
         *
         * It should be synchronous and cheap -- it runs on every candidate file
         * before anything is on screen -- and look only at the text it is given
         * (a marker, a header, a pattern near the top): no I/O beyond that text,
         * no process, no full parse when a prefix would do. A throw counts as
         * `false`; a file with none of the source extensions is refused before
         * it is called.
         */
        predicate?: DiagramOpenabilityPredicate;
    };

    /**
     * How cross-file navigation targets are resolved. `'python'` uses the
     * Python symbol providers and a `.py` workspace search, and scans sibling
     * Python files for callers; `'none'` (the default) resolves nothing itself:
     * the runtime emits absolute source locators and the platform navigates to
     * them. A Python product names `'python'`.
     */
    navigation?: 'python' | 'none';

    /**
     * Whether a loaded document's own `errors` go to the Problems panel with
     * their file, line and column. A compiler's errors belong there; a Python
     * runtime's recoverable load errors stay in the diagram's overlay. Default
     * `false`.
     */
    documentErrorsToProblems?: boolean;

    /**
     * Node states from a report the CLI prints, shown on demand with the run
     * overlay's drawing: the platform registers the two commands, offers them
     * on the diagram's context menu, and calls `collect` with a runner for the
     * configured CLI (see `cli-status-source.ts`). Independent of the run
     * driver. Absent, there is none.
     */
    statusSource?: SidecarStatusSourceInput;

    // Run driver. The settings it reads under `settingsNamespace`; each
    // defaults to the key every product declares: `runOutputDir`,
    // `liveExecutionGlow`, `agentTools`, `agentToolAuth`, `agentToolPolicy`,
    // `agentToolTimeoutMs`, `agentToolRegistry`, `agentMcpBridgeCmd`.
    runOutputDirSettingKey?: string;
    liveExecutionGlowSettingKey?: string;
    agentToolsSettingKey?: string;
    agentToolAuthSettingKey?: string;
    agentToolPolicySettingKey?: string;
    agentToolTimeoutMsSettingKey?: string;
    agentToolRegistrySettingKey?: string;
    agentMcpBridgeCmdSettingKey?: string;
    /** The setting naming the ACP connector (`<namespace>.<key>`, e.g.
     *  `acp.connector`): the one the chat talks to, offered by the property
     *  panel, and, with `runAcpFlags` on, the run's default (`--acp-connector`).
     *  The platform reads the connectors itself: the known agents on the
     *  PATH, then the runtime's two connectors files, `acpConnectorFiles`. */
    acpConnectorSettingKey?: string;
    /** The runtime's connectors files, relative: `user` under `~/.config`
     *  (`$XDG_CONFIG_HOME`), `workspace` under the project root. Required
     *  with `acpConnectorSettingKey`. */
    acpConnectorFiles?: { user: string; workspace: string };
    /** The setting the run driver forwards as `--agent-cli-acp-permissions`. */
    acpPermissionsSettingKey?: string;
    /** Whether the run driver forwards the two ACP settings to `<cli> run`.
     *  Default true; a product whose `run` is not the workflow runtime's sets
     *  false, and the connector then serves the chat and the panel only. */
    runAcpFlags?: boolean;

    // Chat carry-overs.
    chat: {
        /** @deprecated Nothing reads it; accepted and ignored. */
        name?: string;
        fullName: string;
        skill?: string;
        nodeCommands?: Array<{ command: string; nodeType: string; description: string }>;
        /** The MIME type the agent receives the source file as. Default `text/plain`; a Python product names `text/x-python`. */
        sourceMimeType?: string;
        /**
         * How the session gets its source. `embed` (the default) attaches the
         * file whole (up to the platform's bound) and the resolved graph as
         * JSON, and names a selected node by id. `reference` attaches neither:
         * the graph goes in as a line per node with its file and line, and a
         * selected node as its name, what it is and where to read it, with a
         * link to the file. For a generated design the first fills the agent's
         * context before the question is read.
         */
        sourceContext?: 'embed' | 'reference';
    };

    // Diagram source-file watch globs (default derived from the source extensions).
    watchGlobs?: string[];
}

/** The fields {@link resolveSidecarProfileInput} fills in when the product leaves them out. */
type DerivedSidecarProfileFields =
    | 'glspClientId' | 'glspClientName' | 'operationKinds' | 'cliCommandSettingKey' | 'acceptedOperationPrefixes'
    | 'undoLabelSuffix' | 'scopeArgKey'
    | 'runOutputDirSettingKey' | 'liveExecutionGlowSettingKey' | 'agentToolsSettingKey' | 'agentToolAuthSettingKey'
    | 'agentToolPolicySettingKey' | 'agentToolTimeoutMsSettingKey' | 'agentToolRegistrySettingKey' | 'agentMcpBridgeCmdSettingKey';

/** A {@link SidecarProfileInput} with every derivable field filled in. */
export type ResolvedSidecarProfileInput =
    Omit<SidecarProfileInput, DerivedSidecarProfileFields | 'commands'>
    & Required<Pick<SidecarProfileInput, DerivedSidecarProfileFields>>
    & { commands: SidecarProfileCommandIds };

/** The command ids `input` leaves out, derived as every product spelled them by hand. */
export function resolveSidecarCommandIds(
    input: Pick<SidecarProfileInput, 'key' | 'glspClientName' | 'sidecarOperationPrefix' | 'commands'>
): SidecarProfileCommandIds {
    const client = nonBlank(input.glspClientName) ?? input.key;
    const glsp = (field: string): string => `${client}.glsp.${field}`;
    const given: Partial<Record<keyof SidecarProfileCommandIds, string>> = input.commands ?? {};
    const derived: SidecarProfileCommandIds = {
        openDiagram: glsp('openDiagram'),
        openDiagramSplit: glsp('openDiagramSplit'),
        layoutDiagram: glsp('layoutDiagram'),
        refreshDiagramModel: glsp('refreshDiagramModel'),
        renameEntityByName: glsp('renameEntityByName'),
        undo: glsp('undo'),
        redo: glsp('redo'),
        fitToScreen: glsp('fitToScreen'),
        center: glsp('center'),
        exportSvg: glsp('exportSvg'),
        toggleGrid: glsp('toggleGrid'),
        setQueueTraceVisible: glsp('setQueueTraceVisible'),
        stopWorkflow: glsp('stopWorkflow'),
        runWorkflow: glsp('runWorkflow'),
        layoutDiagramIfNeeded: glsp('layoutDiagramIfNeeded'),
        setAgentToolConfig: glsp('setAgentToolConfig'),
        getAgentToolConfig: glsp('getAgentToolConfig'),
        sidecarEdit: `${input.sidecarOperationPrefix}.sidecar.edit`,
        sidecarSend: `${input.sidecarOperationPrefix}.sidecar.send`,
        createNewContainer: glsp('createNewContainer')
    };
    // Only the ids the platform registers come through: a deprecated id a
    // product still spells, or a key it made up, stays out of the profile.
    const resolved: Record<string, string> = {};
    for (const [field, derivedId] of Object.entries(derived)) {
        resolved[field] = nonBlank(given[field as keyof SidecarProfileCommandIds]) ?? derivedId;
    }
    return resolved as unknown as SidecarProfileCommandIds;
}

/** `value` when it says something; `undefined` for an absent or blank one, so a default applies. */
function nonBlank(value: string | undefined): string | undefined {
    return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * `input` with every field a product may leave out filled in: the command
 * ids, the operation kinds, the GLSP client identity, the setting keys and
 * the undo suffix, each as the products spelled them by hand. A value the
 * product gives wins.
 */
export function resolveSidecarProfileInput(input: SidecarProfileInput): ResolvedSidecarProfileInput {
    const glspClientName = nonBlank(input.glspClientName) ?? input.key;
    const prefix = input.sidecarOperationPrefix;
    return {
        ...input,
        glspClientName,
        glspClientId: nonBlank(input.glspClientId) ?? `glsp.${glspClientName}`,
        commands: resolveSidecarCommandIds(input),
        operationKinds: input.operationKinds ?? {
            createEntityPort: `${prefix}.createEntityPort`,
            deleteEntityPort: `${prefix}.deleteEntityPort`
        },
        sidecarCommandSettingKey: nonBlank(input.sidecarCommandSettingKey)
            ?? (input.sidecarCommandDefault !== undefined ? 'sidecarCommand' : undefined),
        cliCommandSettingKey: nonBlank(input.cliCommandSettingKey) ?? 'cliCommand',
        acceptedOperationPrefixes: input.acceptedOperationPrefixes ?? [prefix],
        undoLabelSuffix: nonBlank(input.undoLabelSuffix) ?? ` (${input.key})`,
        scopeArgKey: nonBlank(input.scopeArgKey) ?? 'workflow',
        runOutputDirSettingKey: nonBlank(input.runOutputDirSettingKey) ?? 'runOutputDir',
        liveExecutionGlowSettingKey: nonBlank(input.liveExecutionGlowSettingKey) ?? 'liveExecutionGlow',
        agentToolsSettingKey: nonBlank(input.agentToolsSettingKey) ?? 'agentTools',
        agentToolAuthSettingKey: nonBlank(input.agentToolAuthSettingKey) ?? 'agentToolAuth',
        agentToolPolicySettingKey: nonBlank(input.agentToolPolicySettingKey) ?? 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: nonBlank(input.agentToolTimeoutMsSettingKey) ?? 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: nonBlank(input.agentToolRegistrySettingKey) ?? 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: nonBlank(input.agentMcpBridgeCmdSettingKey) ?? 'agentMcpBridgeCmd'
    };
}

/** The product's source extensions: `sourceExtensions` when given, else the one `sourceExtension`. */
export function sourceExtensionsOf(input: Pick<SidecarProfileInput, 'sourceExtension' | 'sourceExtensions'>): string[] {
    const many = (input.sourceExtensions ?? []).map(ext => ext.trim()).filter(ext => ext !== '');
    return many.length > 0 ? many : [input.sourceExtension];
}

/**
 * The sidecar command an editable profile must name. Checked here, where the
 * message can say which fields and why, rather than at the first spawn.
 */
function requireSidecarCommand(input: ResolvedSidecarProfileInput): { settingKey: string; commandDefault: string } {
    if (input.sidecarCommandSettingKey === undefined || input.sidecarCommandDefault === undefined) {
        throw new Error(
            'createSidecarDiagramProfile: sidecarCommandSettingKey and sidecarCommandDefault are required unless readOnly is true.'
        );
    }
    return { settingKey: input.sidecarCommandSettingKey, commandDefault: input.sidecarCommandDefault };
}

/** Build the neutral {@link SidecarRuntimeConfig} the toolkit model source needs. */
function sidecarRuntimeConfig(input: ResolvedSidecarProfileInput): SidecarRuntimeConfig {
    return {
        settingsNamespace: input.settingsNamespace,
        sidecarOperationPrefix: input.sidecarOperationPrefix,
        sidecarCommandSettingKey: input.sidecarCommandSettingKey,
        sidecarCommandDefault: input.sidecarCommandDefault,
        readOnly: input.readOnly,
        cliCommandSettingKey: input.cliCommandSettingKey,
        cliCommandDefault: input.cliCommandDefault,
        cliPythonModule: input.cliPythonModule,
        operationKinds: {
            createEntityPort: input.operationKinds.createEntityPort,
            deleteEntityPort: input.operationKinds.deleteEntityPort
        },
        acceptedOperationPrefixes: input.acceptedOperationPrefixes,
        graphAcquisition: input.graphAcquisition,
        exportOp: input.exportOp,
        cliGraphArgs: input.cliGraphArgs,
        cliHierarchyArgs: input.cliHierarchyArgs,
        graphExportFailureLabel: input.graphExportFailureLabel,
        undoLabelSuffix: input.undoLabelSuffix,
        createNodeStrings: input.createNodeStrings,
        createNodeBehavior: input.createNodeBehavior,
        createNodeVariants: input.createNodeVariants,
        navigation: input.navigation,
        documentErrorsToProblems: input.documentErrorsToProblems
    };
}

/**
 * Assemble a sidecar-backed `DiagramProfile`. See {@link SidecarProfileInput}.
 *
 * MUST be invoked inside the dialogram extension's own bundle (platform.cjs).
 * The returned profile carries inversify `ContainerModule`s and DI-decorated
 * operation-handler classes; DI class identities and injection metadata cannot
 * cross an esbuild bundle boundary, so a consumer shell must NOT call this in its
 * own bundle and hand the result across the API — it passes a plain
 * {@link SidecarProfileInput} literal to `DialogramApi.createSidecarDiagramProfile`
 * and lets the platform build the profile in-realm.
 */
/**
 * API surface the Dialogram BASE EXTENSION adds on top of the neutral
 * `DialogramApi` for sidecar-backed consumers. Declared here (not in
 * extension-core's api.ts) so the neutral core carries zero sidecar
 * vocabulary; shells intersect it onto the base type at the call site:
 *
 *     const api = raw as DialogramApi & SidecarDialogramApi;
 *
 * MUST be implemented inside the Dialogram extension's own bundle: the
 * returned profile carries inversify ContainerModules and DI-decorated
 * operation-handler classes, and DI class identities plus injection
 * metadata CANNOT cross an esbuild bundle boundary. Consumers pass only
 * the plain input literal (data + closures cross safely).
 */
export interface SidecarDialogramApi {
    createSidecarDiagramProfile(input: SidecarProfileInput): ReturnType<typeof createSidecarDiagramProfile>;
}

export function createSidecarDiagramProfile(givenInput: SidecarProfileInput) {
    const input = resolveSidecarProfileInput(givenInput);
    // A read-only profile has no sidecar, so the sidecar fields may be absent
    // and nothing may need one; an editable profile must name its sidecar.
    // Both are checked here, where the message can say which field and why,
    // rather than at the first spawn.
    const readOnly = input.readOnly === true;
    const sidecarCommand = readOnly ? undefined : requireSidecarCommand(input);
    const cliGraphArgs = input.cliGraphArgs;
    if (readOnly && (input.graphAcquisition !== 'cli-plan' || !cliGraphArgs)) {
        throw new Error(
            `createSidecarDiagramProfile: readOnly requires graphAcquisition 'cli-plan' with cliGraphArgs (got '${input.graphAcquisition}'): `
            + 'a read-only profile reads its graph from the CLI and never spawns a sidecar.'
        );
    }
    if (readOnly && input.openability?.probeOp && !input.openability.predicate) {
        throw new Error(
            'createSidecarDiagramProfile: readOnly cannot probe a sidecar for openability (openability.probeOp); '
            + 'use openability.predicate or openability.decoratorName.'
        );
    }

    const runtimeConfig = sidecarRuntimeConfig(input);
    const sourceExtensions = sourceExtensionsOf(input);
    const primarySourceExtension = sourceExtensions[0];

    // The product's predicate decides alone when given; otherwise the sidecar
    // probe and the decorator scan, as before.
    const canOpenSource = input.openability?.predicate
        ? createPredicateOpenabilityCheck({
            predicate: input.openability.predicate,
            sourceExtension: primarySourceExtension,
            sourceExtensions
        })
        : input.openability
            ? createDiagramOpenabilityCheck({
                settingsNamespace: input.settingsNamespace,
                sidecarCommandSettingKey: sidecarCommand?.settingKey,
                sidecarCommandDefault: sidecarCommand?.commandDefault,
                sidecarOperationPrefix: input.sidecarOperationPrefix,
                probeOp: input.openability.probeOp,
                sourceExtension: primarySourceExtension,
                sourceExtensions,
                decoratorName: input.openability.decoratorName
            })
            : undefined;

    // No edit backend for a read-only profile: the platform then offers the
    // chat without its edit slash commands (its own gate), and the graph the
    // backend would have exported comes from the CLI below.
    const editBackend = sidecarCommand
        ? createSidecarEditBackend({
            settingsNamespace: input.settingsNamespace,
            sidecarCommandSettingKey: sidecarCommand.settingKey,
            sidecarCommandDefault: sidecarCommand.commandDefault,
            sidecarOperationPrefix: input.sidecarOperationPrefix,
            exportOp: input.exportOp,
            scopeArgKey: input.scopeArgKey
        })
        : undefined;

    // Resolve the sidecar command for a given ABSOLUTE file path through the SAME
    // helper the diagram's edit path uses (`getSidecarCommand`, via
    // `SidecarRuntimeService.getSidecarCommand`), driven by the SAME `runtimeConfig`
    // the DI-bound model source / operation handlers use. Single source of truth:
    // if the diagram resolves (and spawns) a working sidecar, these registry READ
    // tools resolve the identical command — no second resolver, no blank-setting
    // leak or hardcoded path divergence. The registry-tool handlers receive an
    // fsPath (the platform adapter converts the GLSP sourceUri before calling), so
    // scope the config lookup by that file.
    const resolveSidecarCommand = (file: string): string =>
        getSidecarCommand(runtimeConfig, vscode, vscode.Uri.file(file));

    // Bridge the sidecar-registry READ tools into the profile's chat tools so the
    // platform adapter exposes them over GLSP-MCP. Library-mode only (function
    // closures share the platform realm) — the cross-extension API path leaves
    // chat.tools absent, which is acceptable (the tools are simply unavailable).
    //
    // Read-only, the one op anyone asks for is the graph export, and the CLI
    // plan answers it, in the sidecar's envelope, with the same deadline the
    // model source gives the plan; the op name is not looked at.
    const invoke = readOnly && cliGraphArgs
        ? (file: string, _opName: string, args: Record<string, unknown>) => {
            const scopeUri = vscode.Uri.file(file);
            const scoped = args[input.scopeArgKey];
            return exportGraphFromCli(file, {
                ...getCliInvocation(runtimeConfig, vscode, scopeUri),
                cliGraphArgs,
                networkName: typeof scoped === 'string' ? scoped : undefined,
                timeoutMs: getGraphLoadTimeoutMs(runtimeConfig, vscode, scopeUri)
            });
        }
        : (file: string, opName: string, args: Record<string, unknown>) =>
            invokeSidecarOp(
                file,
                { sidecarCommand: resolveSidecarCommand(file), sidecarOperationPrefix: input.sidecarOperationPrefix },
                opName,
                args
            );
    const chatTools = createRegistryChatTools({
        scopeArgKey: input.scopeArgKey,
        exportOp: input.exportOp,
        invoke,
        graphOnly: readOnly
    });
    // The source by reference (`chat.sourceContext: 'reference'`): no file
    // attached, a compact graph summary, and a selected node as a file and line.
    const sourceContextConfig = input.chat.sourceContext === 'reference'
        ? (() => {
            const context = createSourceReferenceContext({
                invoke,
                exportOp: input.exportOp,
                sourceMimeType: input.chat.sourceMimeType ?? 'text/plain'
            });
            return {
                sourceMaxBytes: 0,
                graphContextProvider: (file: string) => context.graphContextProvider(file),
                turnContextProvider: (file: string, selectedNodeIds: string[]) => context.turnContextProvider(file, selectedNodeIds),
                selectionContext: false as const
            };
        })()
        : readOnly
            // Embedded and read-only: the graph as JSON, as the edit backend's
            // export would have given it, from the CLI plan instead.
            ? {
                graphContextProvider: async (file: string): Promise<string | undefined> => {
                    const result = await invoke(file, input.exportOp ?? DEFAULT_EXPORT_OP, {});
                    const graph = result.ok ? result.response?.diagnostic?.graph : undefined;
                    return graph && typeof graph === 'object' ? JSON.stringify(graph) : undefined;
                }
            }
            : {};
    // A product that can resume runs gives the chat a way to offer it: the
    // agent that fixed a failed run proposes resuming it, and the person says
    // yes or no.
    if (input.cliResumeArgs) {
        chatTools.push(resumeFailedRunTool(input.commands.runWorkflow));
    }

    const runDriver = (context: vscode.ExtensionContext, host: RunHost): vscode.Disposable => {
        const config: CliRunDriverConfig = {
            settingsNamespace: input.settingsNamespace,
            customEditorViewType: input.customEditorViewType,
            cliCommandSettingKey: input.cliCommandSettingKey,
            cliCommandDefault: input.cliCommandDefault,
            cliPythonModule: input.cliPythonModule,
            runOutputDirSettingKey: input.runOutputDirSettingKey,
            liveExecutionGlowSettingKey: input.liveExecutionGlowSettingKey,
            agentToolsSettingKey: input.agentToolsSettingKey,
            agentToolAuthSettingKey: input.agentToolAuthSettingKey,
            agentToolPolicySettingKey: input.agentToolPolicySettingKey,
            agentToolTimeoutMsSettingKey: input.agentToolTimeoutMsSettingKey,
            agentToolRegistrySettingKey: input.agentToolRegistrySettingKey,
            agentMcpBridgeCmdSettingKey: input.agentMcpBridgeCmdSettingKey,
            acpConnectorSettingKey: input.runAcpFlags === false ? undefined : input.acpConnectorSettingKey,
            acpPermissionsSettingKey: input.runAcpFlags === false ? undefined : input.acpPermissionsSettingKey,
            runWorkflowCommandId: input.commands.runWorkflow,
            stopWorkflowCommandId: input.commands.stopWorkflow,
            cliResumeArgs: input.cliResumeArgs,
            agentToolConfigCommands: {
                set: input.commands.setAgentToolConfig,
                get: input.commands.getAgentToolConfig
            },
            overrideState: {
                get: () => context.workspaceState.get<Record<string, AgentToolEntitySettings>>(AGENT_TOOL_OVERRIDES_STATE_KEY),
                update: (value: Record<string, AgentToolEntitySettings>) =>
                    context.workspaceState.update(AGENT_TOOL_OVERRIDES_STATE_KEY, value)
            }
        };
        const driver = new CliRunDriver(config, {
            overlay: host.overlay,
            requestRefresh: host.requestRefresh,
            output: host.output,
            // The human port: a running agent's question goes to the platform
            // (the chat panel on the diagram); without it the driver prompts.
            askUser: host.askUser ? (question, sourceUri) => host.askUser!(question, sourceUri) : undefined,
            // "Fix with AI" on a failed run: a task for the diagram's chat.
            startChatTask: host.startChatTask ? (task, sourceUri) => host.startChatTask!(task, sourceUri) : undefined,
            // Resuming the run the chat fixed: confirmed in that chat.
            confirmInChat: host.confirmInChat ? (confirm, sourceUri) => host.confirmInChat!(confirm, sourceUri) : undefined
        });
        driver.registerCommands(context);
        host.useLiveOverlaySignatureSource({
            watch: (sourceUri) => driver.watchLiveOverlay(sourceUri),
            onSignature: (listener) => driver.onLiveOverlaySignature(listener)
        });
        return { dispose: () => driver.dispose() };
    };

    const newSourceFile = (context: vscode.ExtensionContext): vscode.Disposable => {
        // The raw sidecar commands need a sidecar; a read-only profile has none.
        if (sidecarCommand) {
            registerSidecarCommands(context, {
                editCommandId: input.commands.sidecarEdit,
                sendCommandId: input.commands.sidecarSend,
                opNamespace: input.key,
                settingsNamespace: input.settingsNamespace,
                sidecarCommandSettingKey: sidecarCommand.settingKey,
                sidecarCommandDefault: sidecarCommand.commandDefault,
                sourceFileExtension: primarySourceExtension,
                sourceFileExtensions: sourceExtensions
            });
        }
        registerNewSourceFileCommand(context, input.commands.createNewContainer, input.customEditorViewType, {
            label: input.newContainer.label,
            decorator: input.newContainer.decorator,
            importLine: input.newContainer.importLine,
            template: input.newContainer.template,
            sourceExtension: primarySourceExtension,
            identifierNoun: input.identifierNoun
        });
        // Both commands self-register on `context.subscriptions`; the returned
        // disposable is a harmless no-op the platform additionally tracks.
        return { dispose: () => undefined };
    };

    const profile = {
        key: input.key,
        displayName: input.displayName,
        settingsNamespace: input.settingsNamespace,
        customEditorViewType: input.customEditorViewType,
        glspClientId: input.glspClientId,
        glspClientName: input.glspClientName,
        commands: input.commands,
        // The extensions this builder already knows, handed to the platform so
        // its open/rename commands and file watchers filter on them — and so the
        // "please open a ... file" warnings name them. Without this the platform
        // falls back to accepting anything, which is the right default for a
        // profile that cannot say, and the wrong one for a builder that can.
        sourceExtensions,
        // A projection creates nothing, whatever the input says.
        supportsElementCreation: readOnly ? false : input.supportsElementCreation,
        operationKinds: input.operationKinds,
        clientBehavior: input.cliResumeArgs
            ? { ...input.clientBehavior, resumeAtStep: true }
            : input.clientBehavior,
        clientStylesheets: input.clientStylesheets,
        clientAssets: input.clientAssets,
        // Read-only, the server registers no writing operation handler at all
        // (the platform's own guard on `'read-only'`), so no create-node flow
        // and no capability probe can ever run.
        edits: readOnly
            ? ('read-only' as const)
            : { operationModules: createSidecarOperationModules(runtimeConfig) },
        modelSource: () => createSidecarModelSource(runtimeConfig),
        serverModules: [createSidecarServerModule(runtimeConfig)],
        storageOptions: {
            settingsNamespace: input.settingsNamespace,
            operationPrefix: input.sidecarOperationPrefix,
            entityPaletteItems: input.entityPaletteItems,
            nodeFamilies: input.nodeFamilies,
            nestedNavigation: input.clientBehavior?.nestedNavigation,
            defaultLayout: input.defaultLayout
        },
        watch: { globs: input.watchGlobs ?? sourceExtensions.map(ext => `**/*${ext}`) },
        // No provider at all for a product that resolves nothing itself: the
        // platform then navigates straight to the referenced target.
        navigation: input.navigation === 'python' ? createPythonNavigationProvider() : undefined,
        canOpenSource,
        editBackend,
        // Sidecar-backed products ship the in-host GLSP-MCP server on; the
        // per-user rollback lever is the `dialogram.chat.useGlspMcp` setting
        // (read per-turn in ChatRuntime), so no setting is read here.
        mcp: { enabled: true },
        elkServer: input.elkServer,
        chat: {
            fullName: input.chat.fullName,
            skill: input.chat.skill,
            nodeCommands: input.chat.nodeCommands,
            // Read-only sidecar-registry tools bridged to GLSP-MCP by the platform adapter.
            tools: chatTools,
            // What the agent receives the file as; plain text unless the product says.
            sourceMimeType: input.chat.sourceMimeType ?? 'text/plain',
            ...sourceContextConfig,
            // The ACP connector: the setting the chat and the property panel
            // read. Without it the chat keeps its opencode default.
            acpConnector: input.acpConnectorSettingKey && input.acpConnectorFiles
                ? { settingKey: input.acpConnectorSettingKey, files: input.acpConnectorFiles }
                : undefined
        },
        runDriver,
        statusSource: input.statusSource ? createCliStatusSource(input.statusSource, runtimeConfig) : undefined,
        newSourceFile
    };
    // Brand: assembled inside the platform bundle — DI fields may round-trip the API.
    Object.defineProperty(profile, Symbol.for('dialogram.platformAssembledProfile'), {
        value: true,
        enumerable: false
    });
    return profile;
}


/**
 * The chat tool that resumes a failed run once the agent's fix is in. It asks
 * the person first, in the chat (the run driver's `resumeFailedRun`); the agent learns the
 * answer, and the run's outcome shows on the diagram.
 */
export function resumeFailedRunTool(runWorkflowCommandId: string): RegistryChatTool {
    return {
        name: RESUME_TOOL,
        description:
            'After fixing the cause of a failed workflow run, offer the user to resume that run from where it failed. '
            + 'The user is asked to confirm in this chat (do not ask them yourself first); what ran before the failure is replayed, not run again. '
            + 'Call it once the fix is applied to the files -- not before, and not to start a new run.',
        inputSchema: { type: 'object', properties: {} },
        handler: async (file) => {
            const result = await vscode.commands.executeCommand<string>(
                resumeFailedRunCommandId(runWorkflowCommandId),
                { file }
            );
            return typeof result === 'string' ? result : 'The resume could not be offered.';
        }
    };
}
