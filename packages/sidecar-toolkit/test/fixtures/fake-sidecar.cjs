#!/usr/bin/env node
// Fake calpy/wfpy sidecar: speaks the NDJSON request/response protocol used by
// WorkflowSourceModelStorage#tryLoadGraphFromSidecar. Reads exactly one request line from
// stdin, logs it (one JSON object per line) to FAKE_SIDECAR_LOG, then replies with the
// `{status:'ok', diagnostic:{graph}}` envelope tryLoadGraphFromSidecar/graphPayloadToDoc
// actually consume: `diagnostic.graph` is the *raw* export-op payload shape (flat node/edge
// list, `edge.from`/`edge.to` as `{portId}` objects) -- NOT the `{version, graph:{...}}` doc
// shape that the CLI `plan` path emits directly. Derived from plan-graph.json so both fake
// processes share one fixture.
//
// Set FAKE_SIDECAR_FAIL=1 to simulate a sidecar that fails after receiving the request: it
// still logs the request (so the "no CLI fallback" pin can inspect it) but exits non-zero
// without ever writing to stdout, matching tryLoadGraphFromSidecar's
// `exitCode !== 0 || stdout.trim() === ''` failure branch.
//
// Set FAKE_SIDECAR_DIAGNOSTICS=1 to reply with a raw export payload carrying: a node with a
// top-level `location {file,line,column}` (the pre-`graphPayloadToDoc` shape -- location moves
// under `node.meta.source` only after that transform) and a `metadata.diagnostics` entry, plus a
// nested `children[]` child-graph carrying its own node diagnostic. Used by
// diagnostics-parity.test.ts to pin that `publishGraphDiagnostics` walks the raw payload (node
// location + nested child graphs), not the transformed doc.
const fs = require('node:fs');
const path = require('node:path');

let buf = '';
process.stdin.on('data', d => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) {
        return;
    }
    const request = JSON.parse(buf.slice(0, nl));

    const logFile = process.env.FAKE_SIDECAR_LOG;
    if (logFile) {
        fs.appendFileSync(logFile, `${JSON.stringify(request)}\n`);
    }

    if (process.env.FAKE_SIDECAR_FAIL === '1') {
        process.exit(3);
    }

    if (process.env.FAKE_SIDECAR_DIAGNOSTICS === '1') {
        const nodeDiagnosticsPayload = {
            network: 'char_fixture_diagnostics',
            nodes: [
                {
                    id: 'n1',
                    kind: 'actor',
                    label: 'n1',
                    scope: 'scope:root',
                    ports: [],
                    location: { file: process.env.FAKE_SIDECAR_DIAGNOSTICS_NODE_FILE || '/tmp/node-source.py', line: 42, column: 7 },
                    metadata: {
                        diagnostics: [
                            { message: 'node-level diagnostic', severity: 'warning' }
                        ]
                    }
                }
            ],
            edges: [],
            scopes: [],
            children: [
                {
                    instance: 'childInstance',
                    graph: {
                        nodes: [
                            {
                                id: 'c1',
                                kind: 'actor',
                                label: 'c1',
                                scope: 'scope:root',
                                ports: [],
                                metadata: {
                                    diagnostics: [
                                        { message: 'nested child-graph diagnostic', severity: 'error' }
                                    ]
                                }
                            }
                        ],
                        edges: [],
                        scopes: []
                    }
                }
            ]
        };
        process.stdout.write(`${JSON.stringify({ status: 'ok', diagnostic: { graph: nodeDiagnosticsPayload, partial: false, errors: [] } })}\n`);
        process.exit(0);
    }

    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-graph.json'), 'utf8'));
    const graph = doc.graph;
    const rawPayload = {
        network: (graph.meta && graph.meta.workflow) || 'char_fixture',
        nodes: graph.nodes.map(n => ({ id: n.id, kind: n.kind, label: n.label, scope: n.scope, ports: n.ports })),
        edges: graph.edges.map(e => ({
            id: e.id,
            from: { portId: e.from },
            to: { portId: e.to },
            scope: e.scope
        })),
        scopes: graph.subgraphs || []
    };

    process.stdout.write(`${JSON.stringify({ status: 'ok', diagnostic: { graph: rawPayload, partial: false, errors: [] } })}\n`);
    process.exit(0);
});
