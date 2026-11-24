/**
 * Apply an untangle: the port orders of the try the person kept, written into
 * the source of each definition, and the try's drawing saved as the layout,
 * as one entry on the undo stack.
 *
 * The layout is saved first and the sources written after: each write makes
 * the host reload the diagram, which then reads the saved layout, with the
 * ports declared in the order the routes were drawn for. A write refused puts
 * back every file written before it and the layout as it was: nothing is left
 * half done.
 *
 * The layout file is not one of the files the undo puts back: it changes with
 * every node moved, and the undo would then refuse. Undo saves the drawing the
 * diagram had before the untangle instead, and redo the try's, each before
 * the reload that follows it.
 */
import { promises as fs } from 'node:fs';
import { Operation } from '@eclipse-glsp/protocol';
import { ModelState, OperationHandler, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { layoutGeometryOf, saveLayoutGeometry, type LayoutGeometry } from '@dialogram/diagram-server/server/layout-snapshot';
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

async function textOf(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return await readAuthoritativeSourceText(uri);
    } catch {
        return undefined;
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
        const after = layoutGeometryOf(this.modelState.root);
        const before = state?.original ?? after;
        let snapshots: Snapshot[] = [];
        return new ReversibleMultiWorkspaceEditCommand({
            label: 'Untangle',
            outOfBandSnapshots: () => snapshots,
            afterApply: async phase => {
                if (phase === 'undo' || phase === 'redo') {
                    await saveLayoutGeometry(this.modelState, this.layoutPersistence, phase === 'undo' ? before : after);
                }
            },
            computeEdits: async () => {
                const outcome = await this.write(sourceUri, operation.writes ?? [], before, after);
                if (state) {
                    state.applied = { ok: outcome.ok, files: outcome.snapshots.map(each => each.uri.fsPath), ...(outcome.message ? { message: outcome.message } : {}) };
                }
                snapshots = outcome.snapshots;
                return snapshots.length > 0
                    ? snapshots.map(each => ({ uri: each.uri, edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')] }))
                    : undefined;
            }
        });
    }

    /**
     * Save `after` as the layout, then write each order; refused, put back the
     * files written and save `before`. The files that changed, each as it was
     * and as it is.
     */
    private async write(
        sourceUri: string,
        writes: readonly PortOrderWrite[],
        before: LayoutGeometry,
        after: LayoutGeometry
    ): Promise<{ ok: boolean; snapshots: Snapshot[]; message?: string }> {
        const targets = writes.map(each => ({
            ...each,
            uri: vscode.Uri.parse(entityFileOf(this.modelState, sourceUri, { entityType: each.entity, elementId: each.elementId }))
        }));
        const files = [...new Map(targets.map(each => [each.uri.toString(), each.uri] as const)).values()];
        const was = new Map<string, string>();
        for (const uri of files) {
            const text = await textOf(uri);
            if (text === undefined) {
                return { ok: false, snapshots: [], message: `${uri.fsPath} cannot be read: nothing was changed.` };
            }
            was.set(uri.toString(), text);
        }
        await saveLayoutGeometry(this.modelState, this.layoutPersistence, after);
        for (const target of targets) {
            const result = await this.sidecar.sendSidecarOpDetailed(target.uri.toString(), {
                op: this.sidecar.sidecarOp(REORDER_ENTITY_PORTS_OP),
                args: { entity: target.entity, order: target.order }
            });
            if (!result.ok) {
                const putBack = await this.putBack(files, was);
                await saveLayoutGeometry(this.modelState, this.layoutPersistence, before);
                const name = target.uri.fsPath.split(/[\\/]/).pop() ?? target.uri.fsPath;
                const reason = (result.message ?? 'refused').trim().replace(/[.!?]?$/, '.');
                return {
                    ok: false,
                    snapshots: [],
                    message: `The port order of '${target.entity}' in ${name} was not written: ${reason}`
                        + (putBack ? ' Nothing was changed.' : ' The files written before it could not all be put back.')
                };
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
