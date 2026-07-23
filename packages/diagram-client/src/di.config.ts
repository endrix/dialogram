/**
 * Workflow Diagram Client DI Configuration — back-compat surface.
 *
 * The former monolith `workflowDiagramModule` + `createCalDiagramContainer` have
 * been split (SP3 Task 2) into a neutral base (`base.module.ts`) plus the stock
 * `stock-views.module.ts` / `stock-features.module.ts`, composed by
 * `createDiagramContainer` (`container.ts`). This file preserves the old export
 * names so existing import paths keep working; new code should import from
 * `container.ts` / the `*.module.ts` files directly.
 */
import { Container, ContainerModule } from 'inversify';
import { ContainerConfiguration } from '@eclipse-glsp/client';
import { diagramBaseModule } from './base.module';
import { workflowViewsModule } from './stock-views.module';
import { workflowFeaturesModule } from './stock-features.module';
import { createDiagramContainer } from './container';

export { diagramBaseModule } from './base.module';
export { workflowViewsModule } from './stock-views.module';
export { workflowFeaturesModule } from './stock-features.module';
export { createDiagramContainer, composeDiagramModules } from './container';
export type { DiagramContainerOptions } from './container';

type ModuleRegistry = (bind: unknown, unbind: unknown, isBound: unknown, rebind: unknown) => void;

/**
 * Back-compat alias for the former monolith: a single `ContainerModule` that
 * replays the neutral base, stock views, and stock features in the same order
 * `createDiagramContainer` composes them.
 */
export const workflowDiagramModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    for (const module of [diagramBaseModule, workflowViewsModule, workflowFeaturesModule]) {
        (module as unknown as { registry: ModuleRegistry }).registry(bind, unbind, isBound, rebind);
    }
});

/** The stock diagram client id, best-effort from the host-injected identifier. */
function stockClientId(): string {
    const identifier = (globalThis as { diagramIdentifier?: { clientId?: unknown } })?.diagramIdentifier;
    const clientId = identifier?.clientId;
    return typeof clientId === 'string' ? clientId : '';
}

/**
 * Back-compat wrapper for the former container factory. `container` is ignored —
 * `createDiagramContainer` owns container creation — but the signature is kept so
 * existing callers still compile.
 *
 * @deprecated Use `createDiagramContainer({ clientId, features })` directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function createCalDiagramContainer(_container: Container, ...containerConfiguration: ContainerConfiguration): any {
    return createDiagramContainer(
        { clientId: stockClientId(), features: [workflowViewsModule, workflowFeaturesModule] },
        ...containerConfiguration
    );
}
