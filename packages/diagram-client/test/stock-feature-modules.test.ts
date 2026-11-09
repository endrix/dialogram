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
import { agentUiModule, stockAnnotationEditors, stockAnnotationTemplates, stockNodeSections } from '../src/agent-ui';
import { recordModuleRegistrations, sortEntries } from './container-registration-recorder';

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

describe('the agent workflow UI as a module of its own', () => {
    it('binds the @tool and @agent editors, the agent sections and the @tool and @viewer templates', () => {
        expect(recordModuleRegistrations([agentUiModule])).toEqual(sortEntries([
            { op: 'bind', id: 'Symbol(dialogram.AnnotationEditor)', to: 'const:ToolAnnotationEditor' },
            { op: 'bind', id: 'Symbol(dialogram.AnnotationEditor)', to: 'const:AgentAnnotationEditor' },
            { op: 'bind', id: 'Symbol(dialogram.NodeSectionContribution)', to: 'const:AgentNodeSections' },
            { op: 'bind', id: 'Symbol(dialogram.AnnotationTemplate)', to: 'const:ToolAnnotationTemplate' },
            { op: 'bind', id: 'Symbol(dialogram.AnnotationTemplate)', to: 'const:ViewerAnnotationTemplate' }
        ]));
    });

    it('binds the editors and templates in the order the panel and the wizard show them', () => {
        expect(stockAnnotationEditors().map(e => e.annotationName)).toEqual(['tool', 'agent']);
        expect(stockNodeSections().map(s => s.id)).toEqual(['agent']);
        expect(stockAnnotationTemplates().map(t => t.annotationName)).toEqual(['tool', 'viewer']);
    });
});
