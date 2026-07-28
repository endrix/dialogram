/**
 * Smoke-equivalent DI proof for the cross-bundle DI identity fix (SP2c-3).
 *
 * THE PRODUCTION FAILURE: when the shells assembled the profile in THEIR OWN
 * esbuild bundle, `createSidecarDiagramProfile` built the toolkit's inversify
 * `ContainerModule`s and DI-decorated operation-handler classes against the
 * shell bundle's inversify/Symbol realm. Those objects then crossed the
 * cross-extension API boundary into the platform's GLSP container (a DIFFERENT
 * inversify realm), which resolved the foreign handler classes with NO injection
 * metadata — leaving `@inject`ed `sidecar` undefined and throwing
 * `TypeError: Cannot read properties of undefined (reading
 * 'operationKindCreateEntityPort')` the moment `operationType` was read.
 *
 * THE FIX: assembly moved to the platform's OWN bundle, so the profile's DI
 * classes and the container that resolves them share ONE realm. This suite is
 * the headless proxy for that: it assembles the profile via
 * `createSidecarDiagramProfile` and resolves EVERY handler from a container
 * loaded with the profile's OWN `serverModules`, all in a single module realm —
 * exactly the invariant the platform bundle now guarantees at runtime. It then
 * touches `.operationType` on all 18 handlers (the exact production failure
 * site) and asserts none throw and every kind resolves.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import {
    GLSPClientProxy,
    GLSPServer,
    ModelState,
    OperationHandler,
    type OperationHandlerConstructor
} from '@eclipse-glsp/server';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import { createWorkflowServerModules } from '@dialogram/diagram-server/server/server-module';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import type { DiagramOperationModule } from '@dialogram/diagram-server/server/operation-modules';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile.js';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config.js';

const CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: () => 'task',
    classNamePlaceholder: () => 'MyTask',
    sidecarDisplayName: 'Test sidecar',
    invalidCapabilitiesResponse: 'invalid caps',
    missingCapabilities: () => 'missing',
    invalidListResponse: () => 'invalid list'
};

const CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

const COMMANDS: SidecarProfileInput['commands'] = Object.fromEntries(
    [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ].map((k) => [k, `pfx.${k}`])
) as SidecarProfileInput['commands'];

/** A product-shaped profile input (product literals are fine in tests). */
function profileInput(prefix: string, settingsNamespace: string): SidecarProfileInput {
    return {
        key: prefix,
        displayName: prefix,
        settingsNamespace,
        customEditorViewType: `${prefix}.networkDiagram`,
        glspClientId: `${prefix}.client`,
        glspClientName: prefix,
        commands: COMMANDS,
        operationKinds: { createEntityPort: `${prefix}.createEntityPort`, deleteEntityPort: `${prefix}.deleteEntityPort` },
        sidecarOperationPrefix: prefix,
        sidecarCommandSettingKey: `${prefix}SidecarCommand`,
        sidecarCommandDefault: `${prefix}-sidecar`,
        cliCommandSettingKey: `${prefix}CliCommand`,
        cliCommandDefault: prefix,
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file) => ['plan', file, '--format', 'graph', '--best-effort'],
        undoLabelSuffix: ` (${prefix})`,
        createNodeStrings: CREATE_NODE_STRINGS,
        createNodeBehavior: CREATE_NODE_BEHAVIOR,
        sourceExtension: '.py',
        mcpEnabledSetting: { section: 'workflow.chat', key: 'enableMcpTools', default: true },
        scopeArgKey: 'workflow',
        newContainer: { label: 'Container', decorator: 'workflow', importLine: 'from pkg import workflow' },
        identifierNoun: 'Python',
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        chat: { name: prefix, fullName: prefix, skill: 'skill' }
    };
}

/**
 * Rebuild the exact production wiring in one module realm: assemble the profile,
 * load its OWN `serverModules` into a fresh container, and collect its OWN
 * operation-module handler constructors. No `.sidecar` stubbing.
 */
function containerAndHandlersFromProfile(input: SidecarProfileInput): {
    container: Container;
    handlers: OperationHandlerConstructor[];
} {
    const profile = createSidecarDiagramProfile(input);

    const container = new Container();
    for (const module of (profile.serverModules ?? []) as ContainerModule[]) {
        container.load(module);
    }
    // The two non-sidecar, session-scoped dependencies the handlers inject.
    container.bind(ModelState).toConstantValue({ sourceUri: 'file:///tmp/fixture.py' } as any);
    container.bind(LayoutPersistenceService).toConstantValue(new LayoutPersistenceService());

    const edits = profile.edits as { operationModules: DiagramOperationModule[] };
    const handlers: OperationHandlerConstructor[] = [];
    for (const module of edits.operationModules) {
        module.configure({ add: (h: OperationHandlerConstructor) => handlers.push(h) } as any);
    }
    return { container, handlers };
}

/**
 * Rebuild the EXACT GLSP server container `NodeGlspVscodeServer.createGLSPClient` builds at
 * `start()`: the profile's `edits`/`serverModules`/`modelSource` flow through diagram-server's
 * neutral `createWorkflowServerModules` into a fresh container, then `container.get(GLSPServer)`
 * eagerly constructs `DefaultGlobalActionProvider`. That provider builds a per-diagram child
 * container and reads `.operationType` off a `new constructor()` instance (DI-less) — the precise
 * production failure site. This is the topology the earlier per-handler `container.resolve()` test
 * did NOT cover (resolve injects `sidecar`; GLSP's `new constructor()` does not).
 */
function buildGlspServerContainer(input: SidecarProfileInput): Container {
    const profile = createSidecarDiagramProfile(input);
    const serverModules = createWorkflowServerModules({
        edits: profile.edits as any,
        modelSourceFactory: profile.modelSource as any,
        storageOptions: profile.storageOptions as any,
        additionalServerModules: (profile.serverModules ?? []) as ContainerModule[]
    });
    const container = new Container();
    const proxyModule = new ContainerModule((bind) =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as any)
    );
    initializeContainer(container, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    return container;
}

describe('createSidecarDiagramProfile — GLSP server-start topology (DefaultGlobalActionProvider)', () => {
    it('constructs the GLSP server exactly as NodeGlspVscodeServer.createGLSPClient does, without throwing', () => {
        // Pre-fix this threw `TypeError: Cannot read properties of undefined
        // (reading 'operationKindCreateEntityPort')` from the entity-port CRUD `operationType`.
        for (const [prefix, ns] of [['wfpy', 'wfLang'], ['calpy', 'calLang']] as const) {
            const container = buildGlspServerContainer(profileInput(prefix, ns));
            expect(() => container.get(GLSPServer)).not.toThrow();
        }
    });
});

describe('createSidecarDiagramProfile — production-path DI resolution (no .sidecar stubbing)', () => {
    it('resolves every operation handler and reads .operationType without throwing (the exact prod failure)', () => {
        const input = profileInput('wfpy', 'wfLang');
        const { container, handlers } = containerAndHandlersFromProfile(input);

        // All 18 sidecar handlers are present on the assembled profile.
        expect(handlers).toHaveLength(18);

        for (const ctor of handlers) {
            const instance = container.resolve(ctor as any);
            expect(instance).toBeInstanceOf(OperationHandler);
            // Reading `.operationType` is the production failure site: the two
            // entity-port CRUD getters read `this.sidecar` — undefined in the
            // pre-fix cross-bundle case. Same-realm resolution keeps it wired.
            const kind = (instance as OperationHandler).operationType;
            expect(typeof kind).toBe('string');
            expect(kind.length).toBeGreaterThan(0);
        }
    });

    it('routes the active product create/delete entity-port kinds through the injected sidecar', () => {
        for (const [prefix, ns] of [['wfpy', 'wfLang'], ['calpy', 'calLang']] as const) {
            const input = profileInput(prefix, ns);
            const { container, handlers } = containerAndHandlersFromProfile(input);

            const kinds = new Set(
                handlers.map((ctor) => (container.resolve(ctor as any) as OperationHandler).operationType)
            );
            expect(kinds.has(`${prefix}.createEntityPort`)).toBe(true);
            expect(kinds.has(`${prefix}.deleteEntityPort`)).toBe(true);
        }
    });
});
