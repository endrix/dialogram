/**
 * Undo and redo of an edit the producer wrote, where the editor's copy of
 * the file lags it.
 *
 * The producer writes the file on disk; the editor's copy (its TextDocument)
 * catches up only once VS Code's file watcher reports the write, and a dead
 * watcher (a machine out of inotify instances) reports nothing. Undo checked
 * that the copy was as the edit left it, and the lagging copy, still holding
 * the text before, refused it: "the document changed outside the diagram".
 * Where the copy lags, the file is now asked on disk and put back there, and
 * the host is told, as of the producer's write, to reload the diagram.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WorkflowCommandStack, CompoundCommandThatMayChangeNothing } from '../src/server/command-stack';
import type { OutOfBandWrite } from '../src/server/out-of-band-writes';
import { ReversibleWorkspaceEditCommand, type ApplyPhase } from '../src/operations/reversible-workspace-edit-command';
import { ReversibleMultiWorkspaceEditCommand } from '../src/operations/reversible-multi-workspace-edit-command';

let dir: string;
let net: vscode.Uri;
let lib: vscode.Uri;
/** The editor's copies, by file: read from disk when first opened, and then only what the editor is given. */
const copies = new Map<string, string>();
const dirty = new Set<string>();
/** The encoding VS Code names for a copy, where a test has it name one. */
const encodings = new Map<string, string>();
const saves: string[] = [];
const warnings: string[] = [];
const phases: ApplyPhase[] = [];

/** A file on disk, as VS Code names it (the mock's Uri has no scheme or path). */
function fileUri(file: string): vscode.Uri {
    return { scheme: 'file', fsPath: file, toString: () => `file://${file}` } as unknown as vscode.Uri;
}

const pathOf = (uri: vscode.Uri): string => (uri as unknown as { fsPath: string }).fsPath;
const onDisk = (uri: vscode.Uri): string => readFileSync(pathOf(uri), 'utf8');
const copyOf = (uri: vscode.Uri): string | undefined => copies.get(uri.toString());
/** The editor's copy catches up with the file, as a working watcher has it. */
const catchUp = (uri: vscode.Uri, text = onDisk(uri)): void => { copies.set(uri.toString(), text); };

const saved = {
    open: (vscode.workspace as any).openTextDocument,
    apply: (vscode.workspace as any).applyEdit,
    set: (vscode.WorkspaceEdit as any).prototype.set,
    warn: (vscode.window as any).showWarningMessage
};

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-lags-'));
    net = fileUri(path.join(dir, 'net.src'));
    lib = fileUri(path.join(dir, 'lib.src'));
    writeFileSync(pathOf(net), 'A');
    writeFileSync(pathOf(lib), 'L');
    copies.clear();
    dirty.clear();
    encodings.clear();
    saves.length = 0;
    warnings.length = 0;
    phases.length = 0;

    const pending: Array<{ uri: vscode.Uri; edits: vscode.TextEdit[] }> = [];
    (vscode.WorkspaceEdit as any).prototype.set = (uri: vscode.Uri, edits: vscode.TextEdit[]) => { pending.push({ uri, edits }); };
    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
        const key = uri.toString();
        if (!copies.has(key)) {
            copies.set(key, onDisk(uri));
        }
        const text = () => copies.get(key)!;
        return {
            encoding: encodings.get(key),
            getText: text,
            get isDirty() { return dirty.has(key); },
            get lineCount() { return text().split('\n').length; },
            lineAt: (line: number) => ({ text: text().split('\n')[line] ?? '' }),
            save: async () => {
                writeFileSync(pathOf(uri), text());
                dirty.delete(key);
                saves.push(key);
                return true;
            }
        };
    };
    (vscode.workspace as any).applyEdit = async () => {
        for (const { uri, edits } of pending.splice(0)) {
            for (const edit of edits) {
                if (edit.newText === '' && edit.range.end.line === 0 && edit.range.end.character === 0) {
                    continue; // what an edit the producer wrote applies: nothing
                }
                if (copyOf(uri) !== edit.newText) {
                    copies.set(uri.toString(), edit.newText);
                    dirty.add(uri.toString());
                }
            }
        }
        return true;
    };
    (vscode.window as any).showWarningMessage = async (message: string) => { warnings.push(message); };
});

afterEach(() => {
    (vscode.workspace as any).openTextDocument = saved.open;
    (vscode.workspace as any).applyEdit = saved.apply;
    (vscode.WorkspaceEdit as any).prototype.set = saved.set;
    (vscode.window as any).showWarningMessage = saved.warn;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
});

/** The platform's stack, telling `told` what it is told to tell the host. */
function commandStack(told: OutOfBandWrite[][]): WorkflowCommandStack {
    const stack = new WorkflowCommandStack();
    (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
    (stack as any).outOfBandWriteSink = (writes: readonly OutOfBandWrite[]) => { told.push([...writes]); };
    return stack;
}

/** An edit the producer writes itself: the file becomes `to`, read back on disk, as the handlers read it. */
function producerEdit(to: string, uri = net): ReversibleWorkspaceEditCommand {
    const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
        label: 'Connect',
        uri,
        afterApply: phase => { phases.push(phase); },
        computeEdits: async () => {
            (command as any)._sourceBeforeText = onDisk(uri);
            writeFileSync(pathOf(uri), to);
            (command as any)._sourceAfterText = onDisk(uri);
            return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
        }
    });
    return command;
}

/** An edit the producer writes itself into several files, `writes` naming what each becomes. */
function producerEditInFiles(writes: Array<[vscode.Uri, string]>): ReversibleMultiWorkspaceEditCommand {
    let snapshots: Array<{ uri: vscode.Uri; beforeText: string; afterText: string }> = [];
    return new ReversibleMultiWorkspaceEditCommand({
        label: 'Rename port',
        afterApply: phase => { phases.push(phase); },
        outOfBandSnapshots: () => snapshots,
        computeEdits: async () => {
            snapshots = writes.map(([uri, to]) => {
                const beforeText = onDisk(uri);
                writeFileSync(pathOf(uri), to);
                return { uri, beforeText, afterText: onDisk(uri) };
            });
            return writes.map(([uri]) => ({ uri, edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')] }));
        }
    });
}

describe('an edit the producer wrote, undone while the editor\'s copy lags the file', () => {
    it('is undone on disk, and the host told, as of the write, to reload', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(producerEdit('B'));
        expect([onDisk(net), copyOf(net)]).toEqual(['B', 'A']);
        await stack.undo();

        expect(warnings).toEqual([]);
        expect(onDisk(net)).toBe('A');
        expect(saves).toEqual([]);
        expect(told).toEqual([[{ uri: net.toString(), text: 'B' }], [{ uri: net.toString(), text: 'A' }]]);
        expect(phases).toEqual(['execute', 'undo']);
        expect([stack.canUndo(), stack.canRedo()]).toEqual([false, true]);
    });

    it('is redone on disk while the copy still lags', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        catchUp(net, 'older');

        await stack.execute(producerEdit('B'));
        await stack.undo();
        await stack.redo();

        expect(warnings).toEqual([]);
        expect(onDisk(net)).toBe('B');
        expect(told.at(-1)).toEqual([{ uri: net.toString(), text: 'B' }]);
        expect(phases).toEqual(['execute', 'undo', 'redo']);
    });

    it('goes through the editor, and is saved, once the copy has caught up', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);

        await stack.execute(producerEdit('B'));
        catchUp(net);
        await stack.undo();

        expect(warnings).toEqual([]);
        expect([copyOf(net), onDisk(net)]).toEqual(['A', 'A']);
        expect(saves).toEqual([net.toString()]);
        expect(told).toHaveLength(1);
    });

    it('is refused, and kept to undo, when the file on disk is not as the edit left it either', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(producerEdit('B'));
        writeFileSync(pathOf(net), 'changed by someone else');
        await stack.undo();

        expect(warnings).toEqual(["Cannot undo 'Connect' because the document changed outside the diagram."]);
        expect(onDisk(net)).toBe('changed by someone else');
        expect(stack.canUndo()).toBe(true);
        expect(told).toHaveLength(1);
    });

    it('leaves unsaved changes in the copy to the copy: the file is what the user sees', async () => {
        const stack = commandStack([]);
        catchUp(net, 'A, edited');
        dirty.add(net.toString());

        await stack.execute(producerEdit('B'));
        await stack.undo();

        expect(warnings).toEqual(["Cannot undo 'Connect' because the document changed outside the diagram."]);
        expect([copyOf(net), onDisk(net)]).toEqual(['A, edited', 'B']);
    });

    it('is refused, and kept to undo, when the file cannot be written', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(producerEdit('B'));
        vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));
        await stack.undo();

        expect(warnings).toEqual([`Cannot undo 'Connect': ${pathOf(net)} could not be written (EACCES: permission denied).`]);
        expect(onDisk(net)).toBe('B');
        expect(stack.canUndo()).toBe(true);
        expect(told).toHaveLength(1);
        expect(phases).toEqual(['execute']);
    });

    it('is refused when another tool changed the line breaks of the file the edit left', async () => {
        const stack = commandStack([]);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(producerEdit('a\nb'));
        writeFileSync(pathOf(net), 'a\r\nb');
        await stack.undo();

        expect(warnings).toEqual(["Cannot undo 'Connect' because the document changed outside the diagram."]);
        expect(onDisk(net)).toBe('a\r\nb');
    });

    it('keeps a byte order mark on disk, and puts none in the copy', async () => {
        writeFileSync(pathOf(net), '﻿A');
        const stack = commandStack([]);
        catchUp(net, 'A');

        await stack.execute(producerEdit('﻿B'));
        await stack.undo();
        expect(warnings).toEqual([]);
        expect(onDisk(net)).toBe('﻿A');

        await stack.redo();
        catchUp(net, 'B');
        await stack.undo();
        expect(warnings).toEqual([]);
        expect(copyOf(net)).toBe('A');
    });
});

describe('an edit the producer wrote into several files, undone', () => {
    it('puts each back where it stands: on disk where the copy lags, in the editor where it does not', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(producerEditInFiles([[net, 'B'], [lib, 'M']]));
        catchUp(lib);
        await stack.undo();

        expect(warnings).toEqual([]);
        expect([onDisk(net), onDisk(lib), copyOf(lib)]).toEqual(['A', 'L', 'L']);
        expect(saves).toEqual([lib.toString()]);
        expect(told.at(-1)).toEqual([{ uri: net.toString(), text: 'A' }]);
        expect(phases).toEqual(['execute', 'undo']);
    });

    it('is refused whole when one file is not as the edit left it', async () => {
        const stack = commandStack([]);
        await vscode.workspace.openTextDocument(net);
        await vscode.workspace.openTextDocument(lib);

        await stack.execute(producerEditInFiles([[net, 'B'], [lib, 'M']]));
        writeFileSync(pathOf(lib), 'changed by someone else');
        await stack.undo();

        expect(warnings).toEqual(["Cannot undo 'Rename port' because a document changed outside the diagram."]);
        expect([onDisk(net), onDisk(lib)]).toEqual(['B', 'changed by someone else']);
        expect(stack.canUndo()).toBe(true);
    });
});

describe('a compound of edits the producer wrote, undone while the copy lags', () => {
    it('tells the host each file once, as the part undone last left it', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);

        await stack.execute(new CompoundCommandThatMayChangeNothing([producerEdit('B'), producerEdit('C')]));
        await stack.undo();

        expect(warnings).toEqual([]);
        expect(onDisk(net)).toBe('A');
        expect(told.at(-1)).toEqual([{ uri: net.toString(), text: 'A' }]);

        // The copy now holds the file again, by chance: redone in the editor, and saved.
        await stack.redo();
        expect(warnings).toEqual([]);
        expect([copyOf(net), onDisk(net)]).toEqual(['C', 'C']);
        expect(told).toHaveLength(2);
    });
});

describe('a file in another encoding than UTF-8', () => {
    /** An edit made in the editor on a Latin-1 file, saved as Latin-1. */
    async function editedAndSaved(stack: WorkflowCommandStack): Promise<void> {
        writeFileSync(pathOf(net), Buffer.from('caf\u00e9', 'latin1'));
        catchUp(net, 'caf\u00e9');
        await stack.execute(new ReversibleWorkspaceEditCommand({
            label: 'Rename',
            uri: net,
            computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 4), 'caf\u00e9!')]
        }));
        writeFileSync(pathOf(net), Buffer.from('caf\u00e9!', 'latin1'));
        dirty.delete(net.toString());
    }

    it('is undone in the copy, as before, where VS Code names its encoding', async () => {
        const stack = commandStack([]);
        encodings.set(net.toString(), 'windows1252');
        await editedAndSaved(stack);
        await stack.undo();

        expect(warnings).toEqual([]);
        expect(copyOf(net)).toBe('caf\u00e9');
    });

    it('is undone in the copy, as before, where its UTF-8 read shows characters it could not read', async () => {
        const stack = commandStack([]);
        await editedAndSaved(stack);
        await stack.undo();

        expect(warnings).toEqual([]);
        expect(copyOf(net)).toBe('caf\u00e9');
    });
});

describe('an undo of several files that cannot write one', () => {
    it('puts back the files it wrote, does nothing, and says why', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await vscode.workspace.openTextDocument(net);
        await vscode.workspace.openTextDocument(lib);

        await stack.execute(producerEditInFiles([[net, 'B'], [lib, 'M']]));
        const write = fs.promises.writeFile.bind(fs.promises);
        let writes = 0;
        vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (file: any, data: any, options: any) => {
            writes += 1;
            if (writes === 2) {
                throw new Error('EACCES: permission denied');
            }
            return write(file, data, options);
        }) as any);
        await stack.undo();

        expect(warnings).toEqual([`Cannot undo 'Rename port': ${pathOf(lib)} could not be written (EACCES: permission denied).`]);
        expect([onDisk(net), onDisk(lib)]).toEqual(['B', 'M']);
        expect(stack.canUndo()).toBe(true);
        expect(told).toHaveLength(1);
        expect(phases).toEqual(['execute']);
    });
});

describe('a compound whose parts put one file back, one on disk and one in the editor', () => {
    it('tells the host nothing of the write the editor\'s save superseded', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);

        await stack.execute(new CompoundCommandThatMayChangeNothing([producerEdit('B'), producerEdit('C')]));
        catchUp(net, 'B');
        await stack.undo();

        expect(warnings).toEqual([]);
        expect([copyOf(net), onDisk(net)]).toEqual(['A', 'A']);
        expect(saves).toEqual([net.toString()]);
        expect(told).toHaveLength(1);
    });
});
