/**
 * A file the diagram edits, on disk and in the editor.
 *
 * Many edits are written by the product's producer, on disk, out of band.
 * The editor's copy of the file (its TextDocument) learns of such a write only
 * from VS Code's file watcher, and a watcher can report nothing: on a machine
 * out of inotify instances, a new window's watcher is dead. The copy then lags
 * the file, holding what the file held before the write.
 *
 * Undo and redo first check that the file is as the edit left it (or found
 * it). Asked of a lagging copy, that check refused every undo of an edit the
 * producer wrote: the copy still held the text before. So where the copy lags,
 * the file is asked on disk, and written there: the copy, given the edit and
 * saved, would be saved over a file VS Code holds to be newer.
 */
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';

/** The text of the file `uri` names, on disk; nothing when it is not a file that can be read. */
export async function textOnDisk(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme !== 'file') {
        return undefined;
    }
    try {
        return await fs.readFile(uri.fsPath, 'utf8');
    } catch {
        return undefined;
    }
}

/** Write `text` to the file `uri` names, on disk, as it is: the producer's own text, read back where it was written. */
export async function writeOnDisk(uri: vscode.Uri, text: string): Promise<void> {
    await fs.writeFile(uri.fsPath, text, 'utf8');
}

/** What `error`, from a write, says. */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `text` as the editor holds it: without a leading byte order mark, which the editor keeps apart from the text. */
export function forTheEditor(text: string): string {
    return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Whether `a` and `b` are the same text to the editor: one read on disk may
 * open with a byte order mark the editor's copy does not hold, and the copy
 * holds every line break alike.
 */
export function sameText(a: string, b: string): boolean {
    return a === b || lineBreaksAlike(forTheEditor(a)) === lineBreaksAlike(forTheEditor(b));
}

function lineBreaksAlike(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * The file `uri` names, as it is on disk, where `copy`, the editor's copy of
 * it, lags it: the copy holds no unsaved change and is not the file's text.
 * Nothing where the copy is the file, where it holds unsaved changes (they
 * are what the user sees, and would save), or where the file cannot be read:
 * the copy is then where the file stands.
 */
export async function fileTheCopyLags(uri: vscode.Uri, copy: vscode.TextDocument): Promise<string | undefined> {
    if (copy.isDirty) {
        return undefined;
    }
    const onDisk = await textOnDisk(uri);
    return onDisk !== undefined && !sameText(onDisk, copy.getText()) ? onDisk : undefined;
}
