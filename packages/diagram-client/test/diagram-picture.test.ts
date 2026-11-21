// @vitest-environment happy-dom
/**
 * A picture of the diagram (diagram-picture.ts), for the MCP `diagram-png`
 * tool and the chat: of the size asked, else the diagram at 1:1 no longer than
 * 2000 px; the drawn SVG rastered from a `data:` URL (the webview refuses
 * `blob:`), or the surface's own image. The exporters GLSP asks answer with it.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

const extracted = vi.hoisted(() => ({ svg: undefined as string | undefined, box: { width: 800, height: 400 } }));
vi.mock('../src/svg-export', () => ({
    renderedDiagram: () => (extracted.svg ? { svgRoot: {}, graph: { getBBox: () => extracted.box } } : undefined),
    extractSvg: () => (extracted.svg ? { svg: extracted.svg, name: 'diagram', elementCount: 3 } : undefined)
}));
vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

import {
    DEFAULT_MAX_SIDE,
    DiagramPngExporter,
    DiagramSvgExporter,
    diagramPng,
    diagramSvg,
    pictureSize,
    svgAtSize,
    svgSize,
    type Rasterize
} from '../src/diagram-picture';

const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="824" height="424" viewBox="-12 -12 824 424"><rect/></svg>\n';

/** A raster that records what it was asked to draw. */
function recordingRaster(): Rasterize & { calls: Array<{ src: string; size: { width: number; height: number } }> } {
    const calls: Array<{ src: string; size: { width: number; height: number } }> = [];
    const raster = (async (src: string, size: { width: number; height: number }) => {
        calls.push({ src, size });
        return 'UE5H';
    }) as Rasterize & { calls: typeof calls };
    raster.calls = calls;
    return raster;
}

/** PNG bytes of a given size: the signature and an IHDR header. */
function pngBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

afterEach(() => {
    extracted.svg = undefined;
    extracted.box = { width: 800, height: 400 };
});

describe('the size of a picture', () => {
    it('is the diagram at 1:1 when nobody asks', () => {
        expect(pictureSize({ width: 824, height: 424 })).toEqual({ width: 824, height: 424 });
    });

    it('is no longer than 2000 px on its longer side when nobody asks', () => {
        expect(pictureSize({ width: 5000, height: 1000 })).toEqual({ width: DEFAULT_MAX_SIDE, height: 400 });
        expect(pictureSize({ width: 1000, height: 4000 })).toEqual({ width: 500, height: DEFAULT_MAX_SIDE });
    });

    it('is the diagram at the scale asked, past 2000 px too', () => {
        expect(pictureSize({ width: 1500, height: 500 }, { scale: 2 })).toEqual({ width: 3000, height: 1000 });
        expect(pictureSize({ width: 800, height: 400 }, { scale: 0.5 })).toEqual({ width: 400, height: 200 });
    });

    it('keeps the proportion when one side is asked', () => {
        expect(pictureSize({ width: 800, height: 400 }, { width: 400 })).toEqual({ width: 400, height: 200 });
        expect(pictureSize({ width: 800, height: 400 }, { height: 100 })).toEqual({ width: 200, height: 100 });
    });

    it('is as asked when both sides are, the scale aside', () => {
        expect(pictureSize({ width: 800, height: 400 }, { width: 300, height: 300, scale: 3 })).toEqual({ width: 300, height: 300 });
    });

    it('is never longer than 8192 px, nor shorter than one', () => {
        expect(pictureSize({ width: 4000, height: 2000 }, { scale: 4 })).toEqual({ width: 8192, height: 4096 });
        expect(pictureSize({ width: 4000, height: 2 }, { width: 100 })).toEqual({ width: 100, height: 1 });
    });
});

describe('the SVG drawn', () => {
    it('says its size', () => {
        expect(svgSize(SVG)).toEqual({ width: 824, height: 424 });
    });

    it('is resized on its root only, its viewBox kept', () => {
        const resized = svgAtSize(SVG, { width: 412, height: 212 });
        expect(resized).toContain('width="412" height="212" viewBox="-12 -12 824 424"');
        expect(resized).toContain('<rect/>');
    });

    it('fails, saying so, before the diagram is drawn', () => {
        expect(() => diagramSvg()).toThrow('The diagram is not drawn yet.');
    });

    it('fails, saying so, when nothing is laid out: an empty frame is no picture', () => {
        extracted.svg = SVG;
        extracted.box = { width: 0, height: 0 };
        expect(() => diagramSvg()).toThrow('Nothing is drawn: the diagram is empty, or its window is not on screen.');
    });
});

describe('a picture of the diagram', () => {
    it('rasters the drawn SVG from a data: URL, at the size worked out', async () => {
        extracted.svg = SVG;
        const raster = recordingRaster();
        const picture = await diagramPng({ width: 412 }, raster, undefined);
        expect(picture).toEqual({ data: 'UE5H', width: 412, height: 212 });
        expect(raster.calls).toHaveLength(1);
        expect(raster.calls[0].src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
        expect(decodeURIComponent(raster.calls[0].src.split(',').slice(1).join(','))).toContain('width="412" height="212"');
    });

    it("is the surface's own image, as it came, when a surface offers one and nobody asks a size", async () => {
        const raster = recordingRaster();
        const host = { exportsImage: () => true, exportImage: async () => pngBytes(640, 480) } as any;
        const picture = await diagramPng({}, raster, host);
        expect(picture.width).toBe(640);
        expect(picture.height).toBe(480);
        expect(atob(picture.data).charCodeAt(1)).toBe(0x50);
        expect(raster.calls).toHaveLength(0);
    });

    it("is the surface's image brought down to 2000 px on its longer side when nobody asks a size", async () => {
        const raster = recordingRaster();
        const host = { exportsImage: () => true, exportImage: async () => pngBytes(6000, 4000) } as any;
        const picture = await diagramPng({}, raster, host);
        expect(picture).toEqual({ data: 'UE5H', width: 2000, height: 1333 });
        expect(raster.calls).toHaveLength(1);
        expect(raster.calls[0].src.startsWith('data:image/png;base64,')).toBe(true);
    });

    it("is the surface's image redrawn at the size asked", async () => {
        const raster = recordingRaster();
        const host = { exportsImage: () => true, exportImage: async () => pngBytes(640, 480) } as any;
        const picture = await diagramPng({ scale: 0.5 }, raster, host);
        expect(picture).toEqual({ data: 'UE5H', width: 320, height: 240 });
        expect(raster.calls[0].src.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('fails when the surface gives no PNG', async () => {
        const host = { exportsImage: () => true, exportImage: async () => new Uint8Array([1, 2, 3]) } as any;
        await expect(diagramPng({}, recordingRaster(), host)).rejects.toThrow('The surface gave no PNG image.');
    });
});

describe('the exporters GLSP asks', () => {
    it('answer the SVG drawn, as text', async () => {
        extracted.svg = SVG;
        const exporter = new DiagramSvgExporter();
        expect([exporter.format, exporter.encoding, exporter.mimeType]).toEqual(['svg', 'text', 'image/svg+xml']);
        expect(await exporter.export()).toBe(SVG);
    });

    it('answer a PNG, base64, read from the sizes asked and nothing else', async () => {
        const exporter = new DiagramPngExporter();
        expect([exporter.format, exporter.encoding, exporter.mimeType]).toEqual(['png', 'base64', 'image/png']);
        const asked: unknown[] = [];
        (exporter as any).draw = async (size: unknown) => {
            asked.push(size);
            return { data: 'UE5H', width: 1, height: 1 };
        };
        expect(await exporter.export(undefined, { width: 100, background: 'white', scale: Number.NaN } as any)).toBe('UE5H');
        expect(await exporter.export(undefined, { scale: 2 } as any)).toBe('UE5H');
        expect(asked).toEqual([
            { width: 100, height: undefined, scale: undefined },
            { width: undefined, height: undefined, scale: 2 }
        ]);
    });
});
