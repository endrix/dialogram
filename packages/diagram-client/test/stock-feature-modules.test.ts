/**
 * A product's own webview bundle starts the stock diagram with its modules
 * added: `startStockDiagram({ features })` composes `stockFeatureModules(features)`.
 * The stock bundle is the same call with nothing added, so it must keep the
 * composition the parity baseline was captured from, and a product's modules
 * must come after every stock one, where a `rebind` replaces a stock binding.
 */
import { describe, expect, it } from 'vitest';
import { ContainerModule } from 'inversify';
import { composeDiagramModules, stockFeatureModules } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { workflowViewsModule } from '../src/stock-views.module';
import { workflowFeaturesModule } from '../src/stock-features.module';

describe('the stock diagram, with what a product adds', () => {
    it('is the stock views then the stock feature UI when nothing is added', () => {
        expect(stockFeatureModules()).toEqual([workflowViewsModule, workflowFeaturesModule]);
        expect(composeDiagramModules({ clientId: 'c', features: stockFeatureModules() })).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule
        ]);
    });

    it('loads the product’s modules last, in the order given', () => {
        const first = new ContainerModule(() => undefined);
        const second = new ContainerModule(() => undefined);
        expect(composeDiagramModules({ clientId: 'c', features: stockFeatureModules([first, second]) })).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule,
            first,
            second
        ]);
    });

    it('does not keep the caller’s array', () => {
        const added = [new ContainerModule(() => undefined)];
        const modules = stockFeatureModules(added);
        modules.push(new ContainerModule(() => undefined));
        expect(added).toHaveLength(1);
    });
});
