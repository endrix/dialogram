#!/usr/bin/env bash
#
# check-neutrality.sh — verify the three product-neutrality gates for the
# dialogram platform packages. Run via `npm run check:neutrality`.
#
# The four core packages (diagram-server, diagram-client, extension-core,
# shared) plus the sidecar-toolkit must carry no product vocabulary. The one
# sanctioned exception is extension-core's legacy-settings-compat.ts, which is
# permitted to name legacy settings keys.
#
# Exits non-zero if any gate fails.

set -u

# Resolve repo root as the parent of this script's directory, so the gate
# paths resolve regardless of the caller's working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

CORE_SRC=(
    packages/diagram-server/src
    packages/diagram-client/src
    packages/extension-core/src
)
GATE1_ALLOW='packages/extension-core/src/extension/legacy-settings-compat.ts'

failures=0

echo '== Gate 1: core content (no sidecar/wfpy/calpy/python) =='
gate1_hits="$(grep -ri 'sidecar\|wfpy\|calpy\|python' "${CORE_SRC[@]}" \
    | grep -vE "${GATE1_ALLOW}")"
if [ -n "${gate1_hits}" ]; then
    echo 'FAIL: product tokens found outside the compat allow-list:'
    echo "${gate1_hits}"
    failures=$((failures + 1))
else
    echo "PASS (allow-list: ${GATE1_ALLOW})"
fi

echo
echo '== Gate 2: toolkit content (no wfpy/calpy/calLang) =='
gate2_hits="$(grep -ri 'wfpy\|calpy\|calLang' packages/sidecar-toolkit/src)"
if [ -n "${gate2_hits}" ]; then
    echo 'FAIL: product tokens found in sidecar-toolkit:'
    echo "${gate2_hits}"
    failures=$((failures + 1))
else
    echo 'PASS'
fi

echo
echo '== Gate 3: branded filenames (no workflow-*/wfpy-*/cal*-*) =='
gate3_hits="$(find \
    packages/diagram-server/src \
    packages/diagram-client/src \
    packages/extension-core/src \
    packages/shared/src \
    -name 'workflow-*' -o -name 'wfpy-*' -o -name 'cal*-*')"
if [ -n "${gate3_hits}" ]; then
    echo 'FAIL: branded filenames found:'
    echo "${gate3_hits}"
    failures=$((failures + 1))
else
    echo 'PASS'
fi

echo
if [ "${failures}" -ne 0 ]; then
    echo "NEUTRALITY CHECK FAILED (${failures} gate(s) violated)"
    exit 1
fi
echo 'NEUTRALITY CHECK PASSED (3/3 gates)'
