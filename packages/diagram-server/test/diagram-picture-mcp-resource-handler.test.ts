/**
 * The MCP `diagram-png` tool pictures the diagram as the editor draws it
 * (diagram-picture-mcp-resource-handler.ts): the client is asked for a PNG
 * with only the size the caller gave, never one worked out from the model,
 * whose extent is not what the editor draws; and it is given longer than
 * GLSP's five seconds. The diagram module binds it in place of GLSP's.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestExportAction } from '@eclipse-glsp/server';
import { DiagramPngMcpResourceHandler, DiagramSvgMcpResourceHandler } from '@eclipse-glsp/server-mcp';
import { DrawnDiagramPngMcpResourceHandler } from '../src/server/diagram-picture-mcp-resource-handler';
import { DiagramMcpModule } from '../src/server/mcp-diagram-module';

type Asked = { request: RequestExportAction; timeoutMs: number };

/** The handler, its client round-trip and progress stood in: what it asks is recorded. */
function handlerAnswering(response: { encoding: string; data: string }) {
    const handler = new DrawnDiagramPngMcpResourceHandler() as any;
    const asked: Asked[] = [];
    handler.progress = { emit: async () => undefined };
    handler.requestAction = async (request: RequestExportAction, timeoutMs: number) => {
        asked.push({ request, timeoutMs });
        return response;
    };
    return { handler, asked };
}

describe('the diagram-png tool', () => {
    it('asks the client for a PNG with no size when the caller gives none', async () => {
        const { handler, asked } = handlerAnswering({ encoding: 'base64', data: 'UE5H' });
        expect(await handler.createResult({ sessionId: 's' })).toEqual({ blob: 'UE5H' });
        expect(asked).toHaveLength(1);
        expect(asked[0].request.kind).toBe(RequestExportAction.KIND);
        expect(asked[0].request.format).toBe('png');
        expect(asked[0].request.formatOptions).toEqual({ width: undefined, height: undefined, scale: undefined });
        expect(asked[0].timeoutMs).toBe(15000);
    });

    it('passes the size or scale the caller gave, and its timeout', async () => {
        const { handler, asked } = handlerAnswering({ encoding: 'base64', data: 'UE5H' });
        await handler.createResult({ sessionId: 's', scale: 2, timeoutMs: 30000 });
        await handler.createResult({ sessionId: 's', width: 640 });
        expect(asked.map(a => a.request.formatOptions)).toEqual([
            { width: undefined, height: undefined, scale: 2 },
            { width: 640, height: undefined, scale: undefined }
        ]);
        expect(asked[0].timeoutMs).toBe(30000);
    });

    it('never reads the model for a size', async () => {
        const { handler } = handlerAnswering({ encoding: 'base64', data: 'UE5H' });
        handler.computeNaturalSize = () => {
            throw new Error('Diagram has no positioned elements yet');
        };
        expect(await handler.createResult({ sessionId: 's' })).toEqual({ blob: 'UE5H' });
    });

    it('fails on an answer that is not base64', async () => {
        const { handler } = handlerAnswering({ encoding: 'text', data: '<svg/>' });
        await expect(handler.createResult({ sessionId: 's' })).rejects.toThrow("unexpected encoding 'text'");
    });

    it('keeps the name, and says what it pictures', () => {
        const handler = new DrawnDiagramPngMcpResourceHandler();
        expect(handler.name).toBe('diagram-png');
        expect(handler.description).toContain('as the editor draws it');
        expect(handler.description).toContain('2000 px');
    });

    it('is bound by the diagram module in place of GLSP’s, beside diagram-svg', () => {
        const bound = new Set<unknown>();
        (new DiagramMcpModule() as any).configureResourceHandlers({
            add: (c: unknown) => bound.add(c),
            remove: (c: unknown) => bound.delete(c)
        });
        expect(bound.has(DrawnDiagramPngMcpResourceHandler)).toBe(true);
        expect(bound.has(DiagramPngMcpResourceHandler)).toBe(false);
        expect(bound.has(DiagramSvgMcpResourceHandler)).toBe(true);
    });
});
