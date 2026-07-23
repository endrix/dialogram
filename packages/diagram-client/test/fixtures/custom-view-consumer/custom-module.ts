/**
 * The consumer feature `ContainerModule` — the unit an external consumer hands
 * to `createDiagramContainer({ features: [customDemoModule] })`. It registers one
 * custom node type + view via GLSP's `configureModelElement`, exactly the
 * `(typeId, ModelCtor, ViewCtor)` tuple mlir's `mlirDiagramModule` uses.
 *
 * DI-decorated modules compose INSIDE the consumer's own webview bundle at build
 * time (one inversify realm per bundle) — this module is authored and bundled
 * next to the library source it consumes, never constructed host-side and passed
 * across the extension API.
 */
import { ContainerModule } from 'inversify';
import { configureModelElement } from '@eclipse-glsp/client';
import { CUSTOM_DEMO_NODE_TYPE, CustomDemoNode } from './custom-node';
import { CustomDemoNodeView } from './custom-node-view';

export const customDemoModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };
    configureModelElement(context, CUSTOM_DEMO_NODE_TYPE, CustomDemoNode, CustomDemoNodeView);
});
