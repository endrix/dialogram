/**
 * Workflow GLSP Server Module
 * 
 * Server-level DI configuration for the Workflow GLSP server.
 * Extends the GLSP ServerModule to provide Workflow-specific server configuration.
 */

import 'reflect-metadata';

import {
    ServerModule,
    Logger,
    LoggerFactory,
    LogLevel,
    ConsoleLogger,
    getRequestParentName,
    LayoutEngine,
    ModelState,
    DiagramModule,
    ActionDispatchScope,
    InjectionContainer
} from '@eclipse-glsp/server';
import { NodeActionDispatchScope } from '@eclipse-glsp/server/node';
import { configureELKLayoutModule, ElkFactory, ElementFilter, LayoutConfigurator, GlspElkLayoutEngine } from '@eclipse-glsp/layout-elk';
import { NodeMcpServerModule } from '@eclipse-glsp/server-mcp';
import { ContainerModule, interfaces } from 'inversify';
import type { EditStrategy, DiagramModelSource } from '@dialogram/shared';
import { WorkflowDiagramModule } from './diagram-glsp-module';
import { DiagramMcpModule } from './mcp-diagram-module';
import type { McpServerModuleOptions } from './mcp-diagram-module';
import { WorkflowLayoutConfigurator } from './layout-configurator';
import { WorkflowElkLayoutEngine } from './elk-layout-engine';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WorkflowRerouteEdgesAvoidOverlapsOperationHandler } from '../operations/reroute-edges-avoid-overlaps-handler';
import { DIAGRAM_MODEL_SOURCE } from './model-source-token';
import { STORAGE_RUNTIME_OPTIONS, type StorageRuntimeOptions } from './storage-runtime-options';
import { WorkflowServerLogger } from './disposed-request-logger';

/**
 * App-level module: dialogram's minimal stand-in for GLSP's node `createAppModule`.
 * Provides a warn-level `ConsoleLogger` (we skip `createAppModule` so its winston
 * logger rebind never applies) plus the two app-level DI defaults GLSP 2.7 moved into
 * `createAppModule`: the container self-binding and the `ActionDispatchScope` that
 * `DefaultActionDispatcher` injects (mirrors @eclipse-glsp/server
 * lib/node/di/app-module.js:13-14, and nothing else). Required for
 * NodeGlspVscodeServer to boot: without the scope binding `container.get(GLSPServer)`
 * throws "No matching bindings found for ActionDispatchScope".
 */
const appModule = new ContainerModule((bind, _unbind, isBound, _rebind) => {
    // Bind a warn-level ConsoleLogger. WorkflowServerLogger downgrades the benign
    // "cancelled: dispatcher disposed" in-flight-request rejection (logged at ERROR by
    // DefaultGLSPServer when an editor closes mid-request) to debug; all other errors
    // pass through unchanged.
    bind(Logger).toDynamicValue(ctx =>
        new WorkflowServerLogger(LogLevel.warn, getRequestParentName(ctx))
    ).inSingletonScope();
    
    // Bind LoggerFactory for creating named loggers
    bind(LoggerFactory).toFactory(dynamicContext => (caller?: string) => {
        const logger = dynamicContext.container.get(Logger) as ConsoleLogger;
        if (caller) {
            logger.caller = caller;
        }
        return logger;
    });

    // GLSP 2.7 app-level DI defaults (mirrors node `createAppModule`, sans its logger
    // rebind): the container self-binding + the AsyncLocalStorage-backed action-dispatch
    // scope that `DefaultActionDispatcher` injects. Without these,
    // `NodeGlspVscodeServer`'s `container.get(GLSPServer)` fails to resolve the
    // ActionDispatcher.
    bind(InjectionContainer).toDynamicValue(dynamicContext => dynamicContext.container);
    bind(ActionDispatchScope).to(NodeActionDispatchScope).inSingletonScope();
});

/**
 * Create a configured ServerModule with the Workflow diagram module registered.
 * 
 * @returns Configured server module ready for use with NodeGlspVscodeServer
 */
export function createWorkflowServerModules(
    options?: {
        edits?: EditStrategy;
        modelSourceFactory?: () => DiagramModelSource;
        /** Neutral storage runtime options (settings namespace + operation-prefix). */
        storageOptions?: StorageRuntimeOptions;
        /**
         * DI modules the consuming extension contributes (e.g. the language toolkit's model module
         * binding the runtime config, service, and invoker its operation handlers depend on). Core
         * never imports the toolkit; the modules flow in as opaque `ContainerModule`s.
         */
        additionalServerModules?: ContainerModule[];
        /**
         * Build-time library seam: a factory for the consumer's OWN GLSP
         * `DiagramModule` instance. When supplied it REPLACES the stock
         * {@link WorkflowDiagramModule} in `configureDiagramModule`, so the
         * consumer's server-side DI classes drive the diagram session. The module
         * is constructed in the CALLER's realm — valid only in single-bundle
         * (library) consumption (see {@link DiagramProfile.serverDiagramModule}).
         * Typed as `() => unknown` to keep the neutral contract free of concrete
         * consumer types; narrowed to `DiagramModule` here.
         */
        diagramModuleFactory?: () => unknown;
        /**
         * GLSP-MCP loopback-server opt-in. Absent or `{ enabled:false }` keeps the legacy
         * path byte-identical: neither the server-scope {@link NodeMcpServerModule} nor the
         * per-session {@link DiagramMcpModule} is loaded. When `{ enabled:true }`, both are
         * wired and the launcher boots lazily on a GLSP `initialize` carrying an `mcpServer`
         * config (threaded separately by the extension host).
         */
        mcp?: McpServerModuleOptions;
    }
): ServerModule[] {
    const serverModule = new ServerModule();

    // Create additional modules array
    const additionalModules: ContainerModule[] = [];
    
    // Add ELK layout module for automatic layout
    const elkLayoutModule = configureELKLayoutModule({
        algorithms: ['layered'],
        layoutConfigurator: WorkflowLayoutConfigurator,
        defaultLayoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            'elk.spacing.nodeNode': '40'
        }
    });
    additionalModules.push(elkLayoutModule);
    
    // Helper to create WorkflowElkLayoutEngine with proper dependencies
    const createWorkflowElkLayoutEngine = (container: interfaces.Container): WorkflowElkLayoutEngine => {
        const elkFactory = container.get<ElkFactory>(ElkFactory);
        const filter = container.get<ElementFilter>(ElementFilter);
        const configurator = container.get<LayoutConfigurator>(LayoutConfigurator);
        const modelState = container.get<ModelState>(ModelState);
        return new WorkflowElkLayoutEngine(elkFactory, filter, configurator, modelState);
    };

    // Add custom layout engine module with edge routing coordinate translation
    const customLayoutEngineModule = new ContainerModule((bind, unbind, isBound, rebind) => {
        if (isBound(LayoutEngine)) {
            if (isBound(GlspElkLayoutEngine)) {
                unbind(GlspElkLayoutEngine);
            }
            rebind(LayoutEngine).toDynamicValue(ctx => createWorkflowElkLayoutEngine(ctx.container)).inSingletonScope();
        } else {
            bind(LayoutEngine).toDynamicValue(ctx => createWorkflowElkLayoutEngine(ctx.container)).inSingletonScope();
        }
    });
    additionalModules.push(customLayoutEngineModule);

    // Bind layout persistence (consumer .layout.json) for manual layout + move persistence.
    const layoutPersistenceModule = new ContainerModule((bind) => {
        bind(LayoutPersistenceService).toConstantValue(new LayoutPersistenceService());
    });
    additionalModules.push(layoutPersistenceModule);

    // Operation handlers are registered via a multibinding of constructors; that does not
    // automatically bind the handler class for direct injection into other handlers.
    // Bind canonical reroute handler to self so ChangeBounds can reuse it.
    const operationHandlerSelfModule = new ContainerModule((bind, _unbind, isBound) => {
        if (!isBound(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)) {
            bind(WorkflowRerouteEdgesAvoidOverlapsOperationHandler).toSelf().inSingletonScope();
        }
    });
    additionalModules.push(operationHandlerSelfModule);

    // Neutral storage runtime options (settings namespace + operation-prefix), supplied as plain
    // data by the consuming extension. No product literals here.
    // `isBound`-guarded so a consumer-supplied diagram module (loaded FIRST into the
    // session container — see GLSP's client-session factory) that binds its own
    // options WINS: the neutral binding never clobbers the consumer's.
    const storageOptions = options?.storageOptions;
    if (storageOptions) {
        const storageOptionsModule = new ContainerModule((bind, _unbind, isBound) => {
            if (!isBound(STORAGE_RUNTIME_OPTIONS)) {
                bind(STORAGE_RUNTIME_OPTIONS).toConstantValue(storageOptions);
            }
        });
        additionalModules.push(storageOptionsModule);
    }

    // DI modules contributed by the consuming extension (e.g. the language toolkit's model module
    // binding the runtime config + service + invoker the moved operation handlers depend on).
    for (const contributedModule of options?.additionalServerModules ?? []) {
        additionalModules.push(contributedModule);
    }

    // Bind the DiagramModelSource (graph acquisition + language-specific source analysis) the
    // source-model-storage delegates to. The concrete model source lives in the language toolkit;
    // core stays neutral and receives it through a consumer-supplied factory (extension-core's
    // diagram-profile adapter builds it). When no factory is supplied (headless/tests), storage
    // degrades gracefully via its @optional() binding.
    // `isBound`-guarded (same rationale as storageOptions above): a consumer module
    // that binds its OWN model source keeps it; the neutral binding only fills the gap.
    const modelSourceFactory = options?.modelSourceFactory;
    if (modelSourceFactory) {
        const modelSourceModule = new ContainerModule((bind, _unbind, isBound) => {
            if (!isBound(DIAGRAM_MODEL_SOURCE)) {
                bind(DIAGRAM_MODEL_SOURCE).toDynamicValue(() => modelSourceFactory()).inSingletonScope();
            }
        });
        additionalModules.push(modelSourceModule);
    }

    // GLSP-MCP opt-in: when enabled, append the per-session MCP diagram module (diagram-scope
    // tool/resource/prompt handlers) to the session module array. Loaded LAST so consumer
    // diagram/model bindings it reads (e.g. ModelState, OperationHandlerRegistry) are already
    // present. When the flag is off nothing is added — the legacy session array is untouched.
    const mcpEnabled = options?.mcp?.enabled === true;
    if (mcpEnabled) {
        additionalModules.push(new DiagramMcpModule({ tools: options?.mcp?.tools ?? [] }));
    }

    // Configure the diagram module with the additional modules. A consumer-supplied
    // `diagramModuleFactory` (build-time library mode) replaces the stock module;
    // otherwise the stock WorkflowDiagramModule is used, byte-identical to before.
    const diagramModule = options?.diagramModuleFactory
        ? (options.diagramModuleFactory() as DiagramModule)
        : new WorkflowDiagramModule({ edits: options?.edits });
    serverModule.configureDiagramModule(diagramModule, ...additionalModules);

    // Assemble the returned server-scope module list. Logger module first, then the server
    // module. When MCP is enabled, append the server-scope NodeMcpServerModule — its own
    // `configure` binds the launcher and aliases it under GLSPServerInitializer +
    // GLSPServerListener (we never hand-bind those lifecycle hooks). The launcher then boots
    // the loopback HTTP server lazily on the first `initialize` carrying an `mcpServer` config.
    const serverModules: ServerModule[] = [appModule as unknown as ServerModule, serverModule];
    if (mcpEnabled) {
        const persona = options?.mcp?.agentPersona;
        const nodeMcpServerModule = new NodeMcpServerModule(persona ? { agentPersona: persona } : {});
        serverModules.push(nodeMcpServerModule as unknown as ServerModule);
    }
    return serverModules;
}
