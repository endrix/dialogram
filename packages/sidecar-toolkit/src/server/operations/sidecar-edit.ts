/**
 * An edit the producer writes, said when it is refused.
 *
 * The producer answers a refusal with its reason ("Node not found: x",
 * "'x.Out' is connected …"). An edit that drops that answer leaves the
 * diagram as it was and says nothing: the user cannot tell an edit that was
 * refused from one still on its way. Here a refusal is said, in the
 * producer's words or the caller's when it gives none.
 *
 * A gesture the producer writes in several steps (a cut, a paste, a
 * duplicate) is written whole or not at all: a step refused puts the file
 * back as it was on disk before the first step, so no half of it is left
 * behind with nothing on the undo stack to take it back.
 */
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import type { SidecarInvoker } from './sidecar-invoker';

type Payload = { op: string; args: Record<string, unknown> };
type Sender = Pick<SidecarInvoker, 'sendSidecarOpDetailed'>;

/** Ask for one edit; a refusal is said, and answered false. */
export async function sendSidecarEdit(sidecar: Sender, sourceUri: string, payload: Payload, failed: string): Promise<boolean> {
    const result = await sidecar.sendSidecarOpDetailed(sourceUri, payload);
    if (!result.ok) {
        void vscode.window.showWarningMessage(result.message ?? failed);
    }
    return result.ok;
}

/** The steps of one gesture, written into one file: all of them, or none. */
export class SidecarSteps {
    private constructor(
        private readonly sidecar: Sender,
        private readonly sourceUri: string,
        private readonly before: string
    ) {}

    /** The file as it was on disk when the steps began. */
    get textBefore(): string {
        return this.before;
    }

    /** Before the first step: the file as it is on disk, to be put back if a step is refused. */
    static async begin(sidecar: Sender, sourceUri: string): Promise<SidecarSteps> {
        return new SidecarSteps(sidecar, sourceUri, await readAuthoritativeSourceText(vscode.Uri.parse(sourceUri)));
    }

    /**
     * Ask for a step. Refused, the file is put back, the refusal is said
     * with nothing changed, and false is answered: the caller stops there.
     */
    async send(payload: Payload, failed: string): Promise<boolean> {
        const result = await this.sidecar.sendSidecarOpDetailed(this.sourceUri, payload);
        if (result.ok) {
            return true;
        }
        const path = vscode.Uri.parse(this.sourceUri).fsPath;
        let restored = true;
        try {
            if ((await fs.readFile(path, 'utf8')) !== this.before) {
                await fs.writeFile(path, this.before, 'utf8');
            }
        } catch {
            restored = false;
        }
        // A producer's reason may end without a stop (wfpy's do): one sentence.
        const said = (result.message ?? failed).trim();
        const reason = /[.!?]$/.test(said) ? said : `${said}.`;
        void vscode.window.showWarningMessage(restored
            ? `${reason} Nothing was changed.`
            : `${reason} The steps before it could not be taken back in ${path}.`);
        return false;
    }
}
