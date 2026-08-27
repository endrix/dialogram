/**
 * libavoid (WASM) inside the webview.
 *
 * The server routes edges on commit; this is the other half — the live tier,
 * which routes while the mouse is still down. Both run libavoid so the two
 * agree, and the route does not visibly jump when the drag ends.
 *
 * Two constraints shape this file.
 *
 * `IEdgeRouter.route()` is SYNCHRONOUS: Sprotty calls it from the render pass,
 * so there is nowhere to await. The WASM module is therefore loaded once at
 * startup and the router simply does nothing until it is ready — falling back
 * to whatever route the model already carries — rather than blocking a frame.
 *
 * And a webview cannot read the filesystem, so the binary is fetched over an
 * `asWebviewUri` URL resolved by the extension host and passed in on
 * `window.diagramIdentifier`. That fetch needs `connect-src` and instantiation
 * needs `wasm-unsafe-eval`; both are granted narrowly in the CSP, to the
 * webview's own resource origin only.
 */

type AvoidModule = any;

let avoid: AvoidModule | undefined;
let loading: Promise<AvoidModule | undefined> | undefined;

function assetUri(field: 'libavoidWasmUri' | 'libavoidModuleUri'): string | undefined {
    const uri = (globalThis as any).diagramIdentifier?.[field];
    return typeof uri === 'string' && uri.length > 0 ? uri : undefined;
}

/**
 * Begin loading. Safe to call repeatedly; the work happens once.
 *
 * Resolves to `undefined` when the binary is unavailable, which leaves the live
 * tier switched off and the diagram working exactly as it did before — a
 * missing asset must degrade interactivity, never break rendering.
 */
export function preloadLibavoid(): Promise<AvoidModule | undefined> {
    if (!loading) {
        loading = (async () => {
            const uri = assetUri('libavoidWasmUri');
            const moduleUri = assetUri('libavoidModuleUri');
            if (!uri || !moduleUri) {
                console.warn('[libavoid] asset URIs missing from diagramIdentifier; live edge routing disabled');
                return undefined;
            }

            // Imported at runtime, never bundled. esbuild rewrites `import.meta`
            // to `{}` in an IIFE, and emscripten's browser build reads
            // `import.meta.url` to find itself — so inlining it makes the module
            // abort before anything can use it, masking every later error behind
            // "program has already aborted!". Loading the real ES module from a
            // URL gives it a genuine `import.meta.url`.
            let AvoidLib: any;
            try {
                const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleUri);
                AvoidLib = module?.AvoidLib ?? module?.default?.AvoidLib;
                if (!AvoidLib) {
                    console.warn('[libavoid] module exposes no AvoidLib; live edge routing disabled');
                    return undefined;
                }
            } catch (error) {
                console.warn(`[libavoid] could not import ${moduleUri}; live edge routing disabled`, error);
                return undefined;
            }
            // Fetch the binary ourselves rather than letting emscripten do it.
            //
            // emscripten uses `WebAssembly.instantiateStreaming`, which rejects
            // the response unless it arrives as `application/wasm`, and the
            // webview resource server does not promise that. When it rejects,
            // emscripten calls abort(), and every later error is masked by
            // "program has already aborted!" — which is all the original failure
            // leaves behind.
            //
            // Re-wrapping the bytes in a Blob with an explicit type gives
            // instantiateStreaming what it needs, and fetching by hand means a
            // missing or misrouted asset reports its own status instead.
            let blobUrl: string | undefined;
            try {
                const response = await fetch(uri);
                if (!response.ok) {
                    console.warn(`[libavoid] wasm fetch failed: ${response.status} ${response.statusText} (${uri})`);
                    return undefined;
                }
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength === 0) {
                    console.warn('[libavoid] wasm fetch returned an empty body; live edge routing disabled');
                    return undefined;
                }
                blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));

                await AvoidLib.load(blobUrl);
                const instance = AvoidLib.getInstance();
                if (!instance?.Router) {
                    console.warn('[libavoid] module loaded but exposes no Router; live edge routing disabled');
                    return undefined;
                }
                avoid = instance;
                console.info(`[libavoid] live edge routing ready (${bytes.byteLength} bytes)`);
                return instance;
            } catch (error) {
                console.warn('[libavoid] failed to load; live edge routing disabled', error);
                return undefined;
            } finally {
                if (blobUrl) {
                    URL.revokeObjectURL(blobUrl);
                }
            }
        })();
    }
    return loading;
}

/** The module, or `undefined` while still loading or if loading failed. */
export function libavoid(): AvoidModule | undefined {
    return avoid;
}

/** Whether the live tier can route right now. */
export function isLibavoidReady(): boolean {
    return avoid !== undefined;
}
