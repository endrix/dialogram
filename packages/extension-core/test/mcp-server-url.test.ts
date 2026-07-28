// T4 (GLSP-MCP Phase B): the in-host GLSP server announces its loopback MCP URL on the
// typed `initialize` result (McpInitializeResult.getServer) — NOT on stdout. `readMcpServerUrl`
// reads it from the server's `initializeResult` promise so extension-core can surface the URL
// to the agent clients. When MCP is off we never await the result (activation must not stall);
// when the server announced no MCP endpoint the URL is `undefined`.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { InitializeResult } from '@eclipse-glsp/protocol';
import { readMcpServerUrl } from '../src/extension/diagram/mcp-server-url';

/** A plain (non-MCP) initialize result. */
function plainResult(): InitializeResult {
    return { protocolVersion: '1.0.0', serverActions: {} } as unknown as InitializeResult;
}

/** An initialize result carrying an announced MCP server. */
function mcpResult(url: string): InitializeResult {
    return {
        ...plainResult(),
        mcpServer: { name: 'glsp-x', url }
    } as unknown as InitializeResult;
}

describe('readMcpServerUrl (T4)', () => {
    it('returns the announced url from a McpInitializeResult when enabled', async () => {
        const url = 'http://127.0.0.1:5123/mcp';
        const server = { initializeResult: Promise.resolve(mcpResult(url)) };
        await expect(readMcpServerUrl(server, true)).resolves.toBe(url);
    });

    it('returns undefined for a plain initialize result (no MCP announced)', async () => {
        const server = { initializeResult: Promise.resolve(plainResult()) };
        await expect(readMcpServerUrl(server, true)).resolves.toBeUndefined();
    });

    it('returns undefined without awaiting the result when MCP is disabled', async () => {
        let awaited = false;
        const server = {
            get initializeResult(): Promise<InitializeResult> {
                awaited = true;
                return Promise.resolve(mcpResult('http://127.0.0.1:9/mcp'));
            }
        };
        await expect(readMcpServerUrl(server, false)).resolves.toBeUndefined();
        expect(awaited).toBe(false);
    });
});
