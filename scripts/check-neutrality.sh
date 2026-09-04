#!/usr/bin/env bash
#
# check-neutrality.sh — verify the three product-neutrality gates for the
# dialogram platform packages. Run via `npm run check:neutrality`.
#
# The four core packages (diagram-server, diagram-client, extension-core,
# shared) plus the sidecar-toolkit must carry no product vocabulary — including a
# product's FILE EXTENSION, which reads as punctuation rather than as vocabulary
# and so slipped past the word-based gates for as long as they have existed. The
# one sanctioned exception is extension-core's legacy-settings-compat.ts, which is
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
# The product names, not a sample of them. This list read `wfpy|calpy|calLang`
# while the header above claimed "no product vocabulary" — so `streamblocks`
# passed, and fourteen mentions of it accumulated in the create-node handler,
# including prompts users read. A gate whose check is narrower than its claim
# reports success for the thing it was written to prevent.
echo '== Gate 2: toolkit content (no product vocabulary) =='
gate2_hits="$(grep -ri 'wfpy\|calpy\|calLang\|streamblocks' packages/sidecar-toolkit/src)"
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
echo '== Gate 4: opencode-only MCP (no vscode.lm) =='
# Phase B locked decision: the GLSP-MCP server is reachable ONLY over its
# loopback URL by our opencode/ACP agents. VS Code's built-in (Copilot) MCP host
# — `vscode.lm.registerMcpServerDefinitionProvider` / `GlspMcpServerProvider` —
# is deliberately NOT used, so no `engines.vscode` bump is needed. This gate
# fails if any `vscode.lm` usage creeps into the shipped sources.
gate4_hits="$(grep -rn 'vscode\.lm' packages/*/src 2>/dev/null || true)"
if [ -n "${gate4_hits}" ]; then
    echo 'FAIL: vscode.lm usage found (opencode-only MCP — do not adopt the VS Code MCP host):'
    echo "${gate4_hits}"
    failures=$((failures + 1))
else
    echo 'PASS'
fi

echo
echo '== Gate 5: no product source extension in the core =='
# The gate the other four missed. One product's source extension was compiled
# into extension-core in seven places — six path tests and a file-system watcher
# glob — and every gate above passed the whole time: gates 1 and 2 look for WORDS,
# and an extension is not a word. A consumer whose files end in anything else got
# commands that refused every file it gave them, and a warning telling it to open
# a kind of file it does not have — naming an extension it does not use, in text
# it could not change.
#
# What is banned is narrow on purpose: deciding, from a literal extension, whether
# a PATH is one of the product's source files. That question belongs to the
# profile's `sourceExtensions`, which the core reads through
# `extension-core/src/extension/diagram/source-extensions.ts` — a comparison
# against a value, which no literal-matching pattern can catch.
#
# Deliberately NOT banned: an extension test on something that is not a path into
# a product's sources — filtering directory entries by name inside a directory the
# PLATFORM itself defines (`.wf/skills/*.sh`, `.claude/agents/*.md`). That layout
# is the platform's own, so the platform is the one entitled to name it.
gate5_hits="$(grep -rnE "(fsPath|[Pp]ath)[^;]*\.endsWith\(\s*['\"]\." "${CORE_SRC[@]}" || true)
$(grep -rnE "createFileSystemWatcher\(\s*['\"][^'\"]*\*\.[A-Za-z0-9]" "${CORE_SRC[@]}" || true)"
if [ -n "$(echo "${gate5_hits}" | tr -d '[:space:]')" ]; then
    echo 'FAIL: the core decides what a source file is from a hardcoded extension;'
    echo '      ask the profile instead (DiagramProfile.sourceExtensions):'
    echo "${gate5_hits}"
    failures=$((failures + 1))
else
    echo 'PASS'
fi

echo
if [ "${failures}" -ne 0 ]; then
    echo "NEUTRALITY CHECK FAILED (${failures} gate(s) violated)"
    exit 1
fi
echo 'NEUTRALITY CHECK PASSED (5/5 gates)'
