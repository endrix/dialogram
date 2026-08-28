# libavoid (vendored, built without dynamic execution)

Orthogonal connector routing from [Adaptagrams](https://www.adaptagrams.org/),
compiled to WebAssembly. Used by the edge router on both sides: the GLSP server
routes on commit, the webview routes live during a drag.

## Why this is vendored rather than an npm dependency

The published `libavoid-js` package is built with Emscripten **embind**, which
generates its class bindings at runtime with `new Function(...)`. A VS Code
webview's Content Security Policy forbids that:

```
EvalError: Evaluating a string as JavaScript violates the following Content
Security Policy directive because 'unsafe-eval' is not an allowed source of
script: script-src 'nonce-...' 'wasm-unsafe-eval' ...
    at new Function (<anonymous>)
    at _embind_register_class_constructor
```

The alternative was adding `'unsafe-eval'` to the webview CSP, which would have
removed that protection for every piece of content the diagram renders —
including labels read out of user `.py` files. Rebuilding with
`-sDYNAMIC_EXECUTION=0` makes Emscripten emit the reflective, eval-free binding
path instead, so the CSP stays as it was.

Verified on this build: **0** occurrences of `new Function`, `eval(` and
`createNamedFunction`, against 2 / 0 / 1 in the published package.

## Version: 0.4.5, pinned

Upstream `master` is `v0.4.5`. The `0.5.0-beta.5` on npm was published from a
commit that was never pushed — there is no tag or branch for it — so it cannot
be rebuilt from source. We track the released version instead.

**0.4.5 has a flatter API than the 0.5 beta.** The code targets 0.4.5 directly;
there is no compatibility layer. If this is ever upgraded, these are the call
sites that change:

| what | 0.4.5 (here) | 0.5.0-beta.5 |
| --- | --- | --- |
| routing flag | `Avoid.OrthogonalRouting` | `Avoid.RouterFlag.OrthogonalRouting.value` |
| parameters | `Avoid.shapeBufferDistance` | `Avoid.RoutingParameter.shapeBufferDistance` |
| options | `Avoid.nudgeOrthogonalSegmentsConnectedToShapes` | `Avoid.RoutingOption.nudge...` |
| polyline point | `polyline.get_ps(i)` | `polyline.at(i)` |
| release | `router.__destroy__()` | `router.delete()` |

Routes are **byte-for-byte identical** to the published build: verified across
all 12 edges of `fixtures-frontend.json`, and marginally faster (25ms vs 34ms).

## Files

| file | used by |
| --- | --- |
| `libavoid-node.mjs` | GLSP server, copied to `packages/extension/dist/libavoid/` |
| `libavoid-web.mjs` | webview, copied to `packages/extension/dist/webview/` |
| `libavoid.wasm` | both |
| `LICENSE` | LGPL-2.1-or-later, see below |

Neither wrapper is bundled. Emscripten's browser build reads `import.meta.url`
to locate itself, and esbuild rewrites `import.meta` to `{}` when producing a
CJS or IIFE bundle — the module then aborts during initialisation and every
later error is masked as `program has already aborted!`. Both are loaded at
runtime from their own file instead.

## Licensing

libavoid is **LGPL-2.1-or-later**, while this repository is EPL-2.0 / GPL-2.0.
It is deliberately kept as a separate, replaceable artifact — never linked into
a bundle — which is the arrangement LGPL §6 describes for a work that merely
*uses* the library. `LICENSE` ships alongside the binary.

## Rebuilding

See `build/README.md`.
