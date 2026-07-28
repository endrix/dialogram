import { describe, expect, it } from 'vitest';
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
