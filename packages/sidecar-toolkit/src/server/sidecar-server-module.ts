/**
 * Sidecar server DI module.
 *
 * The profile assembler builds this from a product {@link SidecarRuntimeConfig}
 * and hands it to the diagram server as an additional server module. It binds the
 * runtime services the sidecar operation handlers depend on; the handlers
 * themselves are registered through the `EditStrategy.operationModules` seam (see
 * `createSidecarOperationModules`). diagram-server (core) never imports the
 * toolkit; the wiring flows the other way.
 */

import { ContainerModule } from 'inversify';
import {
    type SidecarRuntimeConfig,
    SIDECAR_RUNTIME_CONFIG,
    SidecarRuntimeService
} from './sidecar-runtime-config';
import { SidecarInvoker } from './operations/sidecar-invoker';
import { RenameEntityOperationHandler } from './operations/rename-entity-handler';
import { SidecarPortOrderWriter } from './operations/sidecar-port-order-writer';
import { SOURCE_PORT_ORDER_WRITER } from '@dialogram/diagram-server/untangle/source-port-order-writer';

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
        // An untangle's port orders go into the source where the sidecar has
        // the op for it (asked per diagram); the layout keeps the rest. A
        // read-only profile has no sidecar to ask: its layout keeps them all.
        if (!cfg.readOnly && !isBound(SOURCE_PORT_ORDER_WRITER)) {
            bind(SOURCE_PORT_ORDER_WRITER).to(SidecarPortOrderWriter).inSingletonScope();
        }
    });
}
