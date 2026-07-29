/**
 * Sidecar server DI module.
 *
 * The consuming extension (extension-core's TRANSITIONAL diagram adapter) builds this from a product
 * {@link SidecarRuntimeConfig} and hands it to diagram-server's neutral `createWorkflowServerModules`
 * via `additionalServerModules`. It binds the runtime services the sidecar operation handlers depend
 * on; the handlers themselves are registered through the `EditStrategy.operationModules` seam (see
 * `createSidecarOperationModules`). diagram-server (core) never imports the toolkit; the wiring flows
 * the other way.
 */

import { ContainerModule } from 'inversify';
import {
    type SidecarRuntimeConfig,
    SIDECAR_RUNTIME_CONFIG,
    SidecarRuntimeService
} from './sidecar-runtime-config';
import { SidecarInvoker } from './operations/sidecar-invoker';
import { RenameEntityOperationHandler } from './operations/rename-entity-handler';

/**
 * A DI module binding the sidecar runtime config, its injectable service, and the sidecar invoker
 * the moved operation handlers depend on. Passed to `createWorkflowServerModules` as one of the
 * `additionalServerModules`.
 */
export function createSidecarServerModule(cfg: SidecarRuntimeConfig): ContainerModule {
    return new ContainerModule((bind, _unbind, isBound) => {
        if (!isBound(SIDECAR_RUNTIME_CONFIG)) {
            bind(SIDECAR_RUNTIME_CONFIG).toConstantValue(cfg);
        }
        if (!isBound(SidecarRuntimeService)) {
            bind(SidecarRuntimeService).toSelf().inSingletonScope();
        }
        if (!isBound(SidecarInvoker)) {
            bind(SidecarInvoker).toSelf().inSingletonScope();
        }
        // Self-bind the rename handler so ApplyLabelEditRenameHandler can `@inject` it and route
        // MCP label edits through the same reversible rename path (mirrors how server-module.ts
        // self-binds WorkflowRerouteEdgesAvoidOverlapsOperationHandler for cross-handler injection).
        // It stays in the operation-handler constructor list too (distinct service identifier).
        if (!isBound(RenameEntityOperationHandler)) {
            bind(RenameEntityOperationHandler).toSelf().inSingletonScope();
        }
    });
}
