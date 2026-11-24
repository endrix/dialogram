/**
 * Apply an untangle: the try the person kept saved as the layout, with the
 * port order of each definition it draws in another order than its source's
 * (definition-port-order.ts), and the orders the source can take written into
 * it (source-port-order-writer.ts), as one entry on the undo stack. An order
 * written into the source is not kept with the layout.
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
import { GNode, ModelState, OperationHandler, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import * as vscode from 'vscode';
import { definitionKeyOf } from '../model/definition-port-order';
import { ReversibleMultiWorkspaceEditCommand } from '../operations/reversible-multi-workspace-edit-command';
import type { CommandThatMayChangeNothing, CommandThatMayRefuse } from '../server/command-stack';
import { applyLayoutGeometry, layoutGeometryOf, saveLayoutGeometry, type LayoutGeometry } from '../server/layout-snapshot';
import type { CommandThatWritesOutOfBand, OutOfBandWrite } from '../server/out-of-band-writes';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { SOURCE_PORT_ORDER_WRITER, type PortOrderWrite, type SourcePortOrderWriter } from './source-port-order-writer';
import { untangleOf } from './untangle-session';

export type { PortOrderWrite } from './source-port-order-writer';

export const APPLY_PORT_ORDERS_OPERATION_KIND = 'dialogram.applyPortOrders' as const;

export interface ApplyPortOrdersOperation extends Operation {
    kind: typeof APPLY_PORT_ORDERS_OPERATION_KIND;
    /** The orders to write into the source; every other order the try draws is kept with the layout. */
    writes: PortOrderWrite[];
}

type Snapshot = { uri: vscode.Uri; beforeText: string; afterText: string };
type Outcome = { ok: boolean; snapshots: Snapshot[]; message?: string };

/**
 * A file as it is on disk: what a producer that rewrites it out of band
 * wrote, which the open document only catches up with later.
 */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return await fs.readFile(uri.fsPath, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * `geometry`, saved without keeping a port order for the definitions `keys`
 * names: the source has it once written, and an order the layout kept would
 * stand over the source's when it is changed by hand.
 */
export function withOrdersInSource(geometry: LayoutGeometry, keys: ReadonlySet<string>): LayoutGeometry {
    if (keys.size === 0) {
        return geometry;
    }
    const { set, remove } = geometry.saved.portOrders;
    return {
        ...geometry,
        saved: {
            ...geometry.saved,
            portOrders: {
                set: Object.fromEntries(Object.entries(set).filter(([key]) => !keys.has(key))),
                remove: [...new Set([...remove, ...keys])]
            }
        }
    };
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

    @inject(SOURCE_PORT_ORDER_WRITER)
    @optional()
    protected readonly writer?: SourcePortOrderWriter;

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
        // Only a writer writes a source: without one, every order is kept with the layout.
        const writer = this.writer;
        const writes = writer ? operation.writes ?? [] : [];
        const written = new Set(writes.flatMap(each => {
            const node = this.modelState.index.find(each.elementId);
            const key = node instanceof GNode ? definitionKeyOf(node) : undefined;
            return key === undefined ? [] : [key];
        }));
        const after = withOrdersInSource(proposed?.geometry ?? layoutGeometryOf(this.modelState.root), written);
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
                outcome = await this.write(writer, sourceUri, writes, drawing, before, after);
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
        writer: SourcePortOrderWriter | undefined,
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
                uri: vscode.Uri.parse(writer!.fileOf(this.modelState, sourceUri, each))
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
                const result = await writer!.write(sourceUri, target.uri.toString(), target);
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
