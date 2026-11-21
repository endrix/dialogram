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

/**
 * Whether `a` and `b`, both read on disk, are the same file: a byte order
 * mark aside, every character alike, line breaks too. A file whose line
 * breaks another tool changed is not the one the edit left.
 */
export function sameOnDisk(a: string, b: string): boolean {
    return forTheEditor(a) === forTheEditor(b);
}

function lineBreaksAlike(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * Whether `onDisk`, the file read as UTF-8, is the file `copy` holds, read
 * as the editor reads it. VS Code names the copy's encoding where it can
 * (`TextDocument.encoding`, newer than the API this is built on); elsewhere,
 * a file read as UTF-8 that it is not shows characters it could not read,
 * or NULs (UTF-16), that the copy does not. A file in another encoding is
 * left to the copy, on disk neither asked nor written.
 */
function readsAsTheCopy(onDisk: string, copy: vscode.TextDocument): boolean {
    const encoding = (copy as { encoding?: unknown }).encoding;
    if (typeof encoding === 'string') {
        return encoding === 'utf8' || encoding === 'utf8bom';
    }
    const held = copy.getText();
    return (!onDisk.includes('�') || held.includes('�')) && (!onDisk.includes('\0') || held.includes('\0'));
}

/**
 * The file `uri` names, as it is on disk, where `copy`, the editor's copy of
 * it, lags it: the copy holds no unsaved change and is not the file's text.
 * Nothing where the copy is the file, where it holds unsaved changes (they
 * are what the user sees, and would save), or where the file cannot be read,
 * or not as UTF-8: the copy is then where the file stands.
 */
export async function fileTheCopyLags(uri: vscode.Uri, copy: vscode.TextDocument): Promise<string | undefined> {
    if (copy.isDirty) {
        return undefined;
    }
    const onDisk = await textOnDisk(uri);
    return onDisk !== undefined && !sameText(onDisk, copy.getText()) && readsAsTheCopy(onDisk, copy) ? onDisk : undefined;
}
