/**
 * Apply an untangle: the port orders of the try the person kept, written into
 * the source of each definition, and the try's drawing saved as the layout,
 * as one entry on the undo stack.
 *
 * The layout is saved first and the sources written after: each write makes
 * the host reload the diagram, which then reads the saved layout, with the
 * ports declared in the order the routes were drawn for. A write refused (or
 * failing) puts back every file written before it and the layout as it was:
 * nothing is left half done.
 *
 * The layout file is not one of the files the undo puts back: it changes with
 * every node moved, and the undo would then refuse. Undo saves the drawing the
 * diagram had before the untangle instead, and redo the try's, each before
 * the files are put back, which reloads the diagram. A try that changes no
 * port order is still an entry to undo: its layout.
 */
import { promises as fs } from 'node:fs';
import { Operation } from '@eclipse-glsp/protocol';
import { ModelState, OperationHandler, type Command, type MaybePromise } from '@eclipse-glsp/server';
import type { CommandThatMayChangeNothing, CommandThatMayRefuse } from '@dialogram/diagram-server/server/command-stack';
import type { CommandThatWritesOutOfBand, OutOfBandWrite } from '@dialogram/diagram-server/server/out-of-band-writes';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { applyLayoutGeometry, layoutGeometryOf, saveLayoutGeometry, type LayoutGeometry } from '@dialogram/diagram-server/server/layout-snapshot';
import { readAuthoritativeSourceText } from '../operations/authoritative-source-text';
import { entityFileOf } from '../operations/entity-port-write';
import { SidecarInvoker } from '../operations/sidecar-invoker';
import { untangleOf } from './untangle-session';

export const APPLY_PORT_ORDERS_OPERATION_KIND = 'dialogram.applyPortOrders' as const;

/** The sidecar op that writes a definition's port order, where the producer has one. */
export const REORDER_ENTITY_PORTS_OP = 'reorderEntityPorts';

/** One definition's port order to write: all its ports, each once, by name. */
export interface PortOrderWrite {
    entity: string;
    /** One of its instances in this diagram: where its file is found from. */
    elementId: string;
    order: string[];
}

export interface ApplyPortOrdersOperation extends Operation {
    kind: typeof APPLY_PORT_ORDERS_OPERATION_KIND;
    writes: PortOrderWrite[];
}

type Snapshot = { uri: vscode.Uri; beforeText: string; afterText: string };
type Outcome = { ok: boolean; snapshots: Snapshot[]; message?: string };

async function textOf(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return await readAuthoritativeSourceText(uri);
    } catch {
        return undefined;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The untangle applied: the try's drawing, saved and drawn, and the files
 * the producer wrote (`files`, which puts them back). Kept on the stack when
 * it applied, files or not; undone, the drawing before is saved and drawn
 * first, then the files are put back; a file changed outside the diagram
 * since refuses the whole, the drawing saved again as it was.
 */
class ApplyUntangleCommand implements CommandThatMayChangeNothing, CommandThatMayRefuse, CommandThatWritesOutOfBand {
    private refusedLast = false;

    constructor(
        private readonly files: ReversibleMultiWorkspaceEditCommand,
        private readonly drawing: (geometry: LayoutGeometry) => Promise<void>,
        private readonly before: LayoutGeometry,
        private readonly after: LayoutGeometry,
        private readonly outcome: () => Outcome | undefined
    ) {}

    async execute(): Promise<void> {
        await this.files.execute();
    }

    changedNothing(): boolean {
        return !this.outcome()?.ok;
    }

    canUndo(): boolean {
        return this.outcome()?.ok === true;
    }

    refused(): boolean {
        return this.refusedLast;
    }

    async undo(): Promise<void> {
        await this.putBack(this.before, this.after, () => this.files.undo());
    }

    async redo(): Promise<void> {
        await this.putBack(this.after, this.before, () => this.files.redo());
    }

    private async putBack(to: LayoutGeometry, from: LayoutGeometry, files: () => Promise<void>): Promise<void> {
        this.refusedLast = false;
        await this.drawing(to);
        if (this.files.canUndo()) {
            await files();
            if (this.files.refused()) {
                this.refusedLast = true;
                await this.drawing(from);
            }
        }
    }

    outOfBandWrites(): readonly OutOfBandWrite[] {
        return this.files.outOfBandWrites();
    }

    writtenInTheEditor(): readonly string[] {
        return this.files.writtenInTheEditor();
    }
}

@injectable()
export class ApplyPortOrdersOperationHandler extends OperationHandler {
    override readonly operationType = APPLY_PORT_ORDERS_OPERATION_KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    @inject(LayoutPersistenceService)
    protected readonly layoutPersistence!: LayoutPersistenceService;

    createCommand(operation: ApplyPortOrdersOperation): MaybePromise<Command | undefined> {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }
        const state = untangleOf(this.modelState);
        // The try put to the person, as it was drawn: what was proposed is
        // what is saved, whatever the diagram was made to show meanwhile.
        const proposed = state?.proposed !== undefined ? state.tries[state.proposed - 1] : undefined;
        const after = proposed?.geometry ?? layoutGeometryOf(this.modelState.root);
        const before = state?.original ?? after;
        const drawing = async (geometry: LayoutGeometry): Promise<void> => {
            applyLayoutGeometry(this.modelState.root, geometry);
            await saveLayoutGeometry(this.modelState, this.layoutPersistence, geometry);
        };
        let outcome: Outcome | undefined;
        const files = new ReversibleMultiWorkspaceEditCommand({
            label: 'Untangle',
            outOfBandSnapshots: () => outcome?.snapshots ?? [],
            computeEdits: async () => {
                outcome = await this.write(sourceUri, operation.writes ?? [], drawing, before, after);
                if (state) {
                    state.applied = {
                        ok: outcome.ok,
                        files: outcome.snapshots.map(each => each.uri.fsPath),
                        ...(outcome.message ? { message: outcome.message } : {})
                    };
                }
                return outcome.snapshots.length > 0
                    ? outcome.snapshots.map(each => ({ uri: each.uri, edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')] }))
                    : undefined;
            }
        });
        return new ApplyUntangleCommand(files, drawing, before, after, () => outcome);
    }

    /**
     * Draw and save `after`, then write each order; refused, or failing, put
     * back the files written and draw and save `before`. The files that
     * changed, each as it was and as it is.
     */
    private async write(
        sourceUri: string,
        writes: readonly PortOrderWrite[],
        drawing: (geometry: LayoutGeometry) => Promise<void>,
        before: LayoutGeometry,
        after: LayoutGeometry
    ): Promise<Outcome> {
        const was = new Map<string, string>();
        let files: vscode.Uri[] = [];
        let saved = false;
        const undone = async (message: string): Promise<Outcome> => {
            const putBack = await this.putBack(files, was);
            if (saved) {
                await drawing(before).catch(() => undefined);
            }
            return {
                ok: false,
                snapshots: [],
                message: message + (putBack ? ' Nothing was changed.' : ' The files written before it could not all be put back.')
            };
        };
        try {
            const targets = writes.map(each => ({
                ...each,
                uri: vscode.Uri.parse(entityFileOf(this.modelState, sourceUri, { entityType: each.entity, elementId: each.elementId }))
            }));
            files = [...new Map(targets.map(each => [each.uri.toString(), each.uri] as const)).values()];
            for (const uri of files) {
                const text = await textOf(uri);
                if (text === undefined) {
                    return { ok: false, snapshots: [], message: `${uri.fsPath} cannot be read: nothing was changed.` };
                }
                was.set(uri.toString(), text);
            }
            saved = true;
            await drawing(after);
            for (const target of targets) {
                const result = await this.sidecar.sendSidecarOpDetailed(target.uri.toString(), {
                    op: this.sidecar.sidecarOp(REORDER_ENTITY_PORTS_OP),
                    args: { entity: target.entity, order: target.order }
                });
                if (!result.ok) {
                    const name = target.uri.fsPath.split(/[\\/]/).pop() ?? target.uri.fsPath;
                    const reason = (result.message ?? 'refused').trim().replace(/[.!?]?$/, '.');
                    return await undone(`The port order of '${target.entity}' in ${name} was not written: ${reason}`);
                }
            }
            const snapshots: Snapshot[] = [];
            for (const uri of files) {
                const text = await textOf(uri);
                const beforeText = was.get(uri.toString())!;
                if (text !== undefined && text !== beforeText) {
                    snapshots.push({ uri, beforeText, afterText: text });
                }
            }
            return { ok: true, snapshots };
        } catch (error) {
            return await undone(`The untangle could not be applied: ${messageOf(error).trim().replace(/[.!?]?$/, '.')}`);
        }
    }

    /** Every file of `files` as `was` has it; false when one could not be written. */
    private async putBack(files: readonly vscode.Uri[], was: ReadonlyMap<string, string>): Promise<boolean> {
        let all = true;
        for (const uri of files) {
            const text = was.get(uri.toString());
            try {
                if (text !== undefined && (await fs.readFile(uri.fsPath, 'utf8')) !== text) {
                    await fs.writeFile(uri.fsPath, text, 'utf8');
                }
            } catch {
                all = false;
            }
        }
        return all;
    }
}
