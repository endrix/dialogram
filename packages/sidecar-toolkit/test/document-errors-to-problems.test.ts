/**
 * A compiler's errors belong in the Problems panel. A graph document carries
 * them at its root, beside `graph`, where the diagnostics walk over the graph
 * never looks: on the CLI path a Python runtime's load errors stay in the
 * overlay (diagnostics-parity.test.ts pins that). `documentErrorsToProblems`
 * is the product's say that its document errors are a compiler's.
 */
import { describe, expect, it } from 'vitest';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const BASE: SidecarRuntimeConfig = {
    settingsNamespace: 'hdl',
    sidecarOperationPrefix: 'sv',
    sidecarCommandSettingKey: 'svSidecarCommand',
    sidecarCommandDefault: 'sv-sidecar',
    cliCommandSettingKey: 'svCommand',
    cliCommandDefault: 'hdl',
    cliPythonModule: undefined,
    operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
    ...NEUTRAL_CREATE_NODE_CONFIG,
    acceptedOperationPrefixes: ['sv'],
    graphAcquisition: 'cli-plan',
    cliGraphArgs: (file: string) => ['plan', file, '--format', 'graph']
};

const DOC = {
    version: '1.1',
    partial: true,
    errors: [
        { message: "unknown module 'vendor_ip'", severity: 'error', file: '/rtl/wrapper.sv', line: 8, column: 3 },
        { message: 'implicit net', severity: 'warning', file: '/rtl/wrapper.sv', line: 9 }
    ],
    graph: { id: 'wf:wrapper', nodes: [], edges: [], subgraphs: [] }
} as any;

describe('documentErrorsToProblems', () => {
    it('leaves a document\'s root errors out of the diagnostics by default', () => {
        const source = new SidecarModelSource(BASE);
        expect(source.attachDiagnostics({ ...DOC }).diagnostics).toEqual([]);
    });

    it('publishes them with file, line, column and severity when the product asks', () => {
        const source = new SidecarModelSource({ ...BASE, documentErrorsToProblems: true });
        expect(source.attachDiagnostics({ ...DOC }).diagnostics).toEqual([
            { severity: 'error', message: "unknown module 'vendor_ip'", uri: '/rtl/wrapper.sv', startLine: 8, startColumn: 3 },
            { severity: 'warning', message: 'implicit net', uri: '/rtl/wrapper.sv', startLine: 9 }
        ]);
    });

    it('does not double up errors that already came through a raw payload', () => {
        const source = new SidecarModelSource({ ...BASE, documentErrorsToProblems: true });
        const raw = { nodes: [], edges: [], errors: DOC.errors };
        expect(source.attachDiagnostics({ ...DOC }, raw).diagnostics).toHaveLength(2);
    });
});
