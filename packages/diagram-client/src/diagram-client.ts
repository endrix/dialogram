/**
 * Workflow Diagram Client Entry Point
 * 
 * Main entry point for the GLSP diagram client running in the VS Code webview.
 * Uses GLSPStarter pattern from @eclipse-glsp/vscode-integration-webview for
 * proper GLSP 2.5.x VS Code integration.
 * 
 * The GLSPStarter handles:
 * - vscode-messenger communication with the host extension
 * - GLSPClient initialization 
 * - Diagram container setup
 * - Action dispatching
 */

import 'reflect-metadata';

import { ContainerConfiguration } from '@eclipse-glsp/client';
import { GLSPStarter } from '@eclipse-glsp/vscode-integration-webview';
// GLSP VS Code integration CSS (includes tool palette, etc.)
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
// Grid styling used by @eclipse-glsp/client gridModule (toggles via ShowGridAction)
import '@eclipse-glsp/client/css/grid.css';
// Own the codicon font dependency explicitly — the inline shell buttons and our
// UI use codicons; don't rely on it arriving transitively via GLSP.
import '@vscode/codicons/dist/codicon.css';
// Custom Workflow diagram CSS (must come after GLSP CSS to override)
import './diagram-client.css';
import { createDiagramContainer } from './container';
import { workflowViewsModule } from './stock-views.module';
import { workflowFeaturesModule } from './stock-features.module';
import { installToolPaletteHeaderControls } from './tool-palette-header-controls';
import { installDiagramWebviewChannel } from './webview-channel';
import { installExecutionOverlayRouting } from './execution-overlay-message-bridge';

// Optional debug: confirm right-click events reach the webview.
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

/**
 * Workflow Diagram Starter
 * 
 * Extends GLSPStarter to create the Workflow diagram container with 
 * proper modules for network diagram visualization.
 */
class WorkflowDiagramStarter extends GLSPStarter {
    constructor() {
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
     * Create the Workflow diagram container: the neutral base + the stock
     * workflow views and feature UI, recomposed through the library factory so
     * the shipped bundle behaves identically to the former monolith.
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
            { clientId, features: [workflowViewsModule, workflowFeaturesModule] },
            ...(containerConfiguration as never[])
        );
    }
}

// Initialize the starter
new WorkflowDiagramStarter();

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
