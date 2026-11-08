/**
 * The stock webview bundle's entry point: the stock diagram, nothing added.
 *
 * Built into `dist/webview/diagram-client.{js,css}` and served for every
 * profile without `clientAssets`. A product's own bundle is this file with its
 * feature modules passed to `startStockDiagram` and its stylesheet imported
 * last (see `stock-starter.ts`).
 *
 * The starter is imported BEFORE the stylesheets, and that order is the
 * cascade: esbuild writes CSS in the order it meets it, and the starter's
 * imports bring GLSP's own stylesheets (sprotty, tool palette, …). Ours come
 * after them, so they override them.
 */

import { startStockDiagram } from './stock-starter';
// GLSP VS Code integration CSS (includes tool palette, etc.)
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
// Grid styling used by @eclipse-glsp/client gridModule (toggles via ShowGridAction)
import '@eclipse-glsp/client/css/grid.css';
// Own the codicon font dependency explicitly — the inline shell buttons and our
// UI use codicons; don't rely on it arriving transitively via GLSP.
import '@vscode/codicons/dist/codicon.css';
// Custom Workflow diagram CSS (must come after GLSP CSS to override)
import './diagram-client.css';

startStockDiagram();
