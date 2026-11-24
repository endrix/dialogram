/**
 * An untangle's port orders written into the source by the sidecar, where it
 * has the op that rewrites the order a definition declares its ports in
 * (`reorderEntityPorts`). A producer offers it only where that order means
 * nothing else; without it the untangle keeps every order with the diagram's
 * layout (source-port-order-writer.ts in diagram-server).
 */
import type { ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import type { PortOrderWrite, SourcePortOrderWriter } from '@dialogram/diagram-server/untangle/source-port-order-writer';
import { entityFileOf, usesAcrossProject } from './entity-port-write';
import { SidecarInvoker } from './sidecar-invoker';

/** The sidecar op that writes a definition's port order, where the producer has one. */
export const REORDER_ENTITY_PORTS_OP = 'reorderEntityPorts';

function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

@injectable()
export class SidecarPortOrderWriter implements SourcePortOrderWriter {
    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    canWrite(sourceUri: string): Promise<boolean> {
        return this.sidecar.supportsOp(sourceUri, REORDER_ENTITY_PORTS_OP);
    }

    fileOf(modelState: ModelState, sourceUri: string, write: PortOrderWrite): string {
        return entityFileOf(modelState, sourceUri, { entityType: write.entity, elementId: write.elementId });
    }

    async write(_sourceUri: string, fileUri: string, write: PortOrderWrite): Promise<{ ok: boolean; message?: string }> {
        const result = await this.sidecar.sendSidecarOpDetailed(fileUri, {
            op: this.sidecar.sidecarOp(REORDER_ENTITY_PORTS_OP),
            args: { entity: write.entity, order: write.order }
        });
        return result.ok ? { ok: true } : { ok: false, message: result.message ?? 'refused' };
    }

    async usedElsewhere(sourceUri: string, fileUri: string, entity: string): Promise<string[]> {
        const uses = await usesAcrossProject(this.sidecar, sourceUri, fileUri, entity);
        const here = vscode.Uri.parse(sourceUri).toString();
        return (uses?.usedIn ?? [])
            .filter(use => vscode.Uri.file(use.file).toString() !== here)
            .map(use => `${use.workflow} (${fileName(use.file)})`);
    }
}
