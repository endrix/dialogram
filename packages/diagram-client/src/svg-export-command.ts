/**
 * Exporting the diagram to SVG, as a command.
 *
 * The extension's command and the palette's button both end here: the rendered
 * diagram is extracted (svg-export.ts) and handed to the extension, which asks
 * where to save it. The extension asks for the export with
 * `dialogram.svg.extract`, since only the webview holds the rendered SVG.
 */
import { extractSvg, renderedDiagram } from './svg-export';
import { VscodeUi } from './vscode-ui';

export const SVG_EXTRACT_REQUEST = 'dialogram.svg.extract';
export const SVG_EXTRACTED = 'dialogram.svg.extracted';
export const SVG_EXTRACT_FAILED = 'dialogram.svg.failed';

/** The name the file is offered under: the workflow shown, or the diagram. */
function diagramLabel(): string {
    try {
        const ctx = (globalThis as any).__calDiagramContext as { workflowName?: string } | undefined;
        return ctx?.workflowName || 'diagram';
    } catch {
        return 'diagram';
    }
}

/** Extract the rendered diagram and hand it to the extension to save. */
export function exportDiagramSvg(): void {
    const rendered = renderedDiagram();
    const extracted = rendered ? extractSvg(rendered.graph, diagramLabel()) : undefined;
    if (!extracted) {
        VscodeUi.instance.post({ type: SVG_EXTRACT_FAILED, payload: { reason: 'The diagram is not rendered.' } });
        return;
    }
    VscodeUi.instance.post({
        type: SVG_EXTRACTED,
        payload: { svg: extracted.svg, name: extracted.name, elementCount: extracted.elementCount }
    });
}

/** Answer the extension's request for an export. Installed once per webview. */
export function installSvgExportRequests(): () => void {
    return VscodeUi.instance.onMessage(message => {
        if (message && typeof message === 'object' && (message as { type?: string }).type === SVG_EXTRACT_REQUEST) {
            exportDiagramSvg();
        }
    });
}
