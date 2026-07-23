/**
 * Read-Only Source Model Storage
 *
 * `WorkflowSourceModelStorage` variant bound when a diagram session is constructed with
 * `WorkflowDiagramModule({ edits: 'read-only' })`. Per the v2 seam spec, a read-only session must
 * "bind no operation handlers and a no-op saveSourceModel" -- `WorkflowDiagramModule` already skips
 * `configureOperationHandlers` for that case (see `diagram-module.ts`), but the storage's
 * `saveSourceModel` still wrote the document back to disk regardless of edit strategy. This
 * subclass overrides only that one method; everything else (graph loading, diagnostics, overlays)
 * is inherited unchanged from `WorkflowSourceModelStorage`, so the editable path stays
 * byte-identical.
 */

import 'reflect-metadata';

import { injectable } from 'inversify';
import { SaveModelAction } from '@eclipse-glsp/protocol';
import { WorkflowSourceModelStorage } from './source-model-storage';

@injectable()
export class ReadOnlySourceModelStorage extends WorkflowSourceModelStorage {

    /**
     * No-op: a read-only session never persists edits back to the source document.
     */
    override async saveSourceModel(_action: SaveModelAction): Promise<void> {
        // Intentionally empty.
    }
}
