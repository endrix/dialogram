// A file an edit's producer wrote itself reloads its diagram without the file
// watcher. The producer writes on disk and the editor applies nothing; the
// diagram was reloaded only when the watcher reported the write, and a
// watcher can report nothing (a machine out of inotify instances). The
// command stack now tells the host what was written, and the host reloads
// at once; the watcher's report of the same write, when it comes, reloads
// nothing more.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DiagramProfile } from '../src/api';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        constructor(protected readonly glspVscodeConnector: any) {}
        get onDidChangeCustomDocument(): unknown {
            return this.glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');
type WorkflowEditorProvider = InstanceType<typeof WorkflowEditorProvider>;

function makeProvider(profile: Partial<DiagramProfile> = {}) {
    const dispatched: Array<{ action: any; clientId: string }> = [];
    const connector = {
        onDidChangeCustomDocument: undefined,
        dispatchAction: (action: any, clientId: string) => {
            dispatched.push({ action, clientId });
        }
    } as any;
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    const provider = new WorkflowEditorProvider(context, connector, profile as unknown as DiagramProfile);
    return { provider, dispatched };
}

/** The reloads from disk among what was dispatched, by client. */
const reloads = (dispatched: Array<{ action: any; clientId: string }>): string[] =>
    dispatched.filter(d => d.action.options?.forceReloadFromDisk === true).map(d => d.clientId);

/** Let the file reads of the watcher's check settle, then the wait run out. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

let dir: string;
let source: vscode.Uri;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'oob-writes-'));
    const file = path.join(dir, 'spec.md');
    writeFileSync(file, 'before\n');
    source = vscode.Uri.file(file);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
    vi.useRealTimers();
    (vscode.workspace as any).textDocuments = [];
    rmSync(dir, { recursive: true, force: true });
});

/** The producer writes `text` to the source, and the command stack tells the host. */
function producerWrites(provider: WorkflowEditorProvider, text: string): void {
    writeFileSync(source.fsPath, text);
    provider.reloadAfterOutOfBandWrites([{ uri: source.toString(), text }]);
}

describe('a file an edit\'s producer wrote', () => {
    it('reloads its diagram from disk, with no word from the watcher', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');

        producerWrites(provider, 'after\n');
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1']);
    });

    it('is not reloaded again when the watcher reports the same write', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');

        producerWrites(provider, 'after\n');
        await settle();
        provider.handleExternalFileChange(source);
        provider.handleExternalFileChange(source);
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1']);
    });

    it('is reloaded once when the watcher reports the write before the host is told', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');

        writeFileSync(source.fsPath, 'after\n');
        provider.handleExternalFileChange(source);
        provider.reloadAfterOutOfBandWrites([{ uri: source.toString(), text: 'after\n' }]);
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1']);
    });

    it('is reloaded again when it has changed since the write', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');

        producerWrites(provider, 'after\n');
        await settle();
        writeFileSync(source.fsPath, 'changed by someone else\n');
        provider.handleExternalFileChange(source);
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1', 'client-1']);
    });

    it('is reloaded again for a report that comes long after the write', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');

        producerWrites(provider, 'after\n');
        await settle();
        vi.setSystemTime(Date.now() + 10_000);
        provider.handleExternalFileChange(source);
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1', 'client-1']);
    });

    it('reloads even just after a save of the file, which the watcher\'s report would not', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');
        (provider as any).lastSavedAt.set((provider as any).canonicalizeUriString(source), Date.now());

        producerWrites(provider, 'after\n');
        await settle();

        expect(reloads(dispatched)).toEqual(['client-1']);
    });

    it('is left to the live preview while it is open with unsaved changes, as the watcher leaves it', async () => {
        const { provider, dispatched } = makeProvider();
        (provider as any).trackEditor(source, 'client-1');
        (vscode.workspace as any).textDocuments = [{ uri: source, isDirty: true }];

        producerWrites(provider, 'after\n');
        await settle();

        expect(reloads(dispatched)).toEqual([]);
    });

    it('reloads every diagram it affects, each once, in one burst with the others written', async () => {
        const { provider, dispatched } = makeProvider();
        const lib = vscode.Uri.file(path.join(dir, 'lib.md'));
        writeFileSync(lib.fsPath, 'lib\n');
        (provider as any).trackEditor(source, 'client-1');
        (provider as any).trackEditor(lib, 'client-2');

        writeFileSync(source.fsPath, 'after\n');
        writeFileSync(lib.fsPath, 'lib after\n');
        provider.reloadAfterOutOfBandWrites([{ uri: source.toString(), text: 'after\n' }, { uri: lib.toString(), text: 'lib after\n' }]);
        await settle();

        expect(reloads(dispatched).sort()).toEqual(['client-1', 'client-2']);
    });

    it('reloads nothing with no diagram open, or for a file that is not a source', async () => {
        const { provider, dispatched } = makeProvider({ sourceExtensions: ['.md'] } as Partial<DiagramProfile>);
        producerWrites(provider, 'after\n');
        await settle();
        expect(dispatched).toEqual([]);

        (provider as any).trackEditor(source, 'client-1');
        const side = vscode.Uri.file(path.join(dir, 'notes.txt'));
        writeFileSync(side.fsPath, 'notes\n');
        provider.reloadAfterOutOfBandWrites([{ uri: side.toString(), text: 'notes\n' }]);
        await settle();
        expect(dispatched).toEqual([]);
    });
});
