/**
 * A product's own webview bundle starts the stock diagram with its modules
 * added: `startStockDiagram({ features })` composes `stockDiagramOptions`.
 * The stock bundle is the same call with nothing added, so it must keep the
 * composition the parity baseline was captured from, and a product's modules
 * must come after the stock views and feature UI, where a `rebind` replaces a
 * stock feature binding.
 */
import { describe, expect, it } from 'vitest';
import { ContainerModule } from 'inversify';
import { composeDiagramModules, stockDiagramOptions } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { workflowViewsModule } from '../src/stock-views.module';
import { workflowFeaturesModule } from '../src/stock-features.module';

describe('the stock diagram, with what a product adds', () => {
    it('is the base, the stock views and the stock feature UI when nothing is added', () => {
        expect(composeDiagramModules(stockDiagramOptions('c'))).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule
        ]);
    });

    it('loads the product’s modules after the stock ones, in the order given', () => {
        const first = new ContainerModule(() => undefined);
        const second = new ContainerModule(() => undefined);
        expect(composeDiagramModules(stockDiagramOptions('c', [first, second]))).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule,
            first,
            second
        ]);
    });

    it('takes a read-only list and does not keep it', () => {
        const added: readonly ContainerModule[] = Object.freeze([new ContainerModule(() => undefined)]);
        const options = stockDiagramOptions('c', added);
        options.features.push(new ContainerModule(() => undefined));
        expect(added).toHaveLength(1);
    });

    it('refuses a stock module passed again, instead of a blank webview', () => {
        for (const stock of [diagramBaseModule, workflowViewsModule, workflowFeaturesModule]) {
            expect(() => stockDiagramOptions('c', [stock])).toThrow(/must not repeat a stock module/);
        }
    });
});
