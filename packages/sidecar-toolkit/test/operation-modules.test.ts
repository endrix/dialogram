// Pins the real `EditStrategy.operationModules` seam (SP2c-1 Task 4). The sidecar operation
// handlers moved to the toolkit in Task 3; this suite proves they are injected into GLSP's
// operation-handler multibinding through the neutral `DiagramOperationModule` seam rather than the
// deleted transitional `operationHandlerConstructors` list.
//
// Coverage:
//  1. Module-injection parity — an editable module built with
//     `{ operationModules: createSidecarOperationModules(cfg) }` registers the neutral in-core
//     handlers followed by exactly the pre-SP2c sidecar handler set (class-name snapshot);
//     `read-only` registers none.
//  2. End-to-end DI resolution — the real toolkit sidecar DI module resolves every one of the
//     sidecar handlers with NO stubbing of `.sidecar`, proving the SIDECAR_RUNTIME_CONFIG →
//     SidecarRuntimeService → SidecarInvoker → handler chain is intact.
//  3. CRUD-collapse routing — the collapsed entity-port CRUD handlers resolve the active product's
//     create/delete operation kinds for BOTH a wfpy-shaped and a calpy-shaped runtime config.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container } from 'inversify';
import { ModelState, OperationHandler, type OperationHandlerConstructor } from '@eclipse-glsp/server';
import type { EditStrategy } from '@dialogram/shared';
import { WorkflowDiagramModule } from '@dialogram/diagram-server/server/diagram-module';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { createSidecarOperationModules } from '../src/server/operation-modules.js';
import { createSidecarServerModule } from '../src/server/sidecar-server-module.js';
import { SidecarInvoker } from '../src/server/operations/sidecar-invoker.js';
import type { SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config.js';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config.js';

/** Product-shaped configs (product literals are fine in tests). */
function runtimeConfig(prefix: string, settingsNamespace: string, graphAcquisition: SidecarRuntimeConfig['graphAcquisition']): SidecarRuntimeConfig {
    return {
        settingsNamespace,
        sidecarOperationPrefix: prefix,
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: `${prefix}-sidecar`,
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: prefix,
        operationKinds: {
            createEntityPort: `${prefix}.createEntityPort`,
            deleteEntityPort: `${prefix}.deleteEntityPort`
        },
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition,
        ...NEUTRAL_CREATE_NODE_CONFIG
    };
}

const WFPY_CFG = runtimeConfig('wfpy', 'wfLang', 'cli-plan');
const CALPY_CFG = runtimeConfig('calpy', 'calLang', 'sidecar-export');

/** The pre-SP2c sidecar handler registration set, in canonical order (class-name snapshot). */
const EXPECTED_SIDECAR_HANDLER_NAMES = [
    'CreateNodeOperationHandler',
    'CreateEdgeOperationHandler',
    'DeleteElementOperationHandler',
    'CutOperationHandler',
    'ReconnectEdgeOperationHandler',
    'RenameEntityOperationHandler',
    'ApplyLabelEditRenameHandler',
    'UpdateEntityParameterOperationHandler',
    'UpdateEdgeCapacityOperationHandler',
    'UpdateDefinitionAnnotationOperationHandler',
    'UpdateDefinitionParameterOperationHandler',
    'CreateTaskTypeOperationHandler',
    'CreateBoundaryPortOperationHandler',
    'UpdateEntityPortOperationHandler',
    'EntityPortCrudHandler',
    'DeleteEntityPortCrudHandler',
    'PasteOperationHandler',
    'DuplicateOperationHandler'
];

/** Run `configureOperationHandlers` with a recording binding, returning the registered constructors. */
function collectRegisteredHandlers(edits: EditStrategy): OperationHandlerConstructor[] {
    const module = new WorkflowDiagramModule({ edits });
    const registered: OperationHandlerConstructor[] = [];
    const recordingBinding = { add: (handler: OperationHandlerConstructor) => registered.push(handler) };
    (module as any).configureOperationHandlers(recordingBinding);
    return registered;
}

/** A container wired with only the real toolkit sidecar DI module plus the two non-sidecar
 *  session-scoped dependencies the handlers inject. No `.sidecar` stubbing. */
function buildSidecarContainer(cfg: SidecarRuntimeConfig): Container {
    const container = new Container();
    container.load(createSidecarServerModule(cfg));
    container.bind(ModelState).toConstantValue({ sourceUri: 'file:///tmp/fixture.py' } as any);
    container.bind(LayoutPersistenceService).toConstantValue(new LayoutPersistenceService());
    return container;
}

describe('createSidecarOperationModules — module-injection parity', () => {
    it('registers the neutral in-core handlers first, then exactly the pre-SP2c sidecar set', () => {
        const neutralOnly = collectRegisteredHandlers({ operationModules: [] });
        const withSidecar = collectRegisteredHandlers({
            operationModules: createSidecarOperationModules(WFPY_CFG)
        });

        // The neutral handlers are registered first and are untouched by module injection.
        expect(neutralOnly.length).toBeGreaterThan(0);
        expect(withSidecar.slice(0, neutralOnly.length)).toEqual(neutralOnly);

        // The sidecar handlers follow, in the canonical pre-SP2c set/order.
        const sidecarNames = withSidecar.slice(neutralOnly.length).map((ctor) => ctor.name);
        expect(sidecarNames).toEqual(EXPECTED_SIDECAR_HANDLER_NAMES);
        expect(withSidecar.length).toBe(neutralOnly.length + EXPECTED_SIDECAR_HANDLER_NAMES.length);
    });

    it('a read-only module registers no operation handlers', () => {
        expect(collectRegisteredHandlers('read-only')).toEqual([]);
    });

    it('the injected module set is identical for a calpy-shaped config (same set, same order)', () => {
        const wfpy = collectRegisteredHandlers({ operationModules: createSidecarOperationModules(WFPY_CFG) });
        const calpy = collectRegisteredHandlers({ operationModules: createSidecarOperationModules(CALPY_CFG) });
        expect(calpy.map((c) => c.name)).toEqual(wfpy.map((c) => c.name));
    });
});

describe('createSidecarOperationModules — end-to-end DI resolution (no .sidecar stubbing)', () => {
    it('resolves every sidecar handler through the real toolkit DI module', () => {
        const cfg = WFPY_CFG;
        const container = buildSidecarContainer(cfg);

        const registered: OperationHandlerConstructor[] = [];
        for (const module of createSidecarOperationModules(cfg)) {
            module.configure({ add: (handler: OperationHandlerConstructor) => registered.push(handler) } as any);
        }
        expect(registered).toHaveLength(EXPECTED_SIDECAR_HANDLER_NAMES.length);

        for (const ctor of registered) {
            const instance = container.resolve(ctor as any);
            expect(instance).toBeInstanceOf(OperationHandler);
        }

        // The SidecarInvoker was resolved from the real config chain, not a stub.
        const invoker = container.get(SidecarInvoker);
        expect(invoker.operationKindCreateEntityPort()).toBe(cfg.operationKinds.createEntityPort);
        expect(invoker.operationKindDeleteEntityPort()).toBe(cfg.operationKinds.deleteEntityPort);
    });
});

/** Collect the operation-handler constructors a config's sidecar modules register. */
function registeredHandlers(cfg: SidecarRuntimeConfig): OperationHandlerConstructor[] {
    const registered: OperationHandlerConstructor[] = [];
    for (const module of createSidecarOperationModules(cfg)) {
        module.configure({ add: (h: OperationHandlerConstructor) => registered.push(h) } as any);
    }
    return registered;
}

describe('createSidecarOperationModules — entity-port CRUD-collapse routing', () => {
    for (const cfg of [WFPY_CFG, CALPY_CFG]) {
        it(`routes create/delete entity-port kinds for the ${cfg.sidecarOperationPrefix} config`, () => {
            const container = buildSidecarContainer(cfg);
            const byName = new Map(registeredHandlers(cfg).map((c) => [c.name, c]));
            const CreateHandler = byName.get('EntityPortCrudHandler')!;
            const DeleteHandler = byName.get('DeleteEntityPortCrudHandler')!;

            // DI-resolved (execution path): the injected sidecar is present.
            expect((container.resolve(CreateHandler) as OperationHandler).operationType).toBe(cfg.operationKinds.createEntityPort);
            expect((container.resolve(DeleteHandler) as OperationHandler).operationType).toBe(cfg.operationKinds.deleteEntityPort);

            // DI-LESS `new constructor().operationType` — the EXACT read GLSP's
            // DefaultGlobalActionProvider performs at server start. This must NOT throw and
            // must yield the product kind, or the live GLSP activation regresses.
            expect(new (CreateHandler as any)().operationType).toBe(cfg.operationKinds.createEntityPort);
            expect(new (DeleteHandler as any)().operationType).toBe(cfg.operationKinds.deleteEntityPort);
        });
    }
});
