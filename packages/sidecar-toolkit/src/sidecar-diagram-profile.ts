/**
 * Assemble a sidecar-backed diagram profile from one flat literal of product
 * values.
 *
 * This is the seam between the product shells and the neutral platform: the
 * shell owns every product string/behavior and passes it here as
 * {@link SidecarProfileInput}; this helper wires the toolkit's model source,
 * server/operation modules, edit backend, openability check, run driver,
 * navigation provider and new-source-file commands into the shape the platform's
 * `DiagramProfile` expects. The return type is left to inference so the toolkit
 * needs no `@dialogram/extension-core` dependency; the shell annotates the
 * result as `DiagramProfile` at the assignment site.
 */
import type * as vscode from 'vscode';
import * as path from 'node:path';
import type {
    SidecarRuntimeConfig,
    CreateNodeStrings,
    CreateNodeBehavior
} from './server/sidecar-runtime-config.js';
import { createSidecarModelSource } from './server/cli-graph-model-source.js';
import { createSidecarServerModule } from './server/sidecar-server-module.js';
import { createSidecarOperationModules } from './server/operation-modules.js';
import { createDiagramOpenabilityCheck } from './diagram-openability.js';
import { createSidecarEditBackend } from './chat-edit-backend.js';
import { createPythonNavigationProvider } from './python-navigation.js';
import { registerSidecarCommands } from './sidecar-commands.js';
import { registerNewSourceFileCommand } from './new-source-file-command.js';
import {
    CliRunDriver,
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

/**
 * Neutral, behavior-named client capability flags the shell supplies and the
 * platform forwards into the diagram webview. Structural twin of the platform's
 * `DiagramClientBehavior`; kept local so the toolkit needs no extension-core dep.
 */
export interface SidecarClientBehavior {
    graphSourceNavigation?: boolean;
    networkPropertySections?: boolean;
    networkNavigationLabels?: boolean;
    noneSentinel?: string;
    scriptInterpreterCommands?: string[];
}

/** The 24 consumer-owned command ids a sidecar diagram profile carries. */
export interface SidecarProfileCommandIds {
    openDiagram: string;
    openDiagramSplit: string;
    layoutDiagram: string;
    refreshDiagramModel: string;
    renameEntityByName: string;
    undo: string;
    redo: string;
    fitToScreen: string;
    center: string;
    exportSvg: string;
    toggleGrid: string;
    setQueueTraceVisible: string;
    stopWorkflow: string;
    runWorkflow: string;
    layoutDiagramIfNeeded: string;
    setAgentToolConfig: string;
    getAgentToolConfig: string;
    createAgentToolPolicyFile: string;
    chatAddViewerEditor: string;
    chatAddViewerTask: string;
    sidecarEdit: string;
    sidecarSend: string;
    createNewContainer: string;
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
 * One flat literal of the product values a shell owns. Everything sidecar/
 * product-specific the platform used to receive through the deleted
 * extension-core adapter now enters here.
 */
export interface SidecarProfileInput {
    // Identity + GLSP.
    key: string;
    displayName: string;
    settingsNamespace: string;
    customEditorViewType: string;
    glspClientId: string;
    glspClientName: string;
    commands: SidecarProfileCommandIds;
    operationKinds: { createEntityPort: string; deleteEntityPort: string };
    /** Neutral behavior flags forwarded into the diagram webview. */
    clientBehavior?: SidecarClientBehavior;

    // Sidecar/CLI transport.
    sidecarOperationPrefix: string;
    sidecarCommandSettingKey: string;
    sidecarCommandDefault: string;
    cliCommandSettingKey: string;
    cliCommandDefault: string;
    cliPythonModule?: string;
    acceptedOperationPrefixes: string[];
    graphAcquisition: 'sidecar-export' | 'cli-plan';
    cliGraphArgs?: (file: string, requestedWorkflow?: string) => string[];
    graphExportFailureLabel?: string;

    // User-visible strings / behavior (Task 1 config, now product-supplied here).
    undoLabelSuffix: string;
    createNodeStrings: CreateNodeStrings;
    createNodeBehavior: CreateNodeBehavior;

    // Source file + palette.
    sourceExtension: string;
    useAlternateEntityPalette?: boolean;

    // Chat edit backend.
    exportOp?: string;
    mcpEnabledSetting: { section: string; key: string; default: boolean };
    scopeArgKey: string;

    // New-source-file scaffold.
    newContainer: { label: string; decorator: string; importLine: string };
    identifierNoun?: string;

    // Openability (omit for "always openable").
    openability?: { probeOp?: string; decoratorName: string };

    // Run driver.
    runOutputDirSettingKey: string;
    liveExecutionGlowSettingKey: string;
    agentToolsSettingKey: string;
    agentToolAuthSettingKey: string;
    agentToolPolicySettingKey: string;
    agentToolTimeoutMsSettingKey: string;
    agentToolRegistrySettingKey: string;
    agentMcpBridgeCmdSettingKey: string;

    // Chat carry-overs.
    chat: {
        name: string;
        fullName: string;
        skill?: string;
        nodeCommands?: Array<{ command: string; nodeType: string; description: string }>;
    };

    // Diagram source-file watch globs (default derived from sourceExtension).
    watchGlobs?: string[];
}

/** Build the neutral {@link SidecarRuntimeConfig} the toolkit model source needs. */
function sidecarRuntimeConfig(input: SidecarProfileInput): SidecarRuntimeConfig {
    return {
        settingsNamespace: input.settingsNamespace,
        sidecarOperationPrefix: input.sidecarOperationPrefix,
        sidecarCommandSettingKey: input.sidecarCommandSettingKey,
        sidecarCommandDefault: input.sidecarCommandDefault,
        cliCommandSettingKey: input.cliCommandSettingKey,
        cliCommandDefault: input.cliCommandDefault,
        cliPythonModule: input.cliPythonModule,
        operationKinds: {
            createEntityPort: input.operationKinds.createEntityPort,
            deleteEntityPort: input.operationKinds.deleteEntityPort
        },
        acceptedOperationPrefixes: input.acceptedOperationPrefixes,
        graphAcquisition: input.graphAcquisition,
        cliGraphArgs: input.cliGraphArgs,
        graphExportFailureLabel: input.graphExportFailureLabel,
        undoLabelSuffix: input.undoLabelSuffix,
        createNodeStrings: input.createNodeStrings,
        createNodeBehavior: input.createNodeBehavior
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

export function createSidecarDiagramProfile(input: SidecarProfileInput) {
    const runtimeConfig = sidecarRuntimeConfig(input);

    const canOpenSource = input.openability
        ? createDiagramOpenabilityCheck({
            settingsNamespace: input.settingsNamespace,
            sidecarCommandSettingKey: input.sidecarCommandSettingKey,
            sidecarCommandDefault: input.sidecarCommandDefault,
            sidecarOperationPrefix: input.sidecarOperationPrefix,
            probeOp: input.openability.probeOp,
            sourceExtension: input.sourceExtension,
            decoratorName: input.openability.decoratorName
        })
        : undefined;

    const editBackend = createSidecarEditBackend({
        settingsNamespace: input.settingsNamespace,
        sidecarCommandSettingKey: input.sidecarCommandSettingKey,
        sidecarCommandDefault: input.sidecarCommandDefault,
        sidecarOperationPrefix: input.sidecarOperationPrefix,
        exportOp: input.exportOp,
        mcpServerName: input.key,
        mcpServerModulePath: (assetsPath) => path.join(assetsPath, 'dist', 'sidecar-mcp-server.cjs'),
        mcpEnabledSetting: input.mcpEnabledSetting,
        scopeArgKey: input.scopeArgKey
    });

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
            runWorkflowCommandId: input.commands.runWorkflow,
            stopWorkflowCommandId: input.commands.stopWorkflow,
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
            output: host.output
        });
        driver.registerCommands(context);
        host.useLiveOverlaySignatureSource({
            watch: (sourceUri) => driver.watchLiveOverlay(sourceUri),
            onSignature: (listener) => driver.onLiveOverlaySignature(listener)
        });
        return { dispose: () => driver.dispose() };
    };

    const newSourceFile = (context: vscode.ExtensionContext): vscode.Disposable => {
        registerSidecarCommands(context, {
            editCommandId: input.commands.sidecarEdit,
            sendCommandId: input.commands.sidecarSend,
            opNamespace: input.key,
            settingsNamespace: input.settingsNamespace,
            sidecarCommandSettingKey: input.sidecarCommandSettingKey,
            sidecarCommandDefault: input.sidecarCommandDefault,
            sourceFileExtension: input.sourceExtension
        });
        registerNewSourceFileCommand(context, input.commands.createNewContainer, input.customEditorViewType, {
            label: input.newContainer.label,
            decorator: input.newContainer.decorator,
            importLine: input.newContainer.importLine,
            sourceExtension: input.sourceExtension,
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
        operationKinds: input.operationKinds,
        clientBehavior: input.clientBehavior,
        edits: { operationModules: createSidecarOperationModules(runtimeConfig) },
        modelSource: () => createSidecarModelSource(runtimeConfig),
        serverModules: [createSidecarServerModule(runtimeConfig)],
        storageOptions: {
            settingsNamespace: input.settingsNamespace,
            operationPrefix: input.sidecarOperationPrefix,
            useAlternateEntityPalette: input.useAlternateEntityPalette
        },
        watch: { globs: input.watchGlobs ?? [`**/*${input.sourceExtension}`] },
        navigation: createPythonNavigationProvider(),
        canOpenSource,
        editBackend,
        chat: {
            name: input.chat.name,
            fullName: input.chat.fullName,
            operationPrefix: input.sidecarOperationPrefix,
            skill: input.chat.skill,
            nodeCommands: input.chat.nodeCommands,
            // The libcst edit backend rewrites Python source; agents get the file as text/x-python.
            sourceMimeType: 'text/x-python'
        },
        runDriver,
        newSourceFile
    };
    // Brand: assembled inside the platform bundle — DI fields may round-trip the API.
    Object.defineProperty(profile, Symbol.for('dialogram.platformAssembledProfile'), {
        value: true,
        enumerable: false
    });
    return profile;
}
