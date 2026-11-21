import * as vscode from 'vscode';
import type { CommandThatMayChangeNothing, CommandThatMayRefuse } from '../server/command-stack';
import type { ApplyPhase } from './reversible-workspace-edit-command';
import type { CommandThatWritesOutOfBand, OutOfBandWrite } from '../server/out-of-band-writes';
import { fileTheCopyLags, forTheEditor, messageOf, sameText, writeOnDisk } from './file-on-disk';

/**
 * The edits a command applies, by file; nothing (or an empty list) when there
 * is nothing to write: refused, cancelled, nothing to do. A command given
 * nothing changed nothing and leaves no entry on the undo stack: return
 * nothing only when nothing has been written.
 */
export type ComputeMultiTextEdits = () => Promise<Array<{ uri: vscode.Uri; edits: vscode.TextEdit[] }> | undefined>;

export interface ReversibleMultiWorkspaceEditCommandOptions {
    label: string;
    computeEdits: ComputeMultiTextEdits;
    /** Optional hook invoked after a successful execute/undo/redo. */
    afterApply?: (phase: ApplyPhase) => void | Promise<void>;
    /**
     * Snapshots for an op that wrote the files ITSELF, consulted after the
     * (then no-op) edit is applied.
     *
     * An op that rewrites source out of band leaves nothing for `applyEdit` to
     * do and nothing for it to observe: the before text is gone by the time
     * this command runs, and the after text has to be read from disk rather
     * than from a document VS Code reconciles asynchronously. The single-URI
     * command solves this with `_sourceBeforeText`/`_sourceAfterText`; this is
     * the same idea for several files at once, typed rather than stashed on
     * the instance.
     *
     * Returning `undefined` (or an empty list) leaves the computed snapshots in
     * place, so an ordinary edit is unaffected.
     */
    outOfBandSnapshots?: () => Array<{ uri: vscode.Uri; beforeText: string; afterText: string }> | undefined;
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
    if (doc.lineCount <= 0) {
        return new vscode.Range(0, 0, 0, 0);
    }
    const lastLine = doc.lineCount - 1;
    const lastText = doc.lineAt(lastLine).text;
    return new vscode.Range(0, 0, lastLine, lastText.length);
}

function sortEditsDescending(edits: vscode.TextEdit[]): vscode.TextEdit[] {
    return [...edits].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
            return b.range.start.line - a.range.start.line;
        }
        return b.range.start.character - a.range.start.character;
    });
}

type Snapshot = {
    uri: vscode.Uri;
    beforeText: string;
    afterText: string;
};

export class ReversibleMultiWorkspaceEditCommand implements CommandThatMayChangeNothing, CommandThatMayRefuse, CommandThatWritesOutOfBand {
    private snapshots: Snapshot[] | undefined;
    private unchanged = false;
    private refusedLast = false;
    /** The files the last execute had its producer write, as it left them. */
    private writtenOutOfBand: OutOfBandWrite[] = [];

    constructor(private readonly options: ReversibleMultiWorkspaceEditCommandOptions) {}

    async execute(): Promise<void> {
        this.unchanged = false;
        const plan = await this.options.computeEdits();
        // The files the producer changed, read back where it wrote them: on
        // disk whatever becomes of the edits below, files named with none
        // and edits VS Code refuses included. What the host is told to
        // reload from (see out-of-band-writes.ts).
        this.writtenOutOfBand = (this.options.outOfBandSnapshots?.() ?? [])
            .filter(s => s.beforeText !== s.afterText)
            .map(s => ({ uri: s.uri.toString(), text: s.afterText }));
        if (!plan || plan.length === 0) {
            this.snapshots = undefined;
            this.unchanged = true;
            return;
        }
        if (plan.every(p => !p.edits || p.edits.length === 0)) {
            // Files named with no edit for them: what an op that wrote them
            // itself returns, as well as one that wrote nothing. Which is not
            // known, so it is not counted as nothing.
            this.snapshots = undefined;
            return;
        }

        // De-dupe URIs and merge edits.
        const byUri = new Map<string, { uri: vscode.Uri; edits: vscode.TextEdit[] }>();
        for (const p of plan) {
            if (!p.edits || p.edits.length === 0) continue;
            const key = p.uri.toString();
            const existing = byUri.get(key);
            if (existing) {
                existing.edits.push(...p.edits);
            } else {
                byUri.set(key, { uri: p.uri, edits: [...p.edits] });
            }
        }

        const entries = [...byUri.values()];
        if (entries.length === 0) {
            this.snapshots = undefined;
            return;
        }

        // Capture before snapshots.
        const beforeSnapshots: Array<{ uri: vscode.Uri; beforeText: string }> = [];
        for (const e of entries) {
            const doc = await vscode.workspace.openTextDocument(e.uri);
            beforeSnapshots.push({ uri: e.uri, beforeText: doc.getText() });
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const e of entries) {
            const sorted = sortEditsDescending(e.edits);
            workspaceEdit.set(e.uri, sorted);
        }

        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (!applied) {
            this.snapshots = undefined;
            return;
        }

        const snapshots: Snapshot[] = [];
        for (const s of beforeSnapshots) {
            const afterDoc = await vscode.workspace.openTextDocument(s.uri);
            snapshots.push({ uri: s.uri, beforeText: s.beforeText, afterText: afterDoc.getText() });
        }

        const override = this.options.outOfBandSnapshots?.();
        this.snapshots = override && override.length > 0 ? override : snapshots;
        // The files as they were written, read where they were written: the
        // same text before and after in each is an op that wrote nothing,
        // when they are every file it edited. A file edited here that they
        // do not name may have changed, so the command is kept.
        const named = new Set((override ?? []).map(s => s.uri.toString()));
        this.unchanged = !!override && override.length > 0
            && override.every(s => s.beforeText === s.afterText)
            && entries.every(e => named.has(e.uri.toString()));
        await this.options.afterApply?.('execute');
    }

    /**
     * The files the last execute had its producer write, as they were read
     * back, or the last undo or redo wrote on disk; none for edits applied
     * in the editor.
     */
    outOfBandWrites(): readonly OutOfBandWrite[] {
        return this.writtenOutOfBand;
    }

    async undo(): Promise<void> {
        await this.putBack('undo');
    }

    async redo(): Promise<void> {
        await this.putBack('redo');
    }

    /**
     * Undo (or redo) the edit in every file: each, as the edit left (found)
     * it, given the text it found (left). A file is the editor's copy, given
     * the text and saved; or, where that copy lags the file on disk (a write
     * made out of band that no file watcher reported, see file-on-disk.ts),
     * the file on disk, written there and told to the host as a write out of
     * band. One file as neither refuses the whole, with a word to the user.
     */
    private async putBack(phase: 'undo' | 'redo'): Promise<void> {
        this.refusedLast = false;
        this.writtenOutOfBand = [];
        if (!this.snapshots || this.snapshots.length === 0) {
            return;
        }

        const files: Array<{ uri: vscode.Uri; doc: vscode.TextDocument; to: string; lags: boolean }> = [];
        for (const s of this.snapshots) {
            const [from, to] = phase === 'undo' ? [s.afterText, s.beforeText] : [s.beforeText, s.afterText];
            const doc = await vscode.workspace.openTextDocument(s.uri);
            const onDisk = await fileTheCopyLags(s.uri, doc);
            if (!sameText(onDisk ?? doc.getText(), from)) {
                this.refusedLast = true;
                void vscode.window.showWarningMessage(
                    `Cannot ${phase} '${this.options.label}' because a document changed outside the diagram.`
                );
                return;
            }
            files.push({ uri: s.uri, doc, to, lags: onDisk !== undefined });
        }

        // The copies first, in one edit VS Code may refuse whole; then saved,
        // the diagram being read from disk, and its save reloading it.
        const inTheEditor = files.filter(file => !file.lags);
        if (inTheEditor.length > 0) {
            const workspaceEdit = new vscode.WorkspaceEdit();
            for (const file of inTheEditor) {
                workspaceEdit.set(file.uri, [new vscode.TextEdit(fullDocumentRange(file.doc), forTheEditor(file.to))]);
            }
            if (!await vscode.workspace.applyEdit(workspaceEdit)) {
                this.refusedLast = true;
                return;
            }
            for (const file of inTheEditor) {
                if (file.doc.isDirty) {
                    await file.doc.save();
                }
            }
        }

        const notWritten: string[] = [];
        for (const file of files.filter(each => each.lags)) {
            try {
                await writeOnDisk(file.uri, file.to);
                this.writtenOutOfBand.push({ uri: file.uri.toString(), text: file.to });
            } catch (error) {
                notWritten.push(`${file.uri.fsPath} (${messageOf(error)})`);
            }
        }
        if (notWritten.length > 0) {
            void vscode.window.showWarningMessage(
                `Cannot ${phase} '${this.options.label}' whole: ${notWritten.join(', ')} could not be written.`
            );
            if (inTheEditor.length === 0 && this.writtenOutOfBand.length === 0) {
                this.refusedLast = true;
                return;
            }
        }
        await this.options.afterApply?.(phase);
    }

    canUndo(): boolean {
        return !!this.snapshots && this.snapshots.length > 0;
    }

    /**
     * Whether the last execute changed nothing: no file to edit, or the
     * snapshots its handler took after writing (`outOfBandSnapshots`) have
     * the text before in every file. Files named with no edit, and an edit
     * VS Code refused to apply, are not counted: what was written out of
     * band is not known.
     */
    changedNothing(): boolean {
        return this.unchanged;
    }

    /** Whether the last undo or redo did nothing: a document had changed outside the diagram (it said so), or the edit or every write was refused. */
    refused(): boolean {
        return this.refusedLast;
    }
}
