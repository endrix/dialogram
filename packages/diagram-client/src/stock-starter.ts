/**
 * The stock diagram's start-up, for the stock bundle and for a product's own.
 *
 * The shipped webview (`diagram-client.ts`) is this function called with no
 * options. A product that ships its own bundle through
 * `DiagramProfile.clientAssets` calls it with the feature modules it adds, and
 * so starts the same diagram: the same channel, the same overlay routing, the
 * same palette header controls and SVG export, the same stock views and feature
 * UI. The product's modules load after the stock views and feature UI, so a
 * `rebind` there replaces what a stock feature module bound; the VS Code
 * integration and GLSP's grid, helper-line, hover and context-menu modules load
 * after them, and the context-menu service is rebound last, so those stay as
 * they are (see `stockDiagramOptions`).
 *
 * Stylesheets are not imported here. A bundle imports this module FIRST, then
 * GLSP's VS Code CSS, the stock diagram's and its own, in that order: esbuild's
 * CSS loader writes stylesheets in the order it meets them, this module's
 * imports bring GLSP's own (sprotty, tool palette, …), and so the stock rules
 * override GLSP's and the product's override both. `diagram-client.ts` is the
 * stock example.
 *
 * Not exported from the package barrel: importing this module starts nothing,
 * but it pulls in GLSP's VS Code webview integration, which only a bundle
 * needs. A product imports it by path, `@dialogram/diagram-client/stock-starter`,
 * which resolves through the build's Dialogram resolver: the package has no
 * `exports` map, so the bundler must map `@dialogram/<pkg>/<subpath>` to
 * `packages/<pkg>/src/<subpath>.ts` (chisel-ide's `resolveDialogramPlugin`;
 * README §3).
 */

import 'reflect-metadata';

import type { ContainerConfiguration } from '@eclipse-glsp/client';
import { GLSPStarter } from '@eclipse-glsp/vscode-integration-webview';
import type { ContainerModule } from 'inversify';
import { createDiagramContainer, stockDiagramOptions } from './container';
import { installToolPaletteHeaderControls } from './tool-palette-header-controls';
import { installSvgExportRequests } from './svg-export-command';
import { installDiagramWebviewChannel } from './webview-channel';
import { installExecutionOverlayRouting } from './execution-overlay-message-bridge';

export interface StockDiagramOptions {
    /**
     * The product's feature modules, loaded after the stock views and the stock
     * feature UI, in this order.
     */
    features?: readonly ContainerModule[];
}

class StockDiagramStarter extends GLSPStarter {
    constructor(private readonly features: readonly ContainerModule[]) {
        super();
        // Publish the ONE canonical channel over GLSP's messenger — the instance
        // that actually receives host notifications — so the chat panel and the
        // overlay routing register on it instead of on a second, unreached
        // instance. First-class handler composition (no last-write-wins) means
        // the client-only overlay routes and GLSP's late stock actionMessage
        // handler coexist, whatever order they register in. See webview-channel.ts.
        const channel = installDiagramWebviewChannel(this.messenger as never);
        installExecutionOverlayRouting(channel);
    }

    /**
     * The neutral base, the stock views and feature UI, then the product's
     * modules (`stockDiagramOptions`), recomposed through the library factory.
     *
     * Uses type assertion to work around ESM/CJS inversify type conflicts.
     *
     * @param containerConfiguration Additional container configuration (the GLSP
     *        VS Code integration modules supplied by GLSPStarter)
     * @returns The configured Inversify container
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createContainer(...containerConfiguration: ContainerConfiguration): any {
        const identifier = (globalThis as { diagramIdentifier?: { clientId?: unknown } })?.diagramIdentifier;
        const clientId = typeof identifier?.clientId === 'string' ? identifier.clientId : '';
        return createDiagramContainer(
            stockDiagramOptions(clientId, this.features),
            ...(containerConfiguration as never[])
        );
    }
}

let started = false;

/**
 * Start the stock diagram in this webview, with `options.features` added.
 * Call it once, from the bundle's entry module, at load: the starter's
 * constructor must install the messenger before VS Code flushes the queued
 * host notifications. A second call does nothing but warn: a second starter
 * would acquire the VS Code API twice, which throws, and install the palette
 * header controls and SVG export twice.
 */
export function startStockDiagram(options: StockDiagramOptions = {}): void {
    if (started) {
        // eslint-disable-next-line no-console
        console.warn('[dialogram] startStockDiagram: the diagram is already started in this webview; ignoring the second call');
        return;
    }
    started = true;
    installContextMenuDebug();

    new StockDiagramStarter(options.features ?? []);

    // Always-on webview breadcrumb: `performance.now()` here is ms elapsed since the webview document
    // began loading (navigation start), so it captures bundle download + eval + GLSP container wiring.
    // Paired with the `firstSetModel` line (viewport-preserving-set-model-command.ts) it brackets how
    // much of a slow open lives in the webview vs. the host/server pipeline.
    try {
        // eslint-disable-next-line no-console
        console.log(`[dialogram perf] webview: starterReady=${Math.round(performance.now())}ms (since page load)`);
    } catch {
        // performance may be unavailable in exotic hosts; the breadcrumb is best-effort.
    }

    // Patch GLSP tool palette header (Run button + fit/center behavior)
    installToolPaletteHeaderControls();
    installSvgExportRequests();
}

/** Optional debug: confirm right-click events reach the webview. */
function installContextMenuDebug(): void {
    try {
        if (globalThis?.localStorage?.getItem('workflow.debugContextMenu') === '1') {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] debug enabled (cal.debugContextMenu=1)');
            window.addEventListener(
                'contextmenu',
                (e: MouseEvent) => {
                    // eslint-disable-next-line no-console
                    console.log('[cal][context-menu] DOM contextmenu', { x: e.clientX, y: e.clientY, target: (e.target as Element | null)?.tagName });
                },
                true
            );
        }
    } catch {
        // ignore
    }
}
