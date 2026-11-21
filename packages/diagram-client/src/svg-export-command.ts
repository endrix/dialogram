/**
 * Exporting the diagram, as a command.
 *
 * The extension's command and the palette's button both end here: the rendered
 * diagram is extracted (svg-export.ts) and handed to the extension, which asks
 * where to save it. The extension asks for the export with
 * `dialogram.svg.extract`, since only the webview holds the rendered SVG.
 *
 * When a diagram surface is mounted and offers an image (`exportImage`), the
 * export is that image, as a PNG: the SVG holds nothing of what the surface
 * draws, so its export would be an empty picture. The graph's own elements
 * drawn over the surface are not composited into it; the surface's image is
 * what it says it is.
 */
import { extractSvg, renderedDiagram } from './svg-export';
import { VscodeUi } from './vscode-ui';
import { mountedSurfaceHost, type DiagramSurfaceHost } from './diagram-surface-host';

export const SVG_EXTRACT_REQUEST = 'dialogram.svg.extract';
export const SVG_EXTRACTED = 'dialogram.svg.extracted';
export const SVG_EXTRACT_FAILED = 'dialogram.svg.failed';
/** A surface's image, as base64 PNG bytes, for the extension to save. */
export const PNG_EXTRACTED = 'dialogram.png.extracted';

/** The name the file is offered under: the workflow shown, or the diagram. */
export function diagramLabel(): string {
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

/** Base64 of bytes, in chunks: one `String.fromCharCode` over megabytes overflows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** The PNG signature: what a surface's bytes must start with to be saved as one. */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Export the diagram: the surface's image when one is mounted and offers it,
 * else the SVG. Resolves once the message to the extension is posted.
 */
export async function exportDiagram(host: DiagramSurfaceHost | undefined = mountedSurfaceHost()): Promise<void> {
    if (!host?.exportsImage()) {
        exportDiagramSvg();
        return;
    }
    let bytes: Uint8Array | undefined;
    try {
        bytes = await host.exportImage();
    } catch (error) {
        VscodeUi.instance.post({
            type: SVG_EXTRACT_FAILED,
            payload: { format: 'PNG', reason: error instanceof Error ? error.message : String(error) }
        });
        return;
    }
    if (!bytes || bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, i) => bytes![i] !== byte)) {
        VscodeUi.instance.post({ type: SVG_EXTRACT_FAILED, payload: { format: 'PNG', reason: 'The surface gave no PNG image.' } });
        return;
    }
    VscodeUi.instance.post({ type: PNG_EXTRACTED, payload: { data: bytesToBase64(bytes), name: diagramLabel(), byteLength: bytes.length } });
}

/** Answer the extension's request for an export. Installed once per webview. */
export function installSvgExportRequests(): () => void {
    return VscodeUi.instance.onMessage(message => {
        if (message && typeof message === 'object' && (message as { type?: string }).type === SVG_EXTRACT_REQUEST) {
            void exportDiagram();
        }
    });
}
