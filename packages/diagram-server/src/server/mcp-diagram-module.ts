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
    CreateEdgesMcpToolHandler,
    CreateNodesMcpToolHandler,
    DefaultMcpDiagramModule,
    DeleteElementsMcpToolHandler,
    ModifyEdgesMcpToolHandler,
    ModifyNodesMcpToolHandler,
    RedoMcpToolHandler,
    SaveModelMcpToolHandler,
    UndoMcpToolHandler,
    type McpDiagramToolHandlerConstructor
} from '@eclipse-glsp/server-mcp';
import type { InstanceMultiBinding } from '@eclipse-glsp/server';
import type { EditStrategy } from '@dialogram/shared';
import { makePlatformToolHandlerClass, type PlatformMcpTool } from './mcp-platform-tool-adapter';
import { isDiagramOperationModule, type McpToolBinding } from './operation-modules';
import { AgentDispatchCreateNodesMcpToolHandler } from './create-nodes-mcp-tool-handler';
import { AgentDispatchCreateEdgesMcpToolHandler } from './create-edges-mcp-tool-handler';

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
     * Read-only platform chat tools to bridge into diagram-scope MCP tools. Each becomes a
     * distinct handler resolving `sessionId -> ModelState.sourceUri`. Defaults to none.
     */
    tools?: PlatformMcpTool[];
}

/** Construction options for {@link DiagramMcpModule}. */
export interface DiagramMcpModuleOptions {
    /** Read-only platform chat tools bridged into diagram-scope MCP tools. */
    tools?: readonly PlatformMcpTool[];
    /**
     * The profile's edit strategy: read-only drops the platform's mutating tools
     * (nothing handles them); otherwise each operation module may bring the MCP
     * tools of its operations.
     */
    edits?: EditStrategy;
}

/**
 * Neutral per-session MCP diagram module for the platform GLSP server. Keeps the default
 * diagram-scope tools minus the built-in `undo` / `redo` (the host owns undo) and appends one
 * handler per supplied platform tool.
 */
export class DiagramMcpModule extends DefaultMcpDiagramModule {
    protected readonly platformTools: readonly PlatformMcpTool[];
    protected readonly edits: EditStrategy | undefined;

    constructor(options?: DiagramMcpModuleOptions) {
        super();
        this.platformTools = options?.tools ?? [];
        this.edits = options?.edits;
    }

    protected override configureToolHandlers(
        binding: InstanceMultiBinding<McpDiagramToolHandlerConstructor>
    ): void {
        super.configureToolHandlers(binding);
        // Drop the built-in undo/redo tools: the host owns undo, not the GLSP command stack.
        //
        // The built-in `UndoMcpToolHandler` / `RedoMcpToolHandler` read the per-GLSP-session
        // `CommandStack`. In dialogram the source file is the single source of truth: every
        // diagram mutation is applied as a reversible VS Code workspace edit and the model is
        // continuously reloaded from source, which resets that command stack. The DURABLE,
        // user-facing undo is therefore the VS Code document undo stack (survives reloads),
        // reachable only from the extension host — never from a diagram-scope MCP tool handler,
        // whose contract exposes just `commandStack` / `actionDispatcher`. Left in place, these
        // tools can only ever answer "nothing to undo", so we never advertise them to agents.
        // Agents are told (session context hint) that edits are user-undoable via the editor.
        binding.remove(UndoMcpToolHandler);
        binding.remove(RedoMcpToolHandler);
        if (this.edits === 'read-only') {
            // A projection with nothing to edit registers no writing operation handler, so
            // a mutating tool could only fail: the agent is not offered one.
            for (const mutating of [
                CreateNodesMcpToolHandler, CreateEdgesMcpToolHandler, ModifyNodesMcpToolHandler,
                ModifyEdgesMcpToolHandler, DeleteElementsMcpToolHandler, SaveModelMcpToolHandler
            ]) {
                binding.remove(mutating);
            }
            this.bridgePlatformTools(binding);
            return;
        }
        // Replace the built-in `create-nodes` with the agent-dispatch override. The stock tool
        // reaches the operation handler's interactive quick-input (a palette-drop affordance),
        // which blocks an agent call on a dialog no agent can answer. The override marks its
        // dispatched operations `headless` so creation runs non-interactively — deriving the
        // instance name and failing with an actionable error instead of ever prompting.
        binding.remove(CreateNodesMcpToolHandler);
        binding.add(AgentDispatchCreateNodesMcpToolHandler);
        // Replace the built-in `create-edges` with the agent-dispatch override. Connecting two
        // nodes is a structural edit; the override raises the auto-layout signal after a
        // non-dry-run create so the model-submission handler runs a full boundary-flow layout on
        // the next reload, matching the create-nodes behaviour. The palette edge-creation flow
        // never uses this handler, so its behaviour is unchanged.
        binding.remove(CreateEdgesMcpToolHandler);
        binding.add(AgentDispatchCreateEdgesMcpToolHandler);
        // The tools of the product's own operations (a type scaffold, say). Each rides the
        // built-in operation-tool path: it dispatches a reversible GLSP operation, so the
        // mutation flows through the undoable workspace edits, the one sanctioned way to
        // expose a mutating tool on the GLSP-MCP surface.
        const addOnly: McpToolBinding = { add: handler => binding.add(handler) };
        for (const module of this.edits?.operationModules ?? []) {
            if (isDiagramOperationModule(module)) {
                module.configureMcpTools?.(addOnly);
            }
        }
        this.bridgePlatformTools(binding);
    }

    /** Read-only bridge only: mutation-capable tools are excluded (see bridgeableChatTools). */
    private bridgePlatformTools(binding: InstanceMultiBinding<McpDiagramToolHandlerConstructor>): void {
        for (const tool of bridgeableChatTools(this.platformTools)) {
            binding.add(makePlatformToolHandlerClass(tool));
        }
    }
}
