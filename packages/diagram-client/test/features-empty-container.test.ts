/**
 * Features-empty container — the neutral base stands alone.
 *
 * A consumer with entirely custom views (SP4 mlir) calls
 * `createDiagramContainer({ clientId, features: [ownModules] })`. With NO features
 * at all the factory must still boot: only the neutral base loads, no stock
 * workflow model/view is registered, and the RunningAgentsBar binding is present
 * but no-ops because the execution-overlay channel is never fed.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Messenger } from 'vscode-messenger-webview';
import { EXECUTION_OVERLAY_ACTION_KIND } from '@dialogram/shared';
import { TYPES, SetModelCommand, EditorContextService } from '@eclipse-glsp/client';
import { createDiagramContainer, composeDiagramModules } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { workflowViewsModule } from '../src/stock-views.module';
import { recordModuleRegistrations } from './container-registration-recorder';
import { DiagramWebviewChannel } from '../src/webview-channel';
import {
    installExecutionOverlayRouting,
    __resetOverlayRoutingForTests
} from '../src/execution-overlay-message-bridge';
import { RunAgentStreamActionHandler } from '../src/editing-action-handlers';

/**
 * Build a REAL inversify container at the mlir PRODUCTION topology: the neutral
 * base loaded on top of the GLSP infra bindings that `DEFAULT_MODULES` provide
 * (action dispatcher, editor context, the stock `SetModelCommand`, copy/paste
 * infra, an optional grid manager) — but WITHOUT the stock feature module. This
 * is exactly what a custom-view consumer (mlir) composes: base + own modules +
 * GLSP defaults, and NOTHING that binds `WorkflowNavigationUi`.
 *
 * The `recordModuleRegistrations` sink stays off, so the stub `configure*` /
 * `bindAsService` helpers no-op and the base module's real `bind`/`rebind` calls
 * land on THIS container — the same class graph that boots in the webview.
 */
function bootNeutralBaseContainer(): Container {
    const container = new Container({ defaultScope: 'Singleton' });
    // GLSP DEFAULT_MODULES stand-ins the base `rebind`s over / injects.
    container.bind(TYPES.ILogger).toConstantValue({});
    container.bind(TYPES.LogLevel).toConstantValue(2);
    container.bind(SetModelCommand).toConstantValue(class {});
    container.bind(TYPES.IActionDispatcher).toConstantValue({ dispatch: () => undefined });
    container.bind(EditorContextService).toConstantValue({});
    container.bind(TYPES.ViewerOptions).toConstantValue({});
    container.bind(TYPES.IAsyncClipboardService).toConstantValue({});
    container.bind(TYPES.ICopyPasteHandler).toConstantValue({});
    // Grid manager is @optional() on the grid startup — deliberately left unbound.
    container.load(diagramBaseModule);
    return container;
}

function fakeVscodeApi(): { postMessage(): void; getState(): void; setState(): void } {
    return { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
}

describe('features-empty container', () => {
    beforeEach(() => {
        (globalThis as { window?: EventTarget }).window = new EventTarget();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        RunAgentStreamActionHandler.reset();
        __resetOverlayRoutingForTests();
    });

    afterEach(() => {
        delete (globalThis as { window?: EventTarget }).window;
        RunAgentStreamActionHandler.reset();
        __resetOverlayRoutingForTests();
        vi.restoreAllMocks();
    });

    it('boots headlessly with no features and returns a container', () => {
        const container = createDiagramContainer({ clientId: 'custom_0', features: [] });
        expect(container).toBeTruthy();
    });

    it('registers no stock views when features are empty', () => {
        expect(composeDiagramModules({ clientId: 'custom_0', features: [] })).toEqual([diagramBaseModule]);
        expect(composeDiagramModules({ clientId: 'custom_0', features: [] })).not.toContain(workflowViewsModule);

        const baseOnly = recordModuleRegistrations([diagramBaseModule]);
        const stockViews = baseOnly.filter(
            entry => entry.op === 'modelElement' && !String(entry.typeId).includes('routing')
        );
        expect(stockViews).toEqual([]);
    });

    it('binds the RunningAgentsBar in the base (mounts) but it no-ops with no overlay events', () => {
        const baseOnly = recordModuleRegistrations([diagramBaseModule]);
        const barBound = baseOnly.some(entry => entry.op === 'bind' && entry.id === 'RunningAgentsBar');
        const barStartup = baseOnly.some(
            entry => entry.op === 'bind' && entry.to === 'service:RunningAgentsBar'
        );
        expect(barBound).toBe(true);
        expect(barStartup).toBe(true);

        // Wire the overlay channel and never feed it — the bar's stream handler
        // must report no active run (dark bar), never throw.
        const messenger = new Messenger(fakeVscodeApi() as never);
        messenger.start();
        const channel = new DiagramWebviewChannel(messenger as never);
        installExecutionOverlayRouting(channel);

        expect(RunAgentStreamActionHandler.getAgents()).toEqual([]);
        expect(RunAgentStreamActionHandler.isRunActive()).toBe(false);
        expect(EXECUTION_OVERLAY_ACTION_KIND).toBeTruthy();
    });
});

/**
 * Boot-chain resolution — the regression guard for the SP4 mlir smoke failure.
 *
 * `features-empty-container` above only CONSTRUCTS the container (the GLSP stub's
 * `initializeDiagramContainer` returns it un-wired), so it never resolved the DI
 * graph and could not see an unbound stock coupling. The webview DOES resolve it:
 * `DiagramLoader` calls `getAll(IDiagramStartup)` and dispatches the model load,
 * whose `SetModelCommand` the base rebinds to `ViewportPreservingSetModelCommand`.
 *
 * These tests reproduce that resolution against a real inversify container at the
 * custom-consumer topology (base, no stock features). Before the base was made
 * self-sufficient, resolving the `SetModelCommand` chain threw
 * `No matching bindings found for serviceIdentifier: WorkflowNavigationUi`
 * (minified `Gp`, dragged in by `ViewportPreservingSetModelCommand` / `qO`).
 */
describe('neutral base boots without the stock feature module', () => {
    it('resolves every IDiagramStartup the DiagramLoader eagerly instantiates', () => {
        const container = bootNeutralBaseContainer();
        // Mirrors DiagramLoader: `this.lazyInjector.getAll(TYPES.IDiagramStartup)`.
        expect(() => container.getAll(TYPES.IDiagramStartup)).not.toThrow();
    });

    it('resolves the SetModelCommand chain the model load executes (no stock service required)', () => {
        const container = bootNeutralBaseContainer();
        // Mirrors the CommandStack instantiating the rebound SetModelCommand when
        // the loaded model is applied. This is the exact chain the smoke failure hit.
        expect(() => container.get(SetModelCommand)).not.toThrow();
        const command = container.get(SetModelCommand) as { workflowNavUi?: unknown };
        // The stock nav UI is genuinely stock-only and stays unbound here; the
        // optional injection must leave it undefined, never throw.
        expect(command.workflowNavUi).toBeUndefined();
    });
});
