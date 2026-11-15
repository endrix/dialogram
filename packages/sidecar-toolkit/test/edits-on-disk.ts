/**
 * Edits run as the editor runs them: on the platform's command stack, with
 * the editor's document what is on disk.
 */
import * as vscode from 'vscode';
import { readFileSync, writeFileSync } from 'node:fs';
import { WorkflowCommandStack } from '@dialogram/diagram-server/server/command-stack';

/** The platform's command stack, GLSP's as a diagram is given it, which logs what fails (it is injected a logger in the server). */
export function commandStack(): WorkflowCommandStack {
    const stack = new WorkflowCommandStack();
    (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
    return stack;
}

/** Run `body` with the editor's document of `file` what is on disk, and an edit applied to it written there. */
export async function onDisk<T>(file: string, body: () => Promise<T>): Promise<T> {
    const workspace = vscode.workspace as any;
    const proto = (vscode.WorkspaceEdit as any).prototype;
    const saved = { open: workspace.openTextDocument, apply: workspace.applyEdit, set: proto.set };
    const pending: string[] = [];
    proto.set = function (_uri: unknown, edits: Array<{ newText: string }>) { pending.push(...edits.map(edit => edit.newText)); };
    workspace.openTextDocument = async () => ({
        getText: () => readFileSync(file, 'utf8'), isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true
    });
    workspace.applyEdit = async () => {
        const text = pending.pop();
        if (text) {
            writeFileSync(file, text);
        }
        return true;
    };
    try {
        return await body();
    } finally {
        proto.set = saved.set;
        workspace.openTextDocument = saved.open;
        workspace.applyEdit = saved.apply;
    }
}

/** Run `body` with what the window says kept (`said`), its information and its warnings. */
export async function saying<T>(body: (said: string[]) => Promise<T>): Promise<T> {
    const window = vscode.window as any;
    const saved = { info: window.showInformationMessage, warn: window.showWarningMessage };
    const said: string[] = [];
    window.showInformationMessage = async (message: string) => { said.push(message); };
    window.showWarningMessage = async (message: string) => { said.push(message); };
    try {
        return await body(said);
    } finally {
        window.showInformationMessage = saved.info;
        window.showWarningMessage = saved.warn;
    }
}
