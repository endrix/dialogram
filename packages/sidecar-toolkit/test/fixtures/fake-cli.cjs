#!/usr/bin/env node
// Fake wfpy CLI: emits the fixture graph doc for `plan <file> --format graph --best-effort`.
// Logs its invocation argv (minus node/script) to FAKE_CLI_LOG, one JSON array per line, so
// characterization tests can count/inspect real spawn invocations without monkey-patching
// WorkflowSourceModelStorage internals.
//
// Set FAKE_CLI_DOC_ERRORS=1 to emit the same fixture graph but with a non-empty *doc-level*
// `errors` array added (a sibling of `graph`, not `graph.errors`) carrying a full
// `{message, file, line, column}` entry. Used by diagnostics-parity.test.ts to pin that the wfpy
// CLI-success path publishes `doc.graph` alone -- doc-level `errors` must never reach the
// Problems panel on this path (pre-branch parity; see source-model-storage.ts#loadPythonModel).
//
// Set FAKE_CLI_FAIL=1 to simulate a `wfpy plan` that fails at runtime (e.g. the workflow module
// raises on import): logs its invocation (so the "CLI was consulted" pin can inspect it) then
// exits non-zero without ever writing to stdout, matching `getGraph`'s `exitCode !== 0` failure
// branch -- which falls through to `renderStaticSidecarFallback`. Used by
// characterization-fallback.test.ts (F6) to pin the CLI-failure -> static-sidecar-fallback path.
const fs = require('node:fs');
const path = require('node:path');

const logFile = process.env.FAKE_CLI_LOG;
if (logFile) {
    fs.appendFileSync(logFile, `${JSON.stringify(process.argv.slice(2))}\n`);
}

if (process.env.FAKE_CLI_FAIL === '1') {
    process.stderr.write('simulated wfpy plan runtime failure: module raised on import\n');
    process.exit(1);
} else if (process.env.FAKE_CLI_DOC_ERRORS === '1') {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-graph.json'), 'utf8'));
    fixture.errors = [
        { message: 'doc-level error that must not reach the Problems panel', file: '/tmp/doc-level-error-source.py', line: 9, column: 3 }
    ];
    process.stdout.write(JSON.stringify(fixture));
} else {
    const fixture = fs.readFileSync(path.join(__dirname, 'plan-graph.json'), 'utf8');
    process.stdout.write(fixture);
}
