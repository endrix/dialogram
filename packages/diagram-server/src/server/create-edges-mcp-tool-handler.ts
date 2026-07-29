/**
 * Agent-dispatch override of the built-in GLSP-MCP `create-edges` tool.
 *
 * Connecting two nodes is a structural edit: the freshly reloaded model would otherwise leave
 * the new edge routed against whatever positions the endpoints happened to hold. This subclass
 * raises the {@link AgentStructuralEditSignal} after a (non-dry-run) create so the model-submission
 * handler runs a full boundary-flow layout on the next reload — the same auto-layout the
 * agent-dispatch create-nodes override triggers. A dry-run (validation only, no source rewrite)
 * never raises the flag. The palette/webview edge-creation flow does not use this handler, so its
 * behaviour is untouched.
 */
import { inject, injectable, optional } from 'inversify';
import {
    CreateEdgesMcpToolHandler,
    type CreateEdgesInput,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';

@injectable()
export class AgentDispatchCreateEdgesMcpToolHandler extends CreateEdgesMcpToolHandler {
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentSignal?: AgentStructuralEditSignal;

    protected override async createResult(input: CreateEdgesInput): Promise<McpToolResult> {
        const result = await super.createResult(input);
        if (input.dryRun !== true) {
            this.agentSignal?.markPending();
        }
        return result;
    }
}
