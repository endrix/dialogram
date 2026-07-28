import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ReversibleWorkspaceEditCommand } from '../src/operations/reversible-workspace-edit-command';

/**
 * These tests pin the undo guard's contract: it must accept an undo when the live document
 * matches the authoritative `afterText` the sidecar wrote, and refuse (without editing) when the
 * document drifted. The companion fix snapshots `afterText` from authoritative on-disk content so
 * the "matches" branch is actually reachable after an out-of-band sidecar write.
 */
function makeDoc(getText: () => string) {
    return {
        get lineCount() {
            return getText().split('\n').length;
        },
        lineAt: (line: number) => ({ text: getText().split('\n')[line] ?? '' }),
        getText
    };
}

describe('ReversibleWorkspaceEditCommand undo guard', () => {
    it('accepts the undo when the live document matches the authoritative afterText', async () => {
        const authoritativeAfter = 'AFTER-authoritative\n';
        const before = 'BEFORE\n';
        let liveText = authoritativeAfter; // reconciled document == what the sidecar wrote

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpen = workspaceAny.openTextDocument;
        const originalApply = workspaceAny.applyEdit;
        const originalWarn = windowAny.showWarningMessage;

        const warnings: string[] = [];
        let undoApplyCalls = 0;
        let executed = false;
        workspaceAny.openTextDocument = async () => makeDoc(() => liveText);
        workspaceAny.applyEdit = async () => {
            // Count only the undo-time apply; execute() also applies the placeholder edit.
            if (executed) {
                undoApplyCalls += 1;
            }
            return true;
        };
        windowAny.showWarningMessage = async (m: string) => { warnings.push(m); };

        try {
            const command = new ReversibleWorkspaceEditCommand({
                label: 'Create Node',
                uri: vscode.Uri.parse('file:///tmp/g.py'),
                computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')]
            });
            // Stand in for the handler-supplied authoritative snapshots.
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = authoritativeAfter;
            await command.execute();
            executed = true;

            await command.undo();
            expect(warnings).toEqual([]);
            expect(undoApplyCalls).toBe(1);
        } finally {
            workspaceAny.openTextDocument = originalOpen;
            workspaceAny.applyEdit = originalApply;
            windowAny.showWarningMessage = originalWarn;
        }
    });

    it('refuses the undo (no edit) when the live document drifted from afterText', async () => {
        const before = 'BEFORE\n';
        const authoritativeAfter = 'AFTER-authoritative\n';
        let liveText = authoritativeAfter;

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpen = workspaceAny.openTextDocument;
        const originalApply = workspaceAny.applyEdit;
        const originalWarn = windowAny.showWarningMessage;

        const warnings: string[] = [];
        let undoApplyCalls = 0;
        let executed = false;
        workspaceAny.openTextDocument = async () => makeDoc(() => liveText);
        workspaceAny.applyEdit = async () => {
            if (executed) {
                undoApplyCalls += 1;
            }
            return true;
        };
        windowAny.showWarningMessage = async (m: string) => { warnings.push(m); };

        try {
            const command = new ReversibleWorkspaceEditCommand({
                label: 'Create Node',
                uri: vscode.Uri.parse('file:///tmp/g.py'),
                computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')]
            });
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = authoritativeAfter;
            await command.execute();
            executed = true;

            liveText = 'SOMETHING-ELSE\n'; // document changed outside the diagram
            await command.undo();
            expect(undoApplyCalls).toBe(0);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('changed outside the diagram');
        } finally {
            workspaceAny.openTextDocument = originalOpen;
            workspaceAny.applyEdit = originalApply;
            windowAny.showWarningMessage = originalWarn;
        }
    });
});

/**
 * The undo/redo edit lands on the dirty text buffer, but the diagram model is rebuilt by the
 * sidecar FROM DISK. Unless the document is persisted, disk still holds the pre-undo content and
 * the node does not disappear until the user manually saves. These tests pin that undo AND redo
 * save the affected document after applying their edit, so the on-save reload reflects the revert.
 */
describe('ReversibleWorkspaceEditCommand persistence', () => {
    function makeDirtyDoc(getText: () => string, save: () => Promise<boolean>) {
        return {
            get lineCount() {
                return getText().split('\n').length;
            },
            lineAt: (line: number) => ({ text: getText().split('\n')[line] ?? '' }),
            getText,
            get isDirty() {
                return true;
            },
            save
        };
    }

    it('saves the document after applying an undo so the diagram reloads from disk', async () => {
        const before = 'BEFORE\n';
        const after = 'AFTER\n';
        let liveText = after;

        const workspaceAny = vscode.workspace as any;
        const originalOpen = workspaceAny.openTextDocument;
        const originalApply = workspaceAny.applyEdit;

        const save = vi.fn(async () => true);
        let executed = false;
        workspaceAny.openTextDocument = async () => makeDirtyDoc(() => liveText, save);
        workspaceAny.applyEdit = async () => {
            if (executed) {
                liveText = before;
            }
            return true;
        };

        try {
            const command = new ReversibleWorkspaceEditCommand({
                label: 'Create Node',
                uri: vscode.Uri.parse('file:///tmp/g.py'),
                computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')]
            });
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = after;
            await command.execute();
            executed = true;

            await command.undo();
            expect(save).toHaveBeenCalledOnce();
            expect(liveText).toBe(before);
        } finally {
            workspaceAny.openTextDocument = originalOpen;
            workspaceAny.applyEdit = originalApply;
        }
    });

    it('saves the document after applying a redo (symmetry)', async () => {
        const before = 'BEFORE\n';
        const after = 'AFTER\n';
        let liveText = before;

        const workspaceAny = vscode.workspace as any;
        const originalOpen = workspaceAny.openTextDocument;
        const originalApply = workspaceAny.applyEdit;

        const save = vi.fn(async () => true);
        let executed = false;
        workspaceAny.openTextDocument = async () => makeDirtyDoc(() => liveText, save);
        workspaceAny.applyEdit = async () => {
            if (executed) {
                liveText = after;
            }
            return true;
        };

        try {
            const command = new ReversibleWorkspaceEditCommand({
                label: 'Create Node',
                uri: vscode.Uri.parse('file:///tmp/g.py'),
                computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')]
            });
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = after;
            await command.execute();
            executed = true;

            await command.redo();
            expect(save).toHaveBeenCalledOnce();
            expect(liveText).toBe(after);
        } finally {
            workspaceAny.openTextDocument = originalOpen;
            workspaceAny.applyEdit = originalApply;
        }
    });
});
