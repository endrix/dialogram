/**
 * A picture of the diagram, as it is drawn.
 *
 * Two readers ask for one. The agent asks through the diagram's MCP tools
 * (`diagram-png`, `diagram-svg`): the GLSP server sends the client a
 * `RequestExportAction`, and the exporters below answer it. The person asks
 * from the chat, to attach the picture to a message (chat-panel-integrated.ts).
 * Both get the diagram on screen, as the export saves it (svg-export.ts): the
 * rendered SVG with its computed styles, at 1:1, with all its text; or the
 * surface's own image, where a surface is mounted and offers one.
 *
 * GLSP's own exporters draw a hidden copy of the model instead, and load it
 * into an image through a `blob:` URL, which the webview's policy refuses: the
 * agent's every call failed. Here the SVG is loaded through a `data:` URL,
 * which the policy allows.
 */
import { injectable } from 'inversify';
import type { DiagramExporter, PngExportOptions } from '@eclipse-glsp/client';
import { extractSvg, renderedDiagram } from './svg-export';
import { mountedSurfaceHost, type DiagramSurfaceHost } from './diagram-surface-host';
import { PNG_SIGNATURE, bytesToBase64, diagramLabel } from './svg-export-command';

/**
 * The longer side of a picture nobody gave a size: the diagram at 1:1, scaled
 * down to this. A vision model reads at most about this much (larger is shrunk
 * before it is read), and a picture of a large diagram at 1:1 is megabytes on
 * its way through the server.
 */
export const DEFAULT_MAX_SIDE = 2000;

/** The largest side asked for: what the MCP tool's schema allows. */
export const MAX_SIDE = 8192;

/** What a picture may be asked to be: a size, or a scale of the diagram's own. */
export interface PictureSize {
    width?: number;
    height?: number;
    /** A multiple of the diagram's size at 1:1; ignored when a width or height is given. */
    scale?: number;
}

export interface DiagramPicture {
    /** The PNG, base64. */
    data: string;
    width: number;
    height: number;
}

/**
 * The size to draw a picture of `natural` at: both sides given, as given; one,
 * the other kept in proportion; none, the diagram at `scale` (1:1 by default),
 * and with neither size nor scale, no side longer than {@link DEFAULT_MAX_SIDE}.
 * No side is longer than {@link MAX_SIDE}, nor shorter than one pixel.
 */
export function pictureSize(natural: { width: number; height: number }, asked: PictureSize = {}): { width: number; height: number } {
    const w = Math.max(1, natural.width);
    const h = Math.max(1, natural.height);
    let width: number;
    let height: number;
    if (asked.width !== undefined && asked.height !== undefined) {
        [width, height] = [asked.width, asked.height];
    } else if (asked.width !== undefined) {
        [width, height] = [asked.width, (asked.width * h) / w];
    } else if (asked.height !== undefined) {
        [width, height] = [(asked.height * w) / h, asked.height];
    } else {
        const scale = asked.scale ?? 1;
        [width, height] = [w * scale, h * scale];
        const longer = Math.max(width, height);
        if (asked.scale === undefined && longer > DEFAULT_MAX_SIDE) {
            [width, height] = [(width * DEFAULT_MAX_SIDE) / longer, (height * DEFAULT_MAX_SIDE) / longer];
        }
    }
    const longer = Math.max(width, height);
    if (longer > MAX_SIDE) {
        [width, height] = [(width * MAX_SIDE) / longer, (height * MAX_SIDE) / longer];
    }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * The diagram as drawn, as an SVG document; it fails, saying why, when there
 * is none. A window the browser does not draw (minimized, or nowhere on a
 * screen) lays nothing out: its diagram measures nothing, and its picture
 * would be an empty frame.
 */
export function diagramSvg(): string {
    const rendered = renderedDiagram();
    if (!rendered) {
        throw new Error('The diagram is not drawn yet.');
    }
    const box = rendered.graph.getBBox();
    if (!(box.width > 0) || !(box.height > 0)) {
        throw new Error('Nothing is drawn: the diagram is empty, or its window is not on screen.');
    }
    const extracted = extractSvg(rendered.graph, diagramLabel());
    if (!extracted) {
        throw new Error('The diagram is not drawn yet.');
    }
    return extracted.svg;
}

/** The size an SVG document says it is (its root's width and height). */
export function svgSize(svg: string): { width: number; height: number } {
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1]);
    const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1]);
    if (!(width > 0) || !(height > 0)) {
        throw new Error('The drawn diagram has no size.');
    }
    return { width, height };
}

/** `svg` with its root drawn at `size`: its viewBox keeps what it shows. */
export function svgAtSize(svg: string, size: { width: number; height: number }): string {
    return svg.replace(/<svg\b[^>]*>/, root =>
        root.replace(/\swidth="[^"]*"/, ` width="${size.width}"`).replace(/\sheight="[^"]*"/, ` height="${size.height}"`)
    );
}

/** Draws an image (a `data:` URL) at a size, and answers the PNG, base64. */
export type Rasterize = (src: string, size: { width: number; height: number }) => Promise<string>;

/** Load `src` into an image and draw it on a canvas of `size`: the browser's own raster. */
export const rasterizeInTheBrowser: Rasterize = async (src, size) => {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The diagram could not be drawn as an image.'));
        image.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('No canvas to draw the diagram on.');
    }
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
};

/** The width and height a PNG says it is, in its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A picture of the diagram, as a PNG: the surface's image where a surface
 * offers one, else the drawn SVG, rastered. Of the size asked (see
 * {@link pictureSize}); a surface's image nobody gave a size is as it came,
 * unless it is longer than {@link DEFAULT_MAX_SIDE}.
 */
export async function diagramPng(
    asked: PictureSize = {},
    rasterize: Rasterize = rasterizeInTheBrowser,
    host: DiagramSurfaceHost | undefined = mountedSurfaceHost()
): Promise<DiagramPicture> {
    if (host?.exportsImage()) {
        const bytes = await host.exportImage();
        if (!bytes || bytes.length < 24 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
            throw new Error('The surface gave no PNG image.');
        }
        const natural = pngSize(bytes);
        const data = bytesToBase64(bytes);
        const size = pictureSize(natural, asked);
        if (size.width === natural.width && size.height === natural.height) {
            return { data, ...natural };
        }
        return { data: await rasterize(`data:image/png;base64,${data}`, size), ...size };
    }
    const svg = diagramSvg();
    const size = pictureSize(svgSize(svg), asked);
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgAtSize(svg, size))}`;
    return { data: await rasterize(src, size), ...size };
}

/** A size in the options of a request, when it is one. */
function sizeOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The PNG an MCP `diagram-png` call asks for, through GLSP's export: in place
 * of GLSP's default exporter (base.module.ts). The model GLSP hands over is the
 * hidden copy; the picture is of the diagram as it is drawn.
 */
@injectable()
export class DiagramPngExporter implements DiagramExporter<PngExportOptions & { scale?: number }> {
    readonly format = 'png';
    readonly mimeType = 'image/png';
    readonly encoding = 'base64';

    /** Draws the picture; a test stands one in. */
    protected draw: (asked: PictureSize) => Promise<DiagramPicture> = asked => diagramPng(asked);

    async export(_root: unknown, options: PngExportOptions & { scale?: number } = {}): Promise<string> {
        const picture = await this.draw({ width: sizeOf(options.width), height: sizeOf(options.height), scale: sizeOf(options.scale) });
        return picture.data;
    }
}

/** The SVG an MCP `diagram-svg` call asks for: the diagram as the export saves it. */
@injectable()
export class DiagramSvgExporter implements DiagramExporter {
    readonly format = 'svg';
    readonly mimeType = 'image/svg+xml';
    readonly encoding = 'text';

    async export(): Promise<string> {
        return diagramSvg();
    }
}
