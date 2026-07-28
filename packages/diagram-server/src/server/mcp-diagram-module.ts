/**
 * Per-GLSP-session MCP diagram module.
 *
 * Loaded inside `configureDiagramModule` (one instance per open diagram's
 * `ClientSession.container`) when the MCP opt-in is on. It extends the stock
 * {@link DefaultMcpDiagramModule}, so out of the box it binds the per-session id-alias
 * service, model serializer, element-types provider, and the diagram-scope tool/resource/
 * prompt handler multi-bindings (the 16 default tools + 2 resources).
 *
 * The `bindModelSerializer` / `bindElementTypesProvider` hooks are intentionally left at
 * their defaults here — cleaner, diagram-aware overrides are a follow-up. Subclasses/callers
 * customize the tool set via the platform-tool wiring layered on in a later task.
 */
import { DefaultMcpDiagramModule } from '@eclipse-glsp/server-mcp';

/**
 * Neutral opt-in options for the GLSP-MCP loopback server. Absent or `enabled:false`
 * keeps the legacy path byte-identical (no MCP DI modules are loaded). Presence of an
 * `mcpServer` config on the GLSP `initialize` request is what actually starts the HTTP
 * listener — this switch only decides whether the DI wiring is present to serve it.
 */
export interface McpServerModuleOptions {
    /** Master gate. When false (default), no MCP modules are bound. */
    enabled: boolean;
    /**
     * Optional adopter persona wired to the MCP `instructions` field. When omitted the
     * GLSP-default (product-neutral) persona is used.
     */
    agentPersona?: string;
}

/**
 * Neutral per-session MCP diagram module for the platform GLSP server. Kept as a distinct
 * class (rather than using `DefaultMcpDiagramModule` directly) so the platform tool bridge
 * has a stable extension point to attach to.
 */
export class DiagramMcpModule extends DefaultMcpDiagramModule {}
