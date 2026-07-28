// T2 (GLSP-MCP Phase B): the platform tool adapter bridges a read-only in-process chat tool
// (`{ name, description, inputSchema, handler(file,args) }`) into a diagram-scope MCP tool
// handler. The handler resolves the target open diagram's `sessionId -> ModelState.sourceUri`
// and hands that file plus the (sessionId-stripped) args to the tool's closure.
//
// Two units under test:
//  (1) the JSON-Schema -> Zod shim (`jsonSchemaToZodShape`), which converts the tool's
//      `inputSchema` into a Zod raw shape the MCP handler base requires (a `ZodObject` that
//      `.strict()` is later called on). Required fields stay mandatory; the rest are optional.
//  (2) the generated per-tool handler class: reads `modelState.sourceUri`, strips `sessionId`,
//      invokes the closure, and returns a success result. `readOnlyHint` stays `true`
//      (inherited from the read base) so no readonly gate fires; a missing sourceUri returns
//      a clear error instead of throwing.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { URI } from 'vscode-uri';
import { jsonSchemaToZodShape } from '../src/server/json-schema-to-zod';
import { makePlatformToolHandlerClass, type PlatformMcpTool } from '../src/server/mcp-platform-tool-adapter';

describe('jsonSchemaToZodShape (T2 shim)', () => {
    it('makes non-required object properties optional', () => {
        const shape = jsonSchemaToZodShape({
            type: 'object',
            properties: { network: { type: 'string' } },
            required: []
        });
        const obj = z.object(shape);
        expect(obj.safeParse({}).success).toBe(true);
        expect(obj.safeParse({ network: 'n' }).success).toBe(true);
    });

    it('keeps required properties mandatory', () => {
        const shape = jsonSchemaToZodShape({
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        });
        const obj = z.object(shape);
        expect(obj.safeParse({}).success).toBe(false);
        expect(obj.safeParse({ name: 'x' }).success).toBe(true);
    });

    it('supports array-of-string and degrades unknown nodes to z.any() without throwing', () => {
        const shape = jsonSchemaToZodShape({
            type: 'object',
            properties: {
                items: { type: 'array', items: { type: 'string' } },
                weird: { type: 'not-a-real-type' }
            },
            required: ['items']
        });
        const obj = z.object(shape);
        expect(obj.safeParse({ items: ['a', 'b'] }).success).toBe(true);
        expect(obj.safeParse({ items: 'notarray' }).success).toBe(false);
        // Unknown node became z.any() and is optional (not required), so absence parses.
        expect(obj.safeParse({ items: ['a'] }).success).toBe(true);
    });

    it('never throws on an empty / malformed schema', () => {
        expect(() => jsonSchemaToZodShape({})).not.toThrow();
        expect(() => jsonSchemaToZodShape({ type: 'object' })).not.toThrow();
        expect(Object.keys(jsonSchemaToZodShape({}))).toHaveLength(0);
    });
});

describe('makePlatformToolHandlerClass (T2 adapter)', () => {
    function echoTool(): { tool: PlatformMcpTool; calls: Array<{ file: string; args: Record<string, unknown> }> } {
        const calls: Array<{ file: string; args: Record<string, unknown> }> = [];
        const tool: PlatformMcpTool = {
            name: 'echo-file',
            description: 'Echoes the scoped file.',
            inputSchema: { type: 'object', properties: { network: { type: 'string' } }, required: [] },
            handler: (file, args) => {
                calls.push({ file, args });
                return `handled file=${file}`;
            }
        };
        return { tool, calls };
    }

    it('resolves sourceUri to an absolute fsPath, strips sessionId, and returns success text', async () => {
        const { tool, calls } = echoTool();
        const HandlerClass = makePlatformToolHandlerClass(tool);
        const handler = new HandlerClass() as any;
        handler.modelState = { sourceUri: 'file:///a.py' };

        const result = await handler.handle({ sessionId: 's', network: 'n' });

        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain('a.py');
        expect(calls).toHaveLength(1);
        // DECISION (T7): the handler passes the fsPath, NOT the raw file:// URI —
        // `InProcessChatTool.handler` documents `file` as an absolute path, and every
        // sidecar transport in the toolkit does `URI.parse(...).fsPath`.
        expect(calls[0].file).toBe(URI.parse('file:///a.py').fsPath);
        expect(calls[0].file.startsWith('file:')).toBe(false);
        // sessionId is NOT forwarded into the handler args.
        expect(calls[0].args).toEqual({ network: 'n' });
    });

    it('inherits readOnlyHint=true and carries the tool name/description/inputSchema', () => {
        const { tool } = echoTool();
        const HandlerClass = makePlatformToolHandlerClass(tool);
        const handler = new HandlerClass() as any;

        expect(handler.readOnlyHint).toBe(true);
        expect(handler.name).toBe('echo-file');
        expect(handler.description).toBe('Echoes the scoped file.');
        // sessionId is present on the schema (the dispatcher reads it before the handler runs).
        expect(Object.keys(handler.inputSchema.shape)).toContain('sessionId');
        expect(Object.keys(handler.inputSchema.shape)).toContain('network');
    });

    it('returns an error result (not a throw) when the session has no source file', async () => {
        const { tool, calls } = echoTool();
        const HandlerClass = makePlatformToolHandlerClass(tool);
        const handler = new HandlerClass() as any;
        handler.modelState = { sourceUri: undefined };

        const result = await handler.handle({ sessionId: 's' });

        expect(result.isError).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it('produces a distinct class per tool so `name` fields do not collide', () => {
        const a = makePlatformToolHandlerClass({ ...echoTool().tool, name: 'tool-a' });
        const b = makePlatformToolHandlerClass({ ...echoTool().tool, name: 'tool-b' });
        expect(a).not.toBe(b);
        expect((new a() as any).name).toBe('tool-a');
        expect((new b() as any).name).toBe('tool-b');
    });
});
