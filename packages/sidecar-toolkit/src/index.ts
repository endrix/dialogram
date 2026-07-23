export {
    registerSidecarCommands,
    type SidecarCommandsConfig
} from './sidecar-commands.js';

export {
    createSidecarDiagramProfile,
    type SidecarProfileInput,
    type SidecarDialogramApi
} from './sidecar-diagram-profile.js';

export {
    registerNewSourceFileCommand,
    type NewSourceFileConfig
} from './new-source-file-command.js';

export {
    type WorkflowGraphExportOptions,
    type SidecarOpResult,
    invokeSidecarOp,
    exportWorkflowGraph
} from './sidecar-graph-export.js';

export {
    type SidecarCapabilities,
    parseCapabilitiesDiagnostic,
    getSidecarCapabilities,
    sidecarSupportsOp,
    clearSidecarCapabilitiesCache
} from './sidecar-capabilities.js';

export {
    WORKFLOW_STOP_GRACE_PERIOD_MS,
    signalWorkflowProcess,
    spawnWorkflowProcess,
    requestWorkflowStop,
    type WorkflowCliInvocation,
    type WorkflowProcessLike,
    type WorkflowOutputLike,
    type ManagedWorkflowRun,
    type SpawnWorkflowProcess,
    type KillWorkflowProcess
} from './process-control.js';

export {
    RunEventStreamClient,
    type RunStreamEvent,
    type RunEventStreamClientOptions
} from './run-event-stream-client.js';

export {
    CliRunDriver,
    type CliRunDriverConfig,
    type CliRunDriverHost,
    type AgentToolEntitySettings
} from './cli-run-driver.js';

export {
    extractDecoratedDefinitionNames,
    hasRequestedDecoratedDefinition
} from './python-diagram-definitions.js';

export {
    shouldOpenDiagram,
    createDiagramOpenabilityCheck,
    type DiagramOpenabilityConfig,
    type DiagramOpenabilityProbe,
    type DecoratedDefinitionChecker
} from './diagram-openability.js';

export {
    createSidecarEditBackend,
    type SidecarEditBackendConfig
} from './chat-edit-backend.js';

export { createPythonNavigationProvider } from './python-navigation.js';

export { normalizeSourceUriKey } from './uri-keys.js';

export {
    type SidecarRuntimeConfig,
    type CreateNodeStrings,
    type CreateNodeBehavior,
    type CreateNodeTypeKind,
    SIDECAR_RUNTIME_CONFIG,
    SidecarRuntimeService,
    sidecarOp,
    getSidecarCommand,
    getCliCommand,
    getCliInvocation
} from './server/sidecar-runtime-config.js';

export { SidecarInvoker, type SidecarInvocationResult } from './server/operations/sidecar-invoker.js';

export { createSidecarServerModule } from './server/sidecar-server-module.js';

export { createSidecarOperationModules } from './server/operation-modules.js';

export { graphPayloadToDoc } from './server/graph-payload-to-doc.js';

export {
    SidecarModelSource,
    type SidecarModelSourceResult,
    nodeIdentitiesFromDoc
} from './server/sidecar-model-source.js';

export {
    CliGraphModelSource,
    createSidecarModelSource
} from './server/cli-graph-model-source.js';
