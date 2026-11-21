/**
 * The neutral base answers GLSP's export with the diagram as drawn: where
 * GLSP's default PNG and SVG exporters are bound (its export module, loaded by
 * default), the base binds Dialogram's in their place, for every product, so
 * the MCP `diagram-png` / `diagram-svg` tools get a picture the webview can
 * draw (diagram-picture.ts).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import {
    TYPES,
    SetModelCommand,
    FitToScreenCommand,
    EditorContextService,
    DefaultPngDiagramExporter,
    DefaultSvgDiagramExporter
} from '@eclipse-glsp/client';
import { diagramBaseModule } from '../src/base.module';
import { DiagramPngExporter, DiagramSvgExporter } from '../src/diagram-picture';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

/** The base loaded over the GLSP bindings it rebinds or injects, GLSP's exporters among them. */
function bootBase(withExporters: boolean): Container {
    const container = new Container({ defaultScope: 'Singleton' });
    container.bind(TYPES.ILogger).toConstantValue({});
    container.bind(TYPES.LogLevel).toConstantValue(2);
    container.bind(SetModelCommand).toConstantValue(class {});
    container.bind(FitToScreenCommand).toConstantValue(class {});
    container.bind(TYPES.IActionDispatcher).toConstantValue({ dispatch: () => undefined });
    container.bind(EditorContextService).toConstantValue({});
    container.bind(TYPES.ViewerOptions).toConstantValue({});
    container.bind(TYPES.IAsyncClipboardService).toConstantValue({});
    container.bind(TYPES.ICopyPasteHandler).toConstantValue({});
    if (withExporters) {
        container.bind(DefaultPngDiagramExporter).toSelf().inSingletonScope();
        container.bind(DefaultSvgDiagramExporter).toSelf().inSingletonScope();
        container.bind('IDiagramExporter').toService(DefaultPngDiagramExporter);
        container.bind('IDiagramExporter').toService(DefaultSvgDiagramExporter);
    }
    container.load(diagramBaseModule);
    return container;
}

describe("GLSP's exporters", () => {
    it("are Dialogram's, the diagram as drawn, where GLSP binds its own", () => {
        const container = bootBase(true);
        const exporters = container.getAll<{ format: string }>('IDiagramExporter');
        expect(exporters.map(e => e.constructor)).toEqual([DiagramPngExporter, DiagramSvgExporter]);
        expect(exporters.map(e => e.format)).toEqual(['png', 'svg']);
    });

    it('are left unbound where GLSP binds none', () => {
        const container = bootBase(false);
        expect(container.isBound(DefaultPngDiagramExporter)).toBe(false);
        expect(container.isBound(DefaultSvgDiagramExporter)).toBe(false);
    });
});
