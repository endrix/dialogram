import * as vscode from 'vscode';
import type { CommandThatMayChangeNothing, CommandThatMayRefuse } from '../server/command-stack';
import type { CommandThatWritesOutOfBand, OutOfBandWrite } from '../server/out-of-band-writes';
import { fileTheCopyLags, forTheEditor, messageOf, sameText, textOnDisk, writeOnDisk } from './file-on-disk';

/**
 * The edits a command applies; nothing (or no edit) when there is nothing to
 * write: refused, cancelled, nothing to do. A command given nothing changed
 * nothing and leaves no entry on the undo stack: return nothing only when
 * nothing has been written.
 */
export type ComputeTextEdits = () => Promise<vscode.TextEdit[] | undefined>;

/** When an `afterApply` hook runs: after the edit is made, undone, or redone. */
export type ApplyPhase = 'execute' | 'undo' | 'redo';

export interface ReversibleWorkspaceEditCommandOptions {
    label: string;
    uri: vscode.Uri;
    computeEdits: ComputeTextEdits;
    /** Optional hook invoked after a successful execute/undo/redo, told which. */
    afterApply?: (phase: ApplyPhase) => void | Promise<void>;
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

export class ReversibleWorkspaceEditCommand implements CommandThatMayChangeNothing, CommandThatMayRefuse, CommandThatWritesOutOfBand {
    private beforeText: string | undefined;
    private afterText: string | undefined;
    private unchanged = false;
    private refusedLast = false;
    /** The file as its producer left it, when the last execute had it written out of band. */
    private writtenOutOfBand: OutOfBandWrite | undefined;

    constructor(private readonly options: ReversibleWorkspaceEditCommandOptions) {}

    async execute(): Promise<void> {
        this.unchanged = false;
        this.writtenOutOfBand = undefined;
        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        this.beforeText = doc.getText();
        const fileBefore = await textOnDisk(this.options.uri);

        const edits = await this.options.computeEdits();
        // What the producer wrote is on disk whatever becomes of the edit
        // below: the host is told of it even when VS Code refuses that.
        this.writtenOutOfBand = this.producerWrite(fileBefore);
        if (!edits || edits.length === 0) {
            // Nothing to do; do not create an undo entry.
            this.beforeText = undefined;
            this.afterText = undefined;
            this.unchanged = true;
            return;
        }

        const sortedEdits = sortEditsDescending(edits);

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(this.options.uri, sortedEdits);

        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (!applied) {
            this.beforeText = undefined;
            this.afterText = undefined;
            return;
        }

        const afterDoc = await vscode.workspace.openTextDocument(this.options.uri);
        this.afterText = afterDoc.getText();
        const overrideAfter = (this as any)._sourceAfterText as string | undefined;
        // What undo puts back is the file as it was on disk before the
        // write, read here before the handler ran; the handler's own text
        // before (`_sourceBeforeText`) only where the file cannot be read
        // here. That is often the editor's, which after an earlier write
        // made out of band may not have caught up, and undo would then take
        // that earlier edit back too. A handler that asks before it writes
        // says what the file was when it began writing (`_fileBeforeWrite`):
        // what was saved while a question was open is not the edit's to undo.
        const overrideBefore = (this as any)._fileBeforeWrite as string | undefined
            ?? fileBefore ?? (this as any)._sourceBeforeText as string | undefined;
        if (overrideBefore !== undefined && overrideAfter !== undefined) {
            this.beforeText = overrideBefore;
            this.afterText = overrideAfter;
            // The file as it was written, read where it was written, before
            // the edit and after: the same text is an edit that wrote
            // nothing, and its undo would put back what is there. Its text
            // before is read here, on disk, where the handler's text after
            // is read: the handler's own may be the editor's, which lags
            // what was last written out of band.
            this.unchanged = overrideBefore === overrideAfter;
        }

        await this.options.afterApply?.('execute');
    }

    async undo(): Promise<void> {
        await this.putBack('undo');
    }

    async redo(): Promise<void> {
        await this.putBack('redo');
    }

    /**
     * Undo (or redo) the edit: the file, as the edit left (found) it, given
     * the text it found (left). The file is the editor's copy, given the text
     * and saved; or, where that copy lags the file on disk (a write made out
     * of band that no file watcher reported, see file-on-disk.ts), the file
     * on disk, written there and told to the host as a write out of band.
     * The file as neither is refused, with a word to the user.
     */
    private async putBack(phase: 'undo' | 'redo'): Promise<void> {
        this.refusedLast = false;
        this.writtenOutOfBand = undefined;
        if (this.beforeText === undefined || this.afterText === undefined) {
            return;
        }
        const [from, to] = phase === 'undo' ? [this.afterText, this.beforeText] : [this.beforeText, this.afterText];
        const uri = this.options.uri;

        const doc = await vscode.workspace.openTextDocument(uri);
        const onDisk = await fileTheCopyLags(uri, doc);
        if (!sameText(onDisk ?? doc.getText(), from)) {
            this.refusedLast = true;
            void vscode.window.showWarningMessage(
                `Cannot ${phase} '${this.options.label}' because the document changed outside the diagram.`
            );
            return;
        }

        if (onDisk !== undefined) {
            try {
                await writeOnDisk(uri, to);
            } catch (error) {
                this.refusedLast = true;
                void vscode.window.showWarningMessage(
                    `Cannot ${phase} '${this.options.label}': ${uri.fsPath} could not be written (${messageOf(error)}).`
                );
                return;
            }
            this.writtenOutOfBand = { uri: uri.toString(), text: to };
        } else {
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.set(uri, [new vscode.TextEdit(fullDocumentRange(doc), forTheEditor(to))]);
            const applied = await vscode.workspace.applyEdit(workspaceEdit);
            if (!applied) {
                this.refusedLast = true;
                return;
            }
            await this.persist(doc);
        }
        await this.options.afterApply?.(phase);
    }

    /**
     * Flush the undo/redo edit to disk.
     *
     * `applyEdit` only mutates the in-memory (dirty) text buffer, but the diagram model is rebuilt
     * FROM DISK. Without persisting, disk still holds the pre-undo content, so the reverted node
     * keeps reappearing on every reload until the user manually saves. Saving lets the normal
     * on-save reload reflect the revert immediately.
     */
    private async persist(doc: vscode.TextDocument): Promise<void> {
        if (doc.isDirty) {
            await doc.save();
        }
    }

    canUndo(): boolean {
        return this.beforeText !== undefined && this.afterText !== undefined;
    }

    /**
     * Whether the last execute changed nothing: no edit to apply, or, for an
     * edit written out of band, the file on disk before it ran is the text
     * its handler read after writing. An edit VS Code refused to apply is
     * not counted: what was written out of band before it is not known; nor
     * is one applied in band, which is kept whatever it did.
     */
    changedNothing(): boolean {
        return this.unchanged;
    }

    /**
     * The file as the handler's producer left it (`_sourceAfterText`, read
     * back where it was written), when it differs from the file before
     * (read as `execute` reads it for undo); none for an edit applied here.
     * What the host is told to reload from (see out-of-band-writes.ts).
     */
    private producerWrite(fileBefore: string | undefined): OutOfBandWrite | undefined {
        const after = (this as any)._sourceAfterText as string | undefined;
        if (after === undefined) {
            return undefined;
        }
        const before = (this as any)._fileBeforeWrite as string | undefined
            ?? fileBefore ?? (this as any)._sourceBeforeText as string | undefined;
        return after === before ? undefined : { uri: this.options.uri.toString(), text: after };
    }

    /**
     * The file the last execute had its producer write, as it was read back,
     * or the last undo or redo wrote on disk; none for an edit applied in
     * the editor.
     */
    outOfBandWrites(): readonly OutOfBandWrite[] {
        return this.writtenOutOfBand ? [this.writtenOutOfBand] : [];
    }

    /** Whether the last undo or redo did nothing: the document had changed outside the diagram (it said so), or the edit or write was refused. */
    refused(): boolean {
        return this.refusedLast;
    }
}
