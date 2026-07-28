/**
 * Read the in-host GLSP-MCP loopback server URL from the GLSP `initialize` handshake.
 *
 * The GLSP server runs inside the extension host, so we read the announced URL from the
 * TYPED initialize result (`McpInitializeResult.getServer`), never by parsing the server's
 * stdout. extension-core surfaces the returned URL on the activation handle so the agent
 * clients (opencode / ACP session manager) can hand it to agents.
 */
import { McpInitializeResult, type InitializeResult } from '@eclipse-glsp/protocol';

/**
 * Minimal structural view of the GLSP VS Code server this reader needs: the promise
 * resolving to the `initialize` result. Kept structural so activation passes the real
 * `NodeGlspVscodeServer` and tests can supply a stub.
 */
export interface McpInitializeResultSource {
    readonly initializeResult: Promise<InitializeResult>;
}

/**
 * Resolve the announced GLSP-MCP loopback URL, or `undefined` when unavailable.
 *
 * When `enabled` is `false` the initialize result is NOT awaited — an in-host server with
 * MCP off may never populate the MCP field, and awaiting it would stall activation. When
 * the server announced no MCP endpoint the result narrows to a plain `InitializeResult`
 * and this returns `undefined`.
 */
export async function readMcpServerUrl(
    server: McpInitializeResultSource,
    enabled: boolean
): Promise<string | undefined> {
    if (!enabled) {
        return undefined;
    }
    const result = await server.initializeResult;
    return McpInitializeResult.getServer(result)?.url;
}
