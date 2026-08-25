#!/usr/bin/env bash
#
# Type-check every package a consumer compiles.
#
# `npm run build` builds ONE workspace (packages/extension) and bundles the rest
# with esbuild, which strips types without checking them. So a type error in an
# inner package survives a green build here and surfaces in a CONSUMER's build —
# wfpy-ide and streamblocks-ide resolve `@dialogram/*` to these TypeScript
# sources and compile them under their own strict tsconfig. That is the wrong
# place to find out: the platform is green, the product is red, and the error is
# in a file the product does not own.
#
# Two real ones were found the day this script was written: a missing import in
# sidecar-commands.ts, and a type imported from a module that re-declares rather
# than re-exports it.
set -euo pipefail

cd "$(dirname "$0")/.."

PACKAGES=(shared sidecar-toolkit diagram-server diagram-client extension-core)
failed=()

for package in "${PACKAGES[@]}"; do
    printf '== %-16s ' "$package"
    if npx tsc --noEmit -p "packages/$package" > "/tmp/dialogram-typecheck-$package.log" 2>&1; then
        echo 'OK'
    else
        echo 'FAIL'
        cat "/tmp/dialogram-typecheck-$package.log"
        failed+=("$package")
    fi
done

if [ ${#failed[@]} -gt 0 ]; then
    echo
    echo "TYPECHECK FAILED: ${failed[*]}"
    exit 1
fi

echo
echo "TYPECHECK PASSED (${#PACKAGES[@]}/${#PACKAGES[@]} packages)"
