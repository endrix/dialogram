import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { CommandThatMayChangeNothing, CommandThatMayRefuse } from '../server/command-stack';

/**
 * The edits a command applies; nothing (or no edit) when there is nothing to
 * write: refused, cancelled, nothing to do. A command given nothing changed
 * nothing and leaves no entry on the undo stack: return nothing only when
 * nothing has been written.
 */
export type ComputeTextEdits = () => Promise<vscode.TextEdit[] | undefined>;

export interface ReversibleWorkspaceEditCommandOptions {
    label: string;
    uri: vscode.Uri;
    computeEdits: ComputeTextEdits;
    /** Optional hook invoked after a successful execute/undo/redo. */
    afterApply?: () => void | Promise<void>;
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

export class ReversibleWorkspaceEditCommand implements CommandThatMayChangeNothing, CommandThatMayRefuse {
    private beforeText: string | undefined;
    private afterText: string | undefined;
    private unchanged = false;
    private refusedLast = false;

    constructor(private readonly options: ReversibleWorkspaceEditCommandOptions) {}

    async execute(): Promise<void> {
        this.unchanged = false;
        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        this.beforeText = doc.getText();
        const fileBefore = await textOnDisk(this.options.uri);

        const edits = await this.options.computeEdits();
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
        const overrideBefore = (this as any)._sourceBeforeText as string | undefined;
        const overrideAfter = (this as any)._sourceAfterText as string | undefined;
        if (overrideBefore !== undefined && overrideAfter !== undefined) {
            // What undo puts back is the file as it was on disk before the
            // write, read here before the handler ran: the handler's own
            // text before may be the editor's, which after an earlier write
            // made out of band may not have caught up, and undo would then
            // take that earlier edit back too.
            this.beforeText = fileBefore ?? overrideBefore;
            this.afterText = overrideAfter;
            // The file as it was written, read where it was written, before
            // the edit and after: the same text is an edit that wrote
            // nothing, and its undo would put back what is there. Its text
            // before is read here, on disk, where the handler's text after
            // is read: the handler's own may be the editor's, which lags
            // what was last written out of band.
            this.unchanged = (fileBefore ?? overrideBefore) === overrideAfter;
        }

        await this.options.afterApply?.();
    }

    async undo(): Promise<void> {
        this.refusedLast = false;
        if (this.beforeText === undefined || this.afterText === undefined) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        const currentText = doc.getText();
        if (currentText !== this.afterText) {
            this.refusedLast = true;
            void vscode.window.showWarningMessage(
                `Cannot undo '${this.options.label}' because the document changed outside the diagram.`
            );
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(this.options.uri, [new vscode.TextEdit(fullDocumentRange(doc), this.beforeText)]);
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        this.refusedLast = !applied;
        if (applied) {
            await this.persist(doc);
            await this.options.afterApply?.();
        }
    }

    async redo(): Promise<void> {
        this.refusedLast = false;
        if (this.beforeText === undefined || this.afterText === undefined) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        const currentText = doc.getText();
        if (currentText !== this.beforeText) {
            this.refusedLast = true;
            void vscode.window.showWarningMessage(
                `Cannot redo '${this.options.label}' because the document changed outside the diagram.`
            );
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(this.options.uri, [new vscode.TextEdit(fullDocumentRange(doc), this.afterText)]);
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        this.refusedLast = !applied;
        if (applied) {
            await this.persist(doc);
            await this.options.afterApply?.();
        }
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

    /** Whether the last undo or redo did nothing: the document had changed outside the diagram (it said so), or VS Code refused the edit. */
    refused(): boolean {
        return this.refusedLast;
    }
}

/** The text of the file `uri` names, on disk; nothing when it is not a file that can be read. */
async function textOnDisk(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') {
        return undefined;
    }
    try {
        return await fs.readFile(uri.fsPath, 'utf8');
    } catch {
        return undefined;
    }
}
