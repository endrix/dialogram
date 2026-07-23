// Task 4 (SP2c-2): the editor provider no longer reads `run.wf-viewer.live.json`
// itself — the toolkit's CliRunDriver publishes each watched diagram's overlay
// signature and the provider refreshes on CHANGE. These tests exercise that
// refresh-decision logic through an injected signature source, with no file I/O,
// preserving the old passive poll's exact semantics (absent overlay → undefined,
// first-observation-of-absent is a no-op, any undefined↔defined transition or
// value change triggers exactly one refresh).
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';

// Stub the GLSP base class so the provider can be constructed in a plain Node
// test without loading `@eclipse-glsp/vscode-integration` (its barrel requires
// the real `vscode` module at load time). The base only needs to accept the
// connector and expose `onDidChangeCustomDocument`, exactly as the real one does.
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
type LiveOverlaySignatureSource = import('../src/extension/diagram/diagram-editor-provider').LiveOverlaySignatureSource;

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

function registerClient(provider: WorkflowEditorProvider, uri: vscode.Uri, clientId: string): string {
    const key = (provider as any).canonicalizeUriString(uri) as string;
    (provider as any).uriToClientId.set(key, clientId);
    return key;
}

/** Fake signature source mirroring CliRunDriver semantics: dispose() removes the
 *  listener / decrements the active-watch count, so detach behavior is testable. */
function makeFakeSource() {
    const listeners = new Set<(uri: string, signature: string | undefined) => void>();
    const watched: string[] = [];
    let activeWatches = 0;
    const source: LiveOverlaySignatureSource = {
        watch: (uri) => {
            watched.push(uri.toString());
            activeWatches++;
            return { dispose: () => { activeWatches--; } };
        },
        onSignature: (listener) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        }
    };
    return {
        source,
        watched,
        activeWatches: () => activeWatches,
        emit: (uri: string, signature: string | undefined) => {
            for (const listener of listeners) {
                listener(uri, signature);
            }
        }
    };
}

describe('WorkflowEditorProvider live-overlay signature refresh', () => {
    it('refreshes only on signature change, treating an absent overlay as undefined', () => {
        const { provider, dispatched } = makeProvider();
        const uri = vscode.Uri.file('/tmp/pipeline.py');
        registerClient(provider, uri, 'client-1');

        // First observation of an absent overlay → no refresh.
        provider.onLiveOverlaySignatureUpdate(uri.toString(), undefined);
        expect(dispatched.length).toBe(0);

        // Overlay appears → refresh once, targeting the right client.
        provider.onLiveOverlaySignatureUpdate(uri.toString(), 'r1|1|stage-a||1||123|45');
        expect(dispatched.length).toBe(1);
        expect(dispatched[0].clientId).toBe('client-1');

        // Same signature → no additional refresh.
        provider.onLiveOverlaySignatureUpdate(uri.toString(), 'r1|1|stage-a||1||123|45');
        expect(dispatched.length).toBe(1);

        // Signature changes (fireCount + mtime/size) → refresh.
        provider.onLiveOverlaySignatureUpdate(uri.toString(), 'r1|1|stage-a||2||130|46');
        expect(dispatched.length).toBe(2);

        // Overlay removed (defined → undefined) → refresh.
        provider.onLiveOverlaySignatureUpdate(uri.toString(), undefined);
        expect(dispatched.length).toBe(3);
    });

    it('ignores signatures for URIs with no open diagram client', () => {
        const { provider, dispatched } = makeProvider();
        const uri = vscode.Uri.file('/tmp/pipeline.py');
        registerClient(provider, uri, 'client-1');

        provider.onLiveOverlaySignatureUpdate(vscode.Uri.file('/tmp/other.py').toString(), 'r1|1|a||1||1|1');
        expect(dispatched.length).toBe(0);
    });

    it('attaching a source watches already-open diagrams and refreshes on emitted change; detaching stops both', () => {
        const { provider, dispatched } = makeProvider();
        const uri = vscode.Uri.file('/tmp/pipeline.py');
        registerClient(provider, uri, 'client-1');

        const fake = makeFakeSource();
        provider.setLiveOverlaySignatureSource(fake.source);

        // The already-open diagram is now being watched.
        expect(fake.watched.length).toBe(1);
        expect(fake.activeWatches()).toBe(1);

        // An emitted signature drives a refresh through the provider.
        fake.emit(uri.toString(), 's1');
        expect(dispatched.length).toBe(1);

        // Detaching disposes the watch and unsubscribes: no further refreshes.
        provider.setLiveOverlaySignatureSource(undefined);
        expect(fake.activeWatches()).toBe(0);
        fake.emit(uri.toString(), 's2');
        expect(dispatched.length).toBe(1);
    });

    it('never feeds the signature map when no source is attached (no run driver)', () => {
        const { provider, dispatched } = makeProvider();
        const uri = vscode.Uri.file('/tmp/pipeline.py');
        registerClient(provider, uri, 'client-1');

        // Without a source, nothing calls onLiveOverlaySignatureUpdate, so the
        // diagram never glows — matching today's absent-overlay-file path. Assert
        // the provider is inert: no dispatch happened during construction/wiring.
        expect(dispatched.length).toBe(0);
    });
});
