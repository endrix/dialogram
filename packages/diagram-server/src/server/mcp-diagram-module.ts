/**
 * Per-GLSP-session MCP diagram module.
 *
 * Loaded inside `configureDiagramModule` (one instance per open diagram's
 * `ClientSession.container`) when the MCP opt-in is on. It extends the stock
 * {@link DefaultMcpDiagramModule}, so out of the box it binds the per-session id-alias
 * service, model serializer, element-types provider, and the diagram-scope tool/resource/
 * prompt handler multi-bindings (the 16 default tools + 2 resources).
 *
 * On top of the defaults it bridges any supplied read-only platform chat tools into
 * diagram-scope MCP tool handlers via {@link makePlatformToolHandlerClass}.
 *
 * The `bindModelSerializer` / `bindElementTypesProvider` hooks are intentionally left at
 * their defaults here — cleaner, diagram-aware overrides are a follow-up.
 */
import { DefaultMcpDiagramModule, type McpDiagramToolHandlerConstructor } from '@eclipse-glsp/server-mcp';
import type { InstanceMultiBinding } from '@eclipse-glsp/server';
import { makePlatformToolHandlerClass, type PlatformMcpTool } from './mcp-platform-tool-adapter';

/**
 * Keep mutation-capable tools OFF the read-only GLSP-MCP bridge.
 *
 * Every bridged tool becomes a handler that inherits `readOnlyHint = true`
 * ({@link makePlatformToolHandlerClass}), so an auto-approving MCP client may call it
 * without confirmation. A tool marked `mutates: true` WRITES source and must therefore
 * never be exposed this way. Locked design (approach B): mutation-capable
 * tools ride the GLSP-MCP BUILT-IN operation tools only (whose GLSP operations flow through
 * our reversible workspace edits). We filter on the explicit `mutates` marker — never a name
 * match — so the rule stays declarative and survives renames.
 */
export function bridgeableChatTools(tools: readonly PlatformMcpTool[]): readonly PlatformMcpTool[] {
    return tools.filter((tool) => tool.mutates !== true);
}

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
    /**
     * Read-only platform chat tools to bridge into diagram-scope MCP tools. Each becomes a
     * distinct handler resolving `sessionId -> ModelState.sourceUri`. Defaults to none.
     */
    tools?: PlatformMcpTool[];
}

/** Construction options for {@link DiagramMcpModule}. */
export interface DiagramMcpModuleOptions {
    /** Read-only platform chat tools bridged into diagram-scope MCP tools. */
    tools?: readonly PlatformMcpTool[];
}

/**
 * Neutral per-session MCP diagram module for the platform GLSP server. Keeps the 16 default
 * diagram-scope tools and appends one handler per supplied platform tool.
 */
export class DiagramMcpModule extends DefaultMcpDiagramModule {
    protected readonly platformTools: readonly PlatformMcpTool[];

    constructor(options?: DiagramMcpModuleOptions) {
        super();
        this.platformTools = options?.tools ?? [];
    }

    protected override configureToolHandlers(
        binding: InstanceMultiBinding<McpDiagramToolHandlerConstructor>
    ): void {
        super.configureToolHandlers(binding);
        // Read-only bridge only: mutation-capable tools are excluded (see bridgeableChatTools).
        for (const tool of bridgeableChatTools(this.platformTools)) {
            binding.add(makePlatformToolHandlerClass(tool));
        }
    }
}
