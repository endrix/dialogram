/**
 * `createDiagramContainer` — the diagram-client library's composition seam.
 *
 * Assembles a GLSP diagram container from the neutral base (`diagramBaseModule`)
 * plus consumer-supplied feature `ContainerModule`s. The stock entry passes the
 * stock workflow modules as features; a custom-view consumer (mlir) passes its
 * own — the library binds NO product-specific model/view statically.
 *
 * ## DOM-anchor contract (library boundary)
 *
 * The GLSP starter/webview-widget the container drives assumes the host HTML
 * exposes these anchors, keyed on the SAME `clientId` passed here:
 *  - `#${clientId}_container` — the Sprotty diagram host element,
 *  - `#${clientId}_popup`     — the hover/popup layer,
 *  - `#${clientId}_hidden`    — the offscreen measuring layer,
 *  - a loading element (toggled while the model builds).
 * A consumer serving its own webview HTML (via `DiagramProfile.clientAssets`, SP3
 * Task 3) MUST reproduce these ids or the loader/popup/measuring break.
 *
 * ## Build-time composition only (SP2c bundle-boundary lesson)
 *
 * `features` must be authored and bundled in the SAME webview bundle as the
 * library source — never constructed host-side and passed across the extension
 * API. One inversify realm and one Symbol table per bundle; DI-decorated modules
 * must not cross an esbuild boundary.
 */
import { Container, ContainerModule } from 'inversify';
import {
    TYPES,
    gridModule,
    helperLineModule,
    hoverModule,
    contextMenuModule,
    initializeDiagramContainer,
    ContainerConfiguration
} from '@eclipse-glsp/client';
import { WorkflowContextMenuService } from './context-menu-service';
import { diagramBaseModule } from './base.module';
import { workflowViewsModule } from './stock-views.module';

/** Options for {@link createDiagramContainer}. */
export interface DiagramContainerOptions {
    /**
     * The diagram client id — must match the host DOM anchors
     * (`${clientId}_container` / `_popup` / `_hidden`). See the DOM-anchor
     * contract above.
     */
    clientId: string;
    /**
     * Consumer view/feature modules, composed AFTER the neutral base in array
     * order. The stock entry passes `[workflowViewsModule, workflowFeaturesModule]`.
     */
    features: ContainerModule[];
    /**
     * Convenience: prepend `workflowViewsModule` (the stock model/view set) ahead
     * of `features`. The stock feature UI stays separate — pass
     * `workflowFeaturesModule` explicitly when you want it.
     *
     * CAVEAT: do NOT also pass `workflowViewsModule` inside `features` when this
     * is `true` — the stock model/view set would register twice and GLSP throws
     * on the duplicate `configureModelElement` binding. Use the flag OR list the
     * module explicitly, never both.
     */
    withStockViews?: boolean;
}

/**
 * The ordered module list the factory loads: neutral base first, then the stock
 * views (when `withStockViews`), then consumer features. Exported for the
 * container-parity test — this is the exact sequence handed to GLSP.
 */
export function composeDiagramModules(options: DiagramContainerOptions): ContainerModule[] {
    const modules: ContainerModule[] = [diagramBaseModule];
    if (options.withStockViews) {
        modules.push(workflowViewsModule);
    }
    modules.push(...options.features);
    return modules;
}

/**
 * Create and initialize a diagram container: the neutral base + `features`, plus
 * the GLSP grid/helper-line/hover/context-menu modules, following the GLSP 2.5.x
 * `initializeDiagramContainer` pattern.
 *
 * `containerConfiguration` carries the GLSP VS Code integration modules the
 * starter supplies (the diagram-options module + `VSCODE_DEFAULT_MODULE_CONFIG`);
 * it is spread in the same position the monolith used, preserving DI precedence.
 *
 * Uses type assertions to work around ESM/CJS inversify type conflicts.
 */
export function createDiagramContainer(
    options: DiagramContainerOptions,
    ...containerConfiguration: ContainerConfiguration
): Container {
    if (typeof options?.clientId !== 'string') {
        throw new TypeError('createDiagramContainer: options.clientId must be a string');
    }
    if (!Array.isArray(options.features)) {
        throw new TypeError('createDiagramContainer: options.features must be an array of ContainerModules');
    }

    const modules = composeDiagramModules(options);

    const created = initializeDiagramContainer(
        new Container() as never,
        // Neutral base + optional stock views + consumer features (DEFAULT_MODULES
        // are added by initializeDiagramContainer itself).
        ...(modules as never[]),
        // VS Code integration modules from the starter (diagram options, bindings).
        ...(containerConfiguration as never[]),
        // Optional visible grid + snap-to-grid support (toggle via ShowGridAction).
        gridModule as never,
        // Alignment helper lines during move/resize (GLSP optional feature).
        helperLineModule as never,
        // Hover popups (used for validation marker details).
        hoverModule as never,
        // Enable right-click context menu feature (must come after VS Code
        // integration, which removes the default context menu module).
        contextMenuModule as never
    ) as Container;

    rebindContextMenuService(created);
    return created;
}

/**
 * Ensure the workflow context-menu implementation wins even if VS Code
 * integration modules bind a default/no-op service later. Kept as a post-init
 * step (not a module) because `contextMenuModule` loads AFTER the feature modules
 * and would otherwise override an in-module binding.
 */
function rebindContextMenuService(container: Container): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdAny = container as any;
    const debugContextMenu = (() => {
        try {
            return globalThis?.localStorage?.getItem('workflow.debugContextMenu') === '1';
        } catch {
            return false;
        }
    })();
    if (createdAny.isBound?.(TYPES.IContextMenuService)) {
        createdAny.rebind(TYPES.IContextMenuService).to(WorkflowContextMenuService).inSingletonScope();
        if (debugContextMenu) {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] rebound IContextMenuService -> WorkflowContextMenuService');
        }
    } else {
        createdAny.bind(TYPES.IContextMenuService).to(WorkflowContextMenuService).inSingletonScope();
        if (debugContextMenu) {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] bound IContextMenuService -> WorkflowContextMenuService');
        }
    }
}
