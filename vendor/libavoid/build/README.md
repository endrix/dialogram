# Rebuilding the vendored libavoid

Only needed to change the libavoid version or its compile flags. The artifacts
in the parent directory are checked in; a normal build does not run this.

## Requirements

- Emscripten SDK **3.1.36** (the version upstream pins)
- python3, git, node

Upstream compiles inside `docker run emscripten/emsdk:3.1.36`. The patch below
replaces that with a direct `emcc` call so it works with a local emsdk.

## Steps

```sh
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install 3.1.36 && ./emsdk activate 3.1.36
source ./emsdk_env.sh
cd ..

git clone --recurse-submodules https://github.com/Aksem/libavoid-js.git
cd libavoid-js
git checkout v0.4.5

git apply /path/to/vendor/libavoid/build/generate.py.patch

# generate.py expects to run from the repo root and to find these
mkdir -p examples/dist examples/debug-dist examples/debug-src/generated src/generated

python3 tools/generate.py     # clones adaptagrams v1.0.4, runs the WebIDL binder, compiles
npm install && npm run build  # bundles the AvoidLib wrapper around the WASM
```

Then copy into `vendor/libavoid/`:

| from | to |
| --- | --- |
| `dist/index.js` | `libavoid-web.mjs` |
| `dist/index-node.mjs` | `libavoid-node.mjs` |
| `dist/libavoid.wasm` | `libavoid.wasm` |
| `LICENSE` | `LICENSE` |

## What the patch changes

1. **`-sDYNAMIC_EXECUTION=0`** — the reason this is vendored at all. Without it
   embind generates bindings with `new Function`, which the webview CSP blocks.
2. **Direct `emcc` instead of `docker run`** — so a local emsdk can be used.
3. **Skips the API-docs step** — it shells out to `jsdoc`, and its absence
   aborts the script *before* the production web and node builds run.
4. **Skips the debug build** — only the production artifacts are vendored.

## Verifying a rebuild

The build is only correct if it is eval-free:

```sh
grep -c 'new Function\|eval(\|createNamedFunction' dist/index.js   # must be 0
```

And it must route identically. `packages/diagram-server/test/` carries captured
geometry from real drags; the libavoid tests there fail if routes change.
