/**
 * Per-GLSP-session MCP diagram module.
 *
 * Loaded inside `configureDiagramModule` (one instance per open diagram's
 * `ClientSession.container`) when the MCP opt-in is on. It extends the stock
 * {@link DefaultMcpDiagramModule}, so out of the box it binds the per-session id-alias
 * service, model serializer, element-types provider, and the diagram-scope tool/resource/
 * prompt handler multi-bindings (the 16 default tools + 2 resources).
 *
 * On top of the defaults it (1) removes the built-in `undo` / `redo` tools — the host, not the
 * GLSP command stack, owns undo in dialogram (see {@link DiagramMcpModule.configureToolHandlers})
 * — and (2) bridges any supplied read-only platform chat tools into diagram-scope MCP tool
 * handlers via {@link makePlatformToolHandlerClass}.
 *
 * The `bindModelSerializer` / `bindElementTypesProvider` hooks are intentionally left at
 * their defaults here — cleaner, diagram-aware overrides are a follow-up.
 */
import {
    CreateNodesMcpToolHandler,
    DefaultMcpDiagramModule,
    RedoMcpToolHandler,
    UndoMcpToolHandler,
    type McpDiagramToolHandlerConstructor
} from '@eclipse-glsp/server-mcp';
import type { InstanceMultiBinding } from '@eclipse-glsp/server';
import { makePlatformToolHandlerClass, type PlatformMcpTool } from './mcp-platform-tool-adapter';
import { CreateTaskTypeMcpToolHandler } from './create-task-type-mcp-tool-handler';
import { AgentDispatchCreateNodesMcpToolHandler } from './create-nodes-mcp-tool-handler';

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
 * Neutral per-session MCP diagram module for the platform GLSP server. Keeps the default
 * diagram-scope tools minus the built-in `undo` / `redo` (the host owns undo) and appends one
 * handler per supplied platform tool.
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
        // Drop the built-in undo/redo tools: the host owns undo, not the GLSP command stack.
        //
        // The built-in `UndoMcpToolHandler` / `RedoMcpToolHandler` read the per-GLSP-session
        // `CommandStack`. In dialogram the source `.py` file is the single source of truth: every
        // diagram mutation is applied as a reversible VS Code workspace edit and the model is
        // continuously reloaded from source, which resets that command stack. The DURABLE,
        // user-facing undo is therefore the VS Code document undo stack (survives reloads),
        // reachable only from the extension host — never from a diagram-scope MCP tool handler,
        // whose contract exposes just `commandStack` / `actionDispatcher`. Left in place, these
        // tools can only ever answer "nothing to undo", so we never advertise them to agents.
        // Agents are told (session context hint) that edits are user-undoable via the editor.
        binding.remove(UndoMcpToolHandler);
        binding.remove(RedoMcpToolHandler);
        // Replace the built-in `create-nodes` with the agent-dispatch override. The stock tool
        // reaches the operation handler's interactive quick-input (a palette-drop affordance),
        // which blocks an agent call on a dialog no agent can answer. The override marks its
        // dispatched operations `headless` so creation runs non-interactively — deriving the
        // instance name and failing with an actionable error instead of ever prompting.
        binding.remove(CreateNodesMcpToolHandler);
        binding.add(AgentDispatchCreateNodesMcpToolHandler);
        // Custom operation tool: scaffold a task type. It rides the built-in operation-tool path
        // (dispatches a reversible GLSP operation), so mutation flows through our undoable workspace
        // edits — the one sanctioned way to expose a mutating tool on the GLSP-MCP surface.
        binding.add(CreateTaskTypeMcpToolHandler);
        // Read-only bridge only: mutation-capable tools are excluded (see bridgeableChatTools).
        for (const tool of bridgeableChatTools(this.platformTools)) {
            binding.add(makePlatformToolHandlerClass(tool));
        }
    }
}
