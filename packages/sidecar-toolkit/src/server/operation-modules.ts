/**
 * Sidecar operation-module assembly.
 *
 * Builds the concrete {@link DiagramOperationModule}(s) the consuming extension passes through the
 * neutral `EditStrategy.operationModules` seam. The single module returned here registers all 16
 * sidecar-backed operation handlers into GLSP's operation-handler multibinding, exactly mirroring
 * the pre-SP2c hardcoded registration set (registration order is irrelevant — each handler responds
 * to a distinct operation kind). The runtime services those handlers depend on (SidecarInvoker,
 * SidecarRuntimeService, SIDECAR_RUNTIME_CONFIG) are bound separately by
 * {@link createSidecarServerModule}, which the consumer contributes as an `additionalServerModule`.
 *
 * diagram-server (core) never imports the toolkit; the wiring flows the other way — the toolkit
 * imports diagram-server's neutral `DiagramOperationModule` contract.
 */

import type { InstanceMultiBinding, OperationHandlerConstructor } from '@eclipse-glsp/server';
import type { DiagramOperationModule } from '@dialogram/diagram-server/server/operation-modules';
import type { SidecarRuntimeConfig } from './sidecar-runtime-config.js';
import { CreateNodeOperationHandler } from './operations/create-node-handler.js';
import { CreateEdgeOperationHandler } from './operations/create-edge-handler.js';
import { DeleteElementOperationHandler } from './operations/delete-handler.js';
import { CutOperationHandler } from './operations/cut-handler.js';
import { ReconnectEdgeOperationHandler } from './operations/reconnect-handler.js';
import { RenameEntityOperationHandler } from './operations/rename-entity-handler.js';
import { UpdateEntityParameterOperationHandler } from './operations/update-entity-parameter-handler.js';
import { UpdateEdgeCapacityOperationHandler } from './operations/update-edge-capacity-handler.js';
import { UpdateDefinitionAnnotationOperationHandler } from './operations/update-definition-annotation-handler.js';
import { UpdateDefinitionParameterOperationHandler } from './operations/update-definition-parameter-handler.js';
import { CreateBoundaryPortOperationHandler } from './operations/create-boundary-port-handler.js';
import { UpdateEntityPortOperationHandler } from './operations/update-entity-port-handler.js';
import { createEntityPortCrudHandlers } from './operations/entity-port-crud-handler.js';
import { PasteOperationHandler } from './operations/paste-handler.js';
import { DuplicateOperationHandler } from './operations/duplicate-handler.js';

/**
 * Build the canonical sidecar-backed operation-handler set for a product
 * {@link SidecarRuntimeConfig}, in the same set/order the pre-SP2c hardcoded registration used.
 *
 * The entity-port CRUD handlers (`EntityPortCrudHandler` / `DeleteEntityPortCrudHandler`) are
 * generated per-config with their product create/delete kinds baked in as plain `operationType`
 * fields — see {@link createEntityPortCrudHandlers}. This is deliberate: GLSP's
 * `DefaultGlobalActionProvider` reads `.operationType` off a `new constructor()` instance built
 * WITHOUT dependency injection, so those kinds must be readable without a resolved `sidecar`.
 */
function sidecarOperationHandlers(cfg: SidecarRuntimeConfig): OperationHandlerConstructor[] {
    return [
        CreateNodeOperationHandler,
        CreateEdgeOperationHandler,
        DeleteElementOperationHandler,
        CutOperationHandler,
        ReconnectEdgeOperationHandler,
        RenameEntityOperationHandler,
        UpdateEntityParameterOperationHandler,
        UpdateEdgeCapacityOperationHandler,
        UpdateDefinitionAnnotationOperationHandler,
        UpdateDefinitionParameterOperationHandler,
        CreateBoundaryPortOperationHandler,
        UpdateEntityPortOperationHandler,
        ...createEntityPortCrudHandlers(cfg.operationKinds),
        PasteOperationHandler,
        DuplicateOperationHandler
    ];
}

/**
 * Build the sidecar {@link DiagramOperationModule} set for a product {@link SidecarRuntimeConfig}.
 * Returns a single module registering all 16 sidecar handlers. The entity-port CRUD handlers carry
 * their product create/delete kinds as plain fields (baked in via {@link createEntityPortCrudHandlers});
 * the remaining handlers use fixed protocol operation kinds.
 */
export function createSidecarOperationModules(cfg: SidecarRuntimeConfig): DiagramOperationModule[] {
    const handlers = sidecarOperationHandlers(cfg);
    const module: DiagramOperationModule = {
        __diagramOperationModule: true,
        configure(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
            for (const handler of handlers) {
                binding.add(handler);
            }
        }
    };
    return [module];
}
