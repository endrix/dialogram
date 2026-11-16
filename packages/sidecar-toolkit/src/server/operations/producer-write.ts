/**
 * An edit the producer writes itself, into one file or several, as one entry
 * on the undo stack.
 *
 * The producer rewrites its sources out of band: nothing is left for the
 * editor to apply, and what a file held before is gone by the time the
 * command could look. So each file the edit may write is read before the
 * producer is asked and after it answers, and undo puts back what the file
 * held: the file the producer is sent (`fileUri`), which need not be the
 * diagram's (an instance's ports are its class's, in the class's file), and
 * the others it may write too (`alsoWrites`: the diagram's own, whose
 * connections follow a port renamed in its class).
 *
 * A refusal says why (the producer's reason, or `failed`) and leaves nothing
 * on the undo stack; so does an edit that wrote nothing.
 */
import * as vscode from 'vscode';
import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import type { SidecarInvoker } from './sidecar-invoker';

/** What the producer is asked to write, and where. */
export interface ProducerWrite {
    /** The file the producer is sent the op for. */
    fileUri: string;
    /** Other files the op may write. */
    alsoWrites?: string[];
    payload: { op: string; args: Record<string, unknown> };
}

export interface ProducerWriteOptions {
    label: string;
    sidecar: Pick<SidecarInvoker, 'sendSidecarOpDetailed'>;
    /** What to ask, worked out when the command runs; nothing: there is nothing to ask. */
    request: () => ProducerWrite | undefined | Promise<ProducerWrite | undefined>;
    /** Said when the producer refuses with no reason of its own. */
    failed: string;
    afterApply?: () => void | Promise<void>;
}

type Snapshot = { uri: vscode.Uri; beforeText: string; afterText: string };

async function textOf(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return (await vscode.workspace.openTextDocument(uri)).getText();
    } catch {
        return undefined;
    }
}

/** A command that has the producer write the edit `options.request` names. */
export function producerWriteCommand(options: ProducerWriteOptions): ReversibleMultiWorkspaceEditCommand {
    let snapshots: Snapshot[] = [];
    return new ReversibleMultiWorkspaceEditCommand({
        label: options.label,
        afterApply: options.afterApply,
        outOfBandSnapshots: () => snapshots,
        computeEdits: async () => {
            snapshots = [];
            const asked = await options.request();
            if (!asked) {
                return undefined;
            }
            const uris = [...new Map(
                [asked.fileUri, ...(asked.alsoWrites ?? [])].map(each => {
                    const uri = vscode.Uri.parse(each);
                    return [uri.toString(), uri] as const;
                })
            ).values()];
            const before = await Promise.all(uris.map(textOf));
            const result = await options.sidecar.sendSidecarOpDetailed(asked.fileUri, asked.payload);
            if (!result.ok) {
                void vscode.window.showWarningMessage(result.message ?? options.failed);
                return undefined;
            }
            const all: Snapshot[] = [];
            for (const [at, uri] of uris.entries()) {
                if (before[at] === undefined) {
                    continue;
                }
                all.push({ uri, beforeText: before[at]!, afterText: await readAuthoritativeSourceText(uri) });
            }
            // The files the producer changed; each as it was when it changed
            // none, which the command then counts as changing nothing.
            const changed = all.filter(each => each.beforeText !== each.afterText);
            snapshots = changed.length > 0 ? changed : all;
            return snapshots.map(each => ({ uri: each.uri, edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')] }));
        }
    });
}
