// External on-disk .py watcher reload policy. The provider watches `**/*.py` and,
// on a change, force-reloads every open diagram because a changed module can be a
// cross-file import of an open workflow. That broad reload must NOT fire for build
// artifacts: in the streamblocks-mlir workspace, CMakeTools regenerated
// `build/test/lit.site.cfg.py` on every configure, force-reloading the open calpy
// diagram 4+ times in seconds (1-2.3s wfpy CLI spawn each). These tests pin the
// fix: artifact-dir changes are ignored, own-source / real sibling changes still
// reload, and a burst collapses into a single reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function makeProvider() {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => {
            dispatched.push({ action, clientId });
        }
    } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider = new WorkflowEditorProvider(context, connector, {} as unknown as DiagramProfile);
    return { provider, dispatched };
}

function registerClient(provider: WorkflowEditorProvider, uri: vscode.Uri, clientId: string): void {
    const key = (provider as any).canonicalizeUriString(uri) as string;
    (provider as any).uriToClientId.set(key, clientId);
}

const SOURCE = vscode.Uri.file('/repo/examples/python/mpeg4sp/decoder.py');

describe('WorkflowEditorProvider external .py watcher reload policy', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it('(a) ignores changes under a build artifact dir (CMake lit.site.cfg.py incident)', () => {
        const { provider, dispatched } = makeProvider();
        registerClient(provider, SOURCE, 'cal-network-diagram_0');

        provider.handleExternalFileChange(vscode.Uri.file('/repo/build/test/lit.site.cfg.py'));
        vi.runAllTimers();

        expect(dispatched.length).toBe(0);
    });

    it('(a2) ignores changes under other irrelevant dirs (node_modules, __pycache__, .venv, dist, out, wf-out)', () => {
        const { provider, dispatched } = makeProvider();
        registerClient(provider, SOURCE, 'cal-network-diagram_0');

        for (const p of [
            '/repo/node_modules/foo/bar.py',
            '/repo/examples/__pycache__/decoder.cpython-311.py',
            '/repo/.venv/lib/site.py',
            '/repo/dist/gen.py',
            '/repo/out/gen.py',
            '/repo/wf-out/run.py'
        ]) {
            provider.handleExternalFileChange(vscode.Uri.file(p));
        }
        vi.runAllTimers();

        expect(dispatched.length).toBe(0);
    });

    it('(b) reloads when the changed file IS the diagram own source', () => {
        const { provider, dispatched } = makeProvider();
        registerClient(provider, SOURCE, 'cal-network-diagram_0');

        provider.handleExternalFileChange(SOURCE);
        vi.runAllTimers();

        expect(dispatched.length).toBe(1);
        expect(dispatched[0].clientId).toBe('cal-network-diagram_0');
        expect(dispatched[0].action.options.forceReloadFromDisk).toBe(true);
    });

    it('(b2) still reloads for a real sibling/import change (dependency-edit path preserved)', () => {
        const { provider, dispatched } = makeProvider();
        registerClient(provider, SOURCE, 'cal-network-diagram_0');

        provider.handleExternalFileChange(vscode.Uri.file('/repo/examples/python/mpeg4sp/helper.py'));
        vi.runAllTimers();

        expect(dispatched.length).toBe(1);
    });

    it('(c) coalesces a burst of changes into a single reload', () => {
        const { provider, dispatched } = makeProvider();
        registerClient(provider, SOURCE, 'cal-network-diagram_0');

        // Five rapid non-artifact changes within the debounce window.
        for (let i = 0; i < 5; i++) {
            provider.handleExternalFileChange(vscode.Uri.file('/repo/examples/python/mpeg4sp/helper.py'));
        }
        vi.runAllTimers();

        expect(dispatched.length).toBe(1);
    });
});
