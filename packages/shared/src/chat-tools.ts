/**
 * An MCP tool served in-process over loopback HTTP. The handler receives the
 * absolute path of the file the session is scoped to and the tool arguments,
 * and returns the tool's text result — it can read live host-side state
 * (e.g. an in-memory graph store) directly.
 */
export interface InProcessChatTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler(
      file: string,
      args: Record<string, unknown>,
    ): string | Promise<string>;
    /**
     * When `true`, this tool WRITES source and MUST NOT be bridged onto the read-only
     * GLSP-MCP surface, whose handlers inherit `readOnlyHint = true` (an auto-approving MCP
     * client could otherwise mutate files unconfirmed). Locked design (approach B):
     * mutation-capable tools ride the GLSP-MCP built-in operation tools only. The diagram
     * server's bridge filters on this explicit marker; the tool stays available on the
     * in-host chat / in-process MCP path.
     */
    mutates?: boolean;
}
