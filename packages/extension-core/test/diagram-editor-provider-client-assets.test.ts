// SP3 Task 3: `DiagramProfile.clientAssets` is the host-side seam that lets a
// custom-view consumer serve its OWN webview bundle. These tests pin two things:
//  (1) a profile WITHOUT clientAssets renders today's stock webview HTML
//      byte-identically (the default-path snapshot, captured from the provider
//      before the seam existed), and
//  (2) a profile WITH clientAssets serves the configured script/style via
//      asWebviewUri with a per-file `?v=<mtime>` cache-bust and extends
//      `localResourceRoots` with the configured roots.
//
// The provider is exercised through the same GLSP-base stub the live-overlay
// test uses, so it constructs in plain Node without loading the real
// `@eclipse-glsp/vscode-integration` barrel.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        onDidChangeCustomDocument: unknown;
        constructor(protected readonly glspVscodeConnector: any) {
            this.onDidChangeCustomDocument = glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');
type WorkflowEditorProvider = InstanceType<typeof WorkflowEditorProvider>;

const STOCK_PROFILE = {
    key: 'test',
    settingsNamespace: 'test',
    commands: undefined,
    operationKinds: undefined,
    clientBehavior: undefined
} as unknown as DiagramProfile;

const CLIENT_ID = 'client-0';
const DOCUMENT_URI = 'file:///workspace/pipeline.py';
// A fixed, non-existent assets root so stock-path stat() fails deterministically
// (bare URIs, no `?v=`), matching a test host with no built bundle on disk.
const ASSETS_ROOT = '/fake-ext';

/** Deterministic webview double: `asWebviewUri` maps a file URI to a stable
 *  https form so snapshots don't embed a random extension directory, and the
 *  html/options the provider sets are captured for assertion. */
function makeWebviewPanel() {
    const captured: { html?: string; options?: any } = {};
    const webview = {
        cspSource: 'vscode-webview://webview',
        asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://webview${uri.fsPath}`),
        onDidReceiveMessage: (_cb: (...a: any[]) => any) => ({ dispose() {} }),
        postMessage: async (_m: unknown) => true,
        set options(value: any) {
            captured.options = value;
        },
        get options() {
            return captured.options;
        },
        set html(value: string) {
            captured.html = value;
        },
        get html() {
            return captured.html ?? '';
        }
    };
    const panel = {
        webview,
        onDidDispose: (_cb: () => void) => ({ dispose() {} })
    } as unknown as vscode.WebviewPanel;
    return { panel, captured };
}

function render(profile: DiagramProfile): { html: string; options: any } {
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: () => {}
    } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider = new WorkflowEditorProvider(context, connector, profile, vscode.Uri.file(ASSETS_ROOT));
    const { panel, captured } = makeWebviewPanel();
    const document = { uri: vscode.Uri.parse(DOCUMENT_URI) } as vscode.CustomDocument;
    provider.setUpWebview(document, panel, {} as vscode.CancellationToken, CLIENT_ID);
    return { html: captured.html ?? '', options: captured.options };
}

/** Replace the per-render random CSP nonce with a placeholder so the HTML is
 *  stable enough to snapshot. */
function normalizeNonce(html: string): string {
    return html
        .replace(/nonce-[^']+'/g, "nonce-NONCE'")
        .replace(/nonce="[^"]+"/g, 'nonce="NONCE"');
}

function localResourceRootStrings(options: any): string[] {
    return (options.localResourceRoots as vscode.Uri[]).map(u => u.toString());
}

describe('WorkflowEditorProvider default webview assets (no clientAssets)', () => {
    it('renders today\'s stock webview HTML byte-identically', () => {
        const { html } = render(STOCK_PROFILE);
        expect(normalizeNonce(html)).toMatchInlineSnapshot(`
          "<!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <meta http-equiv="Content-Security-Policy" content="
                  default-src 'none';
                  style-src vscode-webview://webview 'unsafe-inline';
                  script-src 'nonce-NONCE' 'wasm-unsafe-eval' vscode-webview://webview;
                  connect-src vscode-webview://webview blob:;
                  font-src vscode-webview://webview data:;
                  img-src vscode-webview://webview data:;
              ">
              <link href="https://webview/fake-ext/dist/webview/diagram-client.css" rel="stylesheet" />
              <title>Workflow Network Diagram</title>
              <style>
                  html, body {
                      height: 100%;
                      width: 100%;
                      margin: 0;
                      padding: 0;
                      overflow: hidden;
                  }
                  .sprotty-container {
                      height: 100%;
                      width: 100%;
                  }
              </style>
          </head>
          <body>
              <div id="client-0" class="sprotty-container">
                  <!-- Sprotty diagram will be rendered here -->
              </div>
              
              <!-- Properties Toggle Button (floating, top-left) -->
              <button id="btn-toggle-properties" class="floating-tool-btn" title="Show Properties (P)">
                  <span class="codicon codicon-list-selection"></span>
              </button>
              
              <!-- Property Panel (positioned absolute, left side) -->
              <div id="property-panel" class="property-panel collapsed">
                  <div class="property-panel-header">
                      <span class="panel-title">Properties</span>
                      <div class="panel-header-actions">
                          <button id="btn-float-properties" class="panel-btn" title="Float panel near node">
                              <span class="codicon codicon-move"></span>
                          </button>
                          <button id="btn-pin-properties" class="panel-btn" title="Pin panel (keeps visible)">
                              <span class="codicon codicon-pin"></span>
                          </button>
                          <button id="btn-close-properties" class="panel-btn" title="Close">
                              <span class="codicon codicon-close"></span>
                          </button>
                      </div>
                  </div>
                  <div class="property-panel-body">
                      <div id="property-content">
                          <div class="no-selection">Select an element to view properties</div>
                      </div>
                  </div>
              </div>

              <script nonce="NONCE">
                  // Pass diagram identifier to the client. Serialized as one JSON literal
                  // with '<' escaped so no value (e.g. a URI) can break out of the script.
                  window.diagramIdentifier = {"clientId":"client-0","diagramType":"cal-network-diagram","uri":"file:///workspace/pipeline.py","settingsNamespace":"test","libavoidWasmUri":"https://webview/fake-ext/dist/webview/libavoid.wasm","libavoidModuleUri":"https://webview/fake-ext/dist/webview/libavoid.mjs"};

                  // Optional debug config injected from the extension host (launch.json env).
                  try {
                      if (false) {
                          localStorage.setItem('workflow.diagram.debug.portLabels', '1');
                      }
                      if (false) {
                          localStorage.setItem('workflow.diagram.debug.portLabels.all', '1');
                      }
                      const thresholdRaw = undefined;
                      if (thresholdRaw !== undefined && thresholdRaw !== '') {
                          localStorage.setItem('workflow.diagram.debug.portLabels.thresholdPx', String(thresholdRaw));
                      }
                      const filterRaw = undefined;
                      if (filterRaw !== undefined && filterRaw !== '') {
                          localStorage.setItem('workflow.diagram.debug.portLabels.filter', String(filterRaw));
                      }

                      // Edge route/bendpoint overlay (WorkflowEdgeView).
                      // This is a purely visual client-side debug aid.
                      if (false) {
                          (window).WORKFLOW_DEBUG_EDGE_POINTS = true;
                      }
                  } catch {
                      // ignore
                  }

                  // Debug plumbing: verify webview -> extension host messaging works and surface
                  // any runtime errors from the webview/client bundle in the Extension Host console.
                  try {
                      // NOTE: VS Code only allows acquiring the API once per webview.
                      // Cache and reuse it; also override acquireVsCodeApi so libraries that
                      // call it internally won't crash the webview.
                      const originalAcquire = acquireVsCodeApi;
                      const vscode = originalAcquire();
                      window.__calVscodeApi = vscode;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (window).acquireVsCodeApi = () => vscode;
                      vscode.postMessage({ type: 'dialogram.diagram.clientDebug.inlinePing', payload: { when: Date.now() } });
                      vscode.postMessage({
                          type: 'dialogram.diagram.clientDebug.inlineConfig',
                          payload: {
                              debugPortLabels: false,
                              debugPortLabelsAll: false,
                              thresholdPx: undefined,
                              filter: undefined,
                              debugEdgePoints: false
                          }
                      });
                      window.addEventListener('error', (e) => {
                          vscode.postMessage({
                              type: 'dialogram.diagram.clientDebug.webviewError',
                              payload: {
                                  message: e?.message,
                                  filename: e?.filename,
                                  lineno: e?.lineno,
                                  colno: e?.colno
                              }
                          });
                      });
                      window.addEventListener('unhandledrejection', (e) => {
                          const anyEvent = e;
                          const reason = anyEvent && anyEvent.reason;
                          vscode.postMessage({
                              type: 'dialogram.diagram.clientDebug.webviewUnhandledRejection',
                              payload: {
                                  message: reason?.message ?? String(reason)
                              }
                          });
                      });
                  } catch {
                      // ignore
                  }
              </script>
              <!-- Parser-blocking by design: this classic <script> runs synchronously in
                   document order, so the client bundle installs the webview messenger
                   BEFORE VS Code flushes any queued postMessage to the webview (the diagram
                   identifier, an in-progress run's overlay batch). Do NOT add defer/async/
                   type="module" — any of them defers execution past the flush and early
                   host notifications are dropped before a handler exists. See task-4 review. -->
              <script nonce="NONCE" src="https://webview/fake-ext/dist/webview/diagram-client.js"></script>
          </body>
          </html>"
        `);
    });

    it('serves the stock diagram-client.js / .css under the assets dist dir', () => {
        const { html } = render(STOCK_PROFILE);
        expect(html).toContain('src="https://webview/fake-ext/dist/webview/diagram-client.js"');
        expect(html).toContain('href="https://webview/fake-ext/dist/webview/diagram-client.css"');
    });

    it('scopes localResourceRoots to the stock out/ and dist/ dirs', () => {
        const { options } = render(STOCK_PROFILE);
        expect(localResourceRootStrings(options)).toEqual([
            'file:///fake-ext/out',
            'file:///fake-ext/dist'
        ]);
    });
});

describe('WorkflowEditorProvider configured webview assets (clientAssets)', () => {
    /** Writes a consumer bundle to a temp dir with fixed mtimes so cache-bust
     *  values are deterministic. mtime seconds → `?v=<seconds * 1000>`. */
    function makeConsumerBundle(): { dir: string; scriptPath: string; stylePath: string } {
        const dir = mkdtempSync(path.join(tmpdir(), 'dialogram-client-assets-'));
        const scriptPath = path.join(dir, 'consumer-client.js');
        const stylePath = path.join(dir, 'consumer-client.css');
        writeFileSync(scriptPath, '// consumer bundle');
        writeFileSync(stylePath, '/* consumer styles */');
        utimesSync(scriptPath, new Date(1000 * 1000), new Date(2000 * 1000));
        utimesSync(stylePath, new Date(1000 * 1000), new Date(3000 * 1000));
        return { dir, scriptPath, stylePath };
    }

    function profileWith(clientAssets: DiagramProfile['clientAssets']): DiagramProfile {
        return { ...(STOCK_PROFILE as object), clientAssets } as unknown as DiagramProfile;
    }

    it('serves the configured script/style via asWebviewUri with per-file mtime cache-bust', () => {
        const { scriptPath, stylePath } = makeConsumerBundle();
        const { html } = render(profileWith({ scriptPath, stylePath }));

        expect(html).toContain(`src="https://webview${scriptPath}?v=2000000"`);
        expect(html).toContain(`href="https://webview${stylePath}?v=3000000"`);
        // The stock bundle must NOT be referenced when the consumer supplies its own.
        expect(html).not.toContain('diagram-client.js');
        expect(html).not.toContain('diagram-client.css');
    });

    it('extends localResourceRoots with the configured roots (stock roots retained)', () => {
        const { scriptPath, stylePath } = makeConsumerBundle();
        const { options } = render(
            profileWith({ scriptPath, stylePath, localResourceRoots: ['/consumer/assets', 'file:///consumer/dist'] })
        );
        expect(localResourceRootStrings(options)).toEqual([
            'file:///fake-ext/out',
            'file:///fake-ext/dist',
            'file:///consumer/assets',
            'file:///consumer/dist'
        ]);
    });

    it('omits the stylesheet link when no stylePath is configured', () => {
        const { scriptPath } = makeConsumerBundle();
        const { html } = render(profileWith({ scriptPath }));
        expect(html).toContain(`src="https://webview${scriptPath}?v=2000000"`);
        expect(html).not.toContain('rel="stylesheet"');
    });

    it('serves an unreadable configured script with v=0 and warns (no silent fallback to stock)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const missing = '/no/such/dir/consumer-client.js';
        try {
            const { html } = render(profileWith({ scriptPath: missing }));
            expect(html).toContain(`src="https://webview${missing}?v=0"`);
            expect(html).not.toContain('diagram-client.js');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(missing));
        } finally {
            warn.mockRestore();
        }
    });
});
