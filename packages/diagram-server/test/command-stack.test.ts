/**
 * The command stack keeps no command that changed nothing.
 *
 * GLSP's own stack keeps every command it executes. One that wrote nothing
 * (an edit refused, cancelled, or come back to the text it started from)
 * cannot be undone, and on top of the stack it kept Undo from reaching the
 * edits before it. The platform's stack drops such a command after it has
 * run, so Undo undoes the last edit that wrote, what could be redone still
 * can be, and the document is as dirty as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { DefaultCommandStack } from '@eclipse-glsp/server';
import { WorkflowCommandStack, changedNothing } from '../src/server/command-stack';
import { WorkflowDiagramModule } from '../src/server/diagram-module';
import { ReversibleWorkspaceEditCommand } from '../src/operations/reversible-workspace-edit-command';
import { ReversibleMultiWorkspaceEditCommand } from '../src/operations/reversible-multi-workspace-edit-command';

const uri = vscode.Uri.parse('file:///w/net.src');

/**
 * The document, held here. An edit applied replaces its text with the edit's,
 * except an empty insertion at its start, which is what a command applies
 * after the program that writes the source has written it itself.
 */
let text = '';
const saved = {
    open: (vscode.workspace as any).openTextDocument,
    apply: (vscode.workspace as any).applyEdit,
    set: (vscode.WorkspaceEdit as any).prototype.set
};

beforeEach(() => {
    text = 'A';
    let pending: vscode.TextEdit[] = [];
    (vscode.WorkspaceEdit as any).prototype.set = (_uri: unknown, edits: vscode.TextEdit[]) => { pending = edits; };
    (vscode.workspace as any).openTextDocument = async () => ({
        getText: () => text, isDirty: false, lineCount: 1, lineAt: () => ({ text }), save: async () => true
    });
    (vscode.workspace as any).applyEdit = async () => {
        for (const edit of pending) {
            const insertion = edit.range.start.line === 0 && edit.range.start.character === 0
                && edit.range.end.line === 0 && edit.range.end.character === 0;
            text = insertion ? edit.newText + text : edit.newText;
        }
        pending = [];
        return true;
    };
});

afterEach(() => {
    (vscode.workspace as any).openTextDocument = saved.open;
    (vscode.workspace as any).applyEdit = saved.apply;
    (vscode.WorkspaceEdit as any).prototype.set = saved.set;
});

/** The platform's stack, with a logger that fails the test on what GLSP would log. */
function commandStack(): WorkflowCommandStack {
    const stack = new WorkflowCommandStack();
    (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
    return stack;
}

/** An edit that writes `to` in the document. */
function edit(to: string): ReversibleWorkspaceEditCommand {
    return new ReversibleWorkspaceEditCommand({
        label: 'Edit',
        uri,
        computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, text.length), to)]
    });
}

/** An edit refused: there is nothing to write. */
function refused(): ReversibleWorkspaceEditCommand {
    return new ReversibleWorkspaceEditCommand({ label: 'Refused', uri, computeEdits: async () => undefined });
}

/**
 * An edit the program that writes the source makes itself: it writes `to`,
 * or nothing, and the handler gives the text before and after as it read
 * them.
 */
function outOfBand(to?: string): ReversibleWorkspaceEditCommand {
    const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
        label: 'Out of band',
        uri,
        computeEdits: async () => {
            const before = text;
            if (to !== undefined) {
                text = to;
            }
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = text;
            return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
        }
    });
    return command;
}

describe('the platform command stack', () => {
    it('is the one a diagram is given, and is GLSP\'s', () => {
        expect((new WorkflowDiagramModule() as any).bindCommandStack()).toBe(WorkflowCommandStack);
        expect((new WorkflowDiagramModule({ edits: 'read-only' }) as any).bindCommandStack()).toBe(WorkflowCommandStack);
        expect(commandStack()).toBeInstanceOf(DefaultCommandStack);
    });

    it('after an edit refused, undoes the edit before it', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        await stack.execute(refused());
        expect(text).toBe('B');
        expect(stack.canUndo()).toBe(true);
        await stack.undo();
        expect(text).toBe('A');
        expect(stack.canUndo()).toBe(false);
    });

    it('after an edit refused, still redoes what was undone, and is as dirty as it was', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        stack.saveIsDone();
        await stack.execute(refused());
        expect(stack.isDirty).toBe(false);
        await stack.undo();
        await stack.execute(refused());
        expect(stack.canRedo()).toBe(true);
        await stack.redo();
        expect(text).toBe('B');
        expect(stack.isDirty).toBe(false);
    });

    it('drops an edit whose text after is the text before, and keeps one that wrote', async () => {
        const stack = commandStack();
        await stack.execute(outOfBand('B'));
        const unchanged = outOfBand();
        await stack.execute(unchanged);
        expect(unchanged.changedNothing()).toBe(true);
        await stack.undo();
        expect(text).toBe('A');
    });

    it('drops an edit of several files that has none to edit', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        const none = new ReversibleMultiWorkspaceEditCommand({ label: 'Refused', computeEdits: async () => undefined });
        await stack.execute(none);
        expect(none.changedNothing()).toBe(true);
        await stack.undo();
        expect(text).toBe('A');
    });

    it('does not count files named with no edit as nothing: what was written out of band is not known', async () => {
        const named = new ReversibleMultiWorkspaceEditCommand({ label: 'Named', computeEdits: async () => [{ uri, edits: [] }] });
        await named.execute();
        expect(named.changedNothing()).toBe(false);
    });

    it('keeps a command that cannot say what it changed, as GLSP does', async () => {
        const stack = commandStack();
        let undone = false;
        await stack.execute({ execute: () => {}, undo: () => { undone = true; }, redo: () => {} });
        expect(changedNothing({ execute: () => {}, undo: () => {}, redo: () => {} })).toBe(false);
        await stack.undo();
        expect(undone).toBe(true);
    });
});
