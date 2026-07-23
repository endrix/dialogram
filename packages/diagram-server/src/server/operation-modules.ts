/**
 * Neutral server-side operation-module contract.
 *
 * The `EditStrategy.operationModules` seam (in `@dialogram/shared`) carries opaque
 * {@link DiagramOperationModuleHandle}s so `shared` stays browser-safe. This file defines the
 * concrete contract those handles resolve to: an object that knows how to register its operation
 * handlers into GLSP's operation-handler multibinding. The consuming extension supplies the
 * concrete modules (its toolkit builds them); core stays product-neutral and only calls
 * {@link DiagramOperationModule.configure} from inside `configureOperationHandlers`.
 */

import type { InstanceMultiBinding, OperationHandlerConstructor } from '@eclipse-glsp/server';
import type { DiagramOperationModuleHandle } from '@dialogram/shared';

/**
 * A consumer-supplied bundle of operation handlers. `configure` is invoked from within
 * `GModelDiagramModule.configureOperationHandlers`, receiving the same
 * `InstanceMultiBinding<OperationHandlerConstructor>` GLSP hands that method (there is no
 * additional binding context in the GLSP signature). Implementations register their handler
 * constructors with `binding.add(...)`; any singleton/self bindings the handlers depend on are
 * supplied separately through the server-level DI modules the consumer contributes.
 */
export interface DiagramOperationModule extends DiagramOperationModuleHandle {
    configure(binding: InstanceMultiBinding<OperationHandlerConstructor>): void;
}

/** Narrow an opaque {@link DiagramOperationModuleHandle} to the concrete {@link DiagramOperationModule}. */
export function isDiagramOperationModule(candidate: unknown): candidate is DiagramOperationModule {
    return (
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as { __diagramOperationModule?: unknown }).__diagramOperationModule === true &&
        typeof (candidate as { configure?: unknown }).configure === 'function'
    );
}
