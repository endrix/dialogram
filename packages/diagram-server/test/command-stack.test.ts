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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CompoundCommand, DefaultCommandStack } from '@eclipse-glsp/server';
import { CompoundCommandThatMayChangeNothing, WorkflowCommandStack, WorkflowCompoundOperationHandler, changedNothing } from '../src/server/command-stack';
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

    it('drops GLSP\'s compound of edits that each changed nothing', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        await stack.execute(new CompoundCommand([refused(), refused()]));
        await stack.undo();
        expect(text).toBe('A');
    });

    it('makes of several operations sent as one a compound undone past a part refused, and dropped when all are', async () => {
        const handler = new WorkflowCompoundOperationHandler() as any;
        const parts: any[] = [];
        handler.operationHandlerRegistry = { getOperationHandler: () => ({ execute: async () => parts.shift() }) };
        const stack = commandStack();
        await stack.execute(edit('B'));
        parts.push(edit('C'), refused());
        await stack.execute(await handler.createCommand({ kind: 'compound', operationList: [{}, {}] }));
        expect(text).toBe('C');
        parts.push(refused(), refused());
        await stack.execute(await handler.createCommand({ kind: 'compound', operationList: [{}, {}] }));
        expect(stack.canUndo()).toBe(true);
        await stack.undo();
        expect(text).toBe('B');
        await stack.undo();
        expect(text).toBe('A');
    });

    it('drops a compound of which no part changed anything, and undoes one of which a part wrote', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        await stack.execute(new CompoundCommandThatMayChangeNothing([refused(), refused()]));
        expect(text).toBe('B');
        const wrote = new CompoundCommandThatMayChangeNothing([edit('C'), refused()]);
        await stack.execute(wrote);
        expect(wrote.changedNothing()).toBe(false);
        expect(stack.canUndo()).toBe(true);
        await stack.undo();
        expect(text).toBe('B');
        await stack.undo();
        expect(text).toBe('A');
    });
});

describe('an undo or redo refused', () => {
    it('is still the edit to undo, and the ones below it are undone once the text is back', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        await stack.execute(edit('C'));
        text = 'X'; // changed outside the diagram
        await stack.undo();
        expect(text).toBe('X');
        expect(stack.canRedo()).toBe(false);
        await stack.undo();
        expect(text).toBe('X');
        text = 'C';
        await stack.undo();
        expect(text).toBe('B');
        await stack.undo();
        expect(text).toBe('A');
    });

    it('is still the edit to redo', async () => {
        const stack = commandStack();
        await stack.execute(edit('B'));
        await stack.undo();
        text = 'X';
        await stack.redo();
        expect(text).toBe('X');
        expect(stack.canRedo()).toBe(true);
        text = 'A';
        await stack.redo();
        expect(text).toBe('B');
        expect(stack.canRedo()).toBe(false);
    });
});

describe('an edit written out of band, judged by the file on disk', () => {
    let dir = '';
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * The file on disk holds `onDisk`, the editor's document `text` (which
     * lags what was written out of band, or holds what was not saved); the
     * edit writes `to` on disk, or nothing, and gives as its handlers do the
     * document's text before and the file's after.
     */
    function written(onDisk: string, to?: string): ReversibleWorkspaceEditCommand {
        dir = mkdtempSync(path.join(tmpdir(), 'command-stack-'));
        const file = path.join(dir, 'net.src');
        writeFileSync(file, onDisk);
        const fileUri = { scheme: 'file', fsPath: file, toString: () => `file://${file}` } as unknown as vscode.Uri;
        const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
            label: 'Out of band',
            uri: fileUri,
            computeEdits: async () => {
                const before = text;
                if (to !== undefined) {
                    writeFileSync(file, to);
                }
                (command as any)._sourceBeforeText = before;
                (command as any)._sourceAfterText = readFileSync(file, 'utf8');
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            }
        });
        return command;
    }

    it('keeps one that wrote back the text the editor still shows', async () => {
        text = 'A';
        const command = written('B', 'A');
        await commandStack().execute(command);
        expect(command.changedNothing()).toBe(false);
    });

    it('drops one refused while the editor shows other text', async () => {
        text = 'X';
        const command = written('A');
        await commandStack().execute(command);
        expect(command.changedNothing()).toBe(true);
    });

    it('undone, puts back the file as it was on disk, not the text the editor had not caught up from', async () => {
        text = 'A'; // an earlier edit wrote B; the editor still shows A
        const command = written('B', 'C');
        const stack = commandStack();
        await stack.execute(command);
        text = 'C'; // caught up
        await stack.undo();
        expect(text).toBe('B');
    });

    it('drops one refused on an empty file', async () => {
        text = '';
        const command = written('');
        await commandStack().execute(command);
        expect(command.changedNothing()).toBe(true);
    });
});
