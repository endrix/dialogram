/**
 * Agent-dispatch override of the built-in GLSP-MCP `create-nodes` tool.
 *
 * The stock {@link CreateNodesMcpToolHandler} dispatches a `CreateNodeOperation` straight from the
 * agent's `{ elementTypeId, position, args }` input. In dialogram the operation handler that services
 * that dispatch (in the toolkit) rewrites the underlying source and — for a palette drop — collects
 * the concrete type and instance name through the editor's interactive quick-input. Reaching that
 * interactive path from an AGENT call is a bug: the MCP call blocks on a dialog no agent can answer,
 * times out, and the agent is left asking the human to click.
 *
 * This subclass marks every operation it dispatches as `headless` (via each node's open `args`
 * record) so the operation handler takes its non-interactive path: it uses the caller-supplied
 * `args.type` / `args.name`, auto-derives a unique instance name when `name` is omitted, and FAILS
 * with an actionable error (relayed to the agent) instead of prompting when a required value is
 * genuinely missing. The palette/webview flow never sets this marker, so its dialogs are untouched.
 *
 * The concrete type + instance name mirror what the dialog collects; agents pass them explicitly via
 * the already-open per-node `args` record — e.g. `args: { type: 'MyType', name: 'my_instance' }`.
 */
import { inject, injectable, optional } from 'inversify';
import {
    CreateNodesMcpToolHandler,
    type CreateNodesInput,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';

/** Marker folded into every dispatched node's `args`; the operation handler branches on it. */
const HEADLESS_ARG = 'headless';

@injectable()
export class AgentDispatchCreateNodesMcpToolHandler extends CreateNodesMcpToolHandler {
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentSignal?: AgentStructuralEditSignal;

    override readonly description =
        'Create one or multiple new nodes in the diagram at the specified positions. ' +
        'Call `query-elements` (or `count-elements`) first to avoid overlap. Each node needs an ' +
        '`elementTypeId` (from `element-types`) and a `position`. For node types backed by a concrete ' +
        'source definition, pass that definition name as `args.type` and, optionally, an instance ' +
        'name as `args.name` (auto-generated when omitted). This runs without any interactive prompt; ' +
        'if a required value is missing the call fails with a message naming exactly what to pass. ' +
        'This operation modifies the source and is undoable via the editor.';

    protected override async createResult(input: CreateNodesInput): Promise<McpToolResult> {
        // Immutably restamp each node so the dispatched operation carries the headless marker.
        const nodes = input.nodes.map((node) => ({
            ...node,
            args: { ...(node.args ?? {}), [HEADLESS_ARG]: true }
        }));
        const result = await super.createResult({ ...input, nodes });
        // Structural edit: request an auto-layout on the next reload so the new node is not
        // left parked at its default position (palette/webview creation never runs this path).
        this.agentSignal?.markPending();
        return result;
    }
}
