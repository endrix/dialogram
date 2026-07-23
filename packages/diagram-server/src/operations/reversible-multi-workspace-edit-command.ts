import { Command } from '@eclipse-glsp/server';
import * as vscode from 'vscode';

export type ComputeMultiTextEdits = () => Promise<Array<{ uri: vscode.Uri; edits: vscode.TextEdit[] }> | undefined>;

export interface ReversibleMultiWorkspaceEditCommandOptions {
    label: string;
    computeEdits: ComputeMultiTextEdits;
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

type Snapshot = {
    uri: vscode.Uri;
    beforeText: string;
    afterText: string;
};

export class ReversibleMultiWorkspaceEditCommand implements Command {
    private snapshots: Snapshot[] | undefined;

    constructor(private readonly options: ReversibleMultiWorkspaceEditCommandOptions) {}

    async execute(): Promise<void> {
        const plan = await this.options.computeEdits();
        if (!plan || plan.length === 0 || plan.every(p => !p.edits || p.edits.length === 0)) {
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

        this.snapshots = snapshots;
        await this.options.afterApply?.();
    }

    async undo(): Promise<void> {
        if (!this.snapshots || this.snapshots.length === 0) {
            return;
        }

        // Guard: all docs must match the after snapshot.
        for (const s of this.snapshots) {
            const doc = await vscode.workspace.openTextDocument(s.uri);
            if (doc.getText() !== s.afterText) {
                void vscode.window.showWarningMessage(
                    `Cannot undo '${this.options.label}' because a document changed outside the diagram.`
                );
                return;
            }
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const s of this.snapshots) {
            const doc = await vscode.workspace.openTextDocument(s.uri);
            workspaceEdit.set(s.uri, [new vscode.TextEdit(fullDocumentRange(doc), s.beforeText)]);
        }

        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (applied) {
            await this.options.afterApply?.();
        }
    }

    async redo(): Promise<void> {
        if (!this.snapshots || this.snapshots.length === 0) {
            return;
        }

        // Guard: all docs must match the before snapshot.
        for (const s of this.snapshots) {
            const doc = await vscode.workspace.openTextDocument(s.uri);
            if (doc.getText() !== s.beforeText) {
                void vscode.window.showWarningMessage(
                    `Cannot redo '${this.options.label}' because a document changed outside the diagram.`
                );
                return;
            }
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const s of this.snapshots) {
            const doc = await vscode.workspace.openTextDocument(s.uri);
            workspaceEdit.set(s.uri, [new vscode.TextEdit(fullDocumentRange(doc), s.afterText)]);
        }

        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (applied) {
            await this.options.afterApply?.();
        }
    }

    canUndo(): boolean {
        return !!this.snapshots && this.snapshots.length > 0;
    }
}
