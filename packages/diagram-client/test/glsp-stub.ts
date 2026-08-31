/**
 * Minimal stand-ins for the GLSP entry points that diagram-client source imports
 * at module load.
 *
 * We alias `@eclipse-glsp/client` / `@eclipse-glsp/sprotty` to this file for the
 * node test run ONLY to avoid pulling GLSP's browser bundle (which imports `.css`
 * as a load-time side effect and cannot be required under node). Handler code
 * exercised by the run-agents / channel tests uses NONE of these values at
 * runtime, so behaviour under test is unchanged.
 *
 * The `configure*` / `bindAsService` helpers below and the DI base classes exist
 * so the container-parity test can LOAD the real model/view/feature modules and
 * RECORD their registrations against a sink (see `__setRegistrationSink`). In
 * production these names resolve to the real GLSP package; the recorder shape
 * only matters to the parity oracle, not to shipped behaviour.
 */

// ── @eclipse-glsp/sprotty surface used at load ──────────────────────────────
export const Action = {
    is(object: unknown): boolean {
        return !!object && typeof object === 'object' && 'kind' in (object as Record<string, unknown>);
    }
};

export const ApplyLabelEditOperation = {
    create(options: Record<string, unknown>): Record<string, unknown> {
        return { kind: 'applyLabelEdit', ...options };
    }
};

/** Drag-time reroute trigger — the base container binds a handler on this kind. */
export const MoveAction = { KIND: 'move' };

export const NavigateToExternalTargetAction = {
    KIND: 'navigateToExternalTarget',
    create(options?: Record<string, unknown>): Record<string, unknown> {
        return { kind: 'navigateToExternalTarget', ...(options ?? {}) };
    }
};

export const RequestModelAction = {
    KIND: 'requestModel',
    create(options?: Record<string, unknown>): Record<string, unknown> {
        return { kind: 'requestModel', ...(options ?? {}) };
    }
};

// Sprotty base classes (extended by the model/view/listener modules).
export class MouseListener {}
export class GModelElement {}
export class GShapeElement extends GModelElement {}

// Type-only in consumers (stripped at runtime), declared for import resolution.
export type ICommand = unknown;
export interface IActionHandler {
    handle(action: unknown): unknown;
}
export type ClipboardData = unknown;
export type CommandExecutionContext = unknown;
export type GModelRoot = unknown;
export type Args = Record<string, unknown>;
export type Ranked = unknown;
export type Hoverable = unknown;
export type Selectable = unknown;
export type Fadeable = unknown;
export type IView = unknown;
export type IViewArgs = unknown;
export type RenderingContext = unknown;
export type ViewerOptions = unknown;
export type ContainerConfiguration = unknown[];

// ── @eclipse-glsp/client surface used at load ───────────────────────────────
export const TYPES = {
    IActionDispatcher: Symbol.for('stub.IActionDispatcher'),
    IGridManager: Symbol.for('stub.IGridManager'),
    ActionHandlerRegistration: Symbol.for('stub.ActionHandlerRegistration'),
    ILogger: Symbol.for('stub.ILogger'),
    LogLevel: Symbol.for('stub.LogLevel'),
    ICopyPasteHandler: Symbol.for('stub.ICopyPasteHandler'),
    IAsyncClipboardService: Symbol.for('stub.IAsyncClipboardService'),
    ViewerOptions: Symbol.for('stub.ViewerOptions'),
    ISelectionListener: Symbol.for('stub.ISelectionListener'),
    IGModelRootListener: Symbol.for('stub.IGModelRootListener'),
    IDiagramStartup: Symbol.for('stub.IDiagramStartup'),
    IContextMenuService: Symbol.for('stub.IContextMenuService'),
    MouseListener: Symbol.for('stub.MouseListener'),
    IEdgeRouter: Symbol.for('stub.IEdgeRouter')
};

export const DefaultTypes = {
    ROUTING_POINT: 'routing-point',
    VOLATILE_ROUTING_POINT: 'volatile-routing-point',
    ISSUE_MARKER: 'marker'
};

export enum LogLevel {
    none = 0,
    error = 1,
    warn = 2,
    info = 3,
    debug = 4
}

export class ConsoleLogger {}
export class EditorContextService {}

// GLSP model base classes (extended by ./model).
export class RectangularNode {}
export class CircularPort {}
export class SEdgeImpl {}
export class GLabel {}
export class GCompartment {}
export class GGraph {}
export class GIssueMarker {}
export class GRoutingHandle {}
export class SetModelCommand {}
export class FeedbackAwareSetModelCommand {}

// GLSP view base classes (extended by ./views / ./issue-marker-view).
export class ShapeView {}
export class PolylineEdgeView {}
export class GGraphView {}
export class GLabelView {}
export class GCompartmentView {}
export class GRoutingHandleView {}

/**
 * Base class for `LibavoidEdgeRouter`, which the feature module imports at load.
 * A bare stand-in is enough: no node test routes an edge — the router's real
 * behaviour is covered by the server-side fixtures, which replay captured drags
 * outside the webview.
 */
export class AbstractEdgeRouter {}
export class GIssueMarkerView {
    render(_marker: unknown, _context: unknown): unknown {
        return { children: [] };
    }
}

// Feature symbols referenced by ./model static feature arrays.
export const moveFeature = Symbol('moveFeature');
export const selectFeature = Symbol('selectFeature');
export const hoverFeedbackFeature = Symbol('hoverFeedbackFeature');
export const deletableFeature = Symbol('deletableFeature');
export const boundsFeature = Symbol('boundsFeature');
export const connectableFeature = Symbol('connectableFeature');
export const layoutContainerFeature = Symbol('layoutContainerFeature');
export const editFeature = Symbol('editFeature');
export const withEditLabelFeature = Symbol('withEditLabelFeature');

// Rendering helpers used by ./views JSX (@jsx svg) at render time only.
export function svg(tag: string, props?: unknown, ...children: unknown[]): unknown {
    return { tag, props, children };
}
export function setAttr(): void {
    /* no-op at test time */
}

// GLSP framework modules referenced by the base container assembly (sentinels;
// the container-composition test asserts they are passed to initializeDiagramContainer).
export const gridModule = { __glspModule: 'gridModule' };
export const helperLineModule = { __glspModule: 'helperLineModule' };
export const hoverModule = { __glspModule: 'hoverModule' };
export const contextMenuModule = { __glspModule: 'contextMenuModule' };

// ── Registration recorder (container-parity oracle) ─────────────────────────

export interface RegistrationEntry {
    op: string;
    [key: string]: unknown;
}

let registrationSink: ((entry: RegistrationEntry) => void) | undefined;

/** Route all `configure*` / `bindAsService` calls to a recording sink (tests only). */
export function __setRegistrationSink(sink: ((entry: RegistrationEntry) => void) | undefined): void {
    registrationSink = sink;
}

function nameOf(value: unknown): string {
    if (typeof value === 'function') {
        return (value as { name?: string }).name || 'anonymous';
    }
    if (typeof value === 'symbol') {
        return value.toString();
    }
    return String(value);
}

export function configureModelElement(
    _context: unknown,
    typeId: unknown,
    modelConstructor: unknown,
    viewConstructor: unknown,
    _options?: unknown
): void {
    registrationSink?.({
        op: 'modelElement',
        typeId: String(typeId),
        model: nameOf(modelConstructor),
        view: nameOf(viewConstructor)
    });
}

export function configureActionHandler(_context: unknown, kind: unknown, handlerConstructor: unknown): void {
    registrationSink?.({ op: 'actionHandler', kind: String(kind), handler: nameOf(handlerConstructor) });
}

export function bindAsService(_context: unknown, serviceIdentifier: unknown, constructor: unknown): void {
    registrationSink?.({ op: 'bindAsService', service: nameOf(serviceIdentifier), impl: nameOf(constructor) });
}

/** Recorder stand-in for GLSP's container initializer (composition test only). */
export function initializeDiagramContainer(container: unknown, ...modules: unknown[]): unknown {
    const moduleName = (m: unknown): string => {
        if (m && typeof m === 'object') {
            const asRecord = m as Record<string, unknown>;
            if (typeof asRecord.__glspModule === 'string') {
                return asRecord.__glspModule;
            }
            if (typeof asRecord.__moduleName === 'string') {
                return asRecord.__moduleName;
            }
        }
        return 'unknown';
    };
    registrationSink?.({ op: 'initializeDiagramContainer', modules: modules.map(moduleName) });
    return container;
}

// Type aliases used by handler/bridge modules.
export type IActionDispatcher = { dispatch(action: unknown): unknown };
export type IGridManager = unknown;
export interface IDiagramStartup {
    postModelInitialization?(): void;
}

// ── Real GLSP classes, loaded past the package index ─────────────────────────
// Everything above is a stand-in, but these three must be the genuine articles:
// the drag-threshold test asserts that GLSP's own `DragAwareMouseListener`
// dispatch honours the sensitivity our subclasses set, which a re-implementation
// here could not prove. The alias exists only because the package INDEX imports
// `.css` at load; these individual modules have no such side effect and require
// cleanly under node. `createRequire` reaches them past the vitest alias that
// would otherwise point this file back at itself.
import { createRequire } from 'node:module';

const requireGlsp = createRequire(import.meta.url);
const changeBoundsToolModule = requireGlsp('@eclipse-glsp/client/lib/features/tools/change-bounds/change-bounds-tool');
const moveFeedbackModule = requireGlsp('@eclipse-glsp/client/lib/features/tools/change-bounds/change-bounds-tool-move-feedback');

export const ChangeBoundsTool = changeBoundsToolModule.ChangeBoundsTool;
export const ChangeBoundsListener = changeBoundsToolModule.ChangeBoundsListener;
export const FeedbackMoveMouseListener = moveFeedbackModule.FeedbackMoveMouseListener;
