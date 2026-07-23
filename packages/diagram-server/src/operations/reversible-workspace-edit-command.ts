import { Command } from '@eclipse-glsp/server';
import * as vscode from 'vscode';

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

export class ReversibleWorkspaceEditCommand implements Command {
    private beforeText: string | undefined;
    private afterText: string | undefined;

    constructor(private readonly options: ReversibleWorkspaceEditCommandOptions) {}

    async execute(): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        this.beforeText = doc.getText();

        const edits = await this.options.computeEdits();
        if (!edits || edits.length === 0) {
            // Nothing to do; do not create an undo entry.
            this.beforeText = undefined;
            this.afterText = undefined;
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
        if (overrideBefore && overrideAfter) {
            this.beforeText = overrideBefore;
            this.afterText = overrideAfter;
        }

        await this.options.afterApply?.();
    }

    async undo(): Promise<void> {
        if (this.beforeText === undefined || this.afterText === undefined) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        const currentText = doc.getText();
        if (currentText !== this.afterText) {
            void vscode.window.showWarningMessage(
                `Cannot undo '${this.options.label}' because the document changed outside the diagram.`
            );
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(this.options.uri, [new vscode.TextEdit(fullDocumentRange(doc), this.beforeText)]);
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (applied) {
            await this.options.afterApply?.();
        }
    }

    async redo(): Promise<void> {
        if (this.beforeText === undefined || this.afterText === undefined) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(this.options.uri);
        const currentText = doc.getText();
        if (currentText !== this.beforeText) {
            void vscode.window.showWarningMessage(
                `Cannot redo '${this.options.label}' because the document changed outside the diagram.`
            );
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(this.options.uri, [new vscode.TextEdit(fullDocumentRange(doc), this.afterText)]);
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (applied) {
            await this.options.afterApply?.();
        }
    }

    canUndo(): boolean {
        return this.beforeText !== undefined && this.afterText !== undefined;
    }
}
