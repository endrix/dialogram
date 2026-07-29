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
import {
    AgentCreateNodeOutcomeSink,
    type AgentCreateNodeOutcome,
    type CreatedNodeOutcome,
    type RejectedNodeOutcome
} from './agent-create-node-outcome';

/** Marker folded into every dispatched node's `args`; the operation handler branches on it. */
const HEADLESS_ARG = 'headless';

@injectable()
export class AgentDispatchCreateNodesMcpToolHandler extends CreateNodesMcpToolHandler {
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentSignal?: AgentStructuralEditSignal;

    @inject(AgentCreateNodeOutcomeSink)
    @optional()
    protected outcomeSink?: AgentCreateNodeOutcomeSink;

    override readonly description =
        'Create one or multiple new nodes in the diagram at the specified positions. ' +
        'Call `query-elements` (or `count-elements`) first to avoid overlap. Each node needs an ' +
        '`elementTypeId` (from `element-types`) and a `position`. For node types backed by a concrete ' +
        'source definition, pass that definition name as `args.type` and, optionally, an instance ' +
        'name as `args.name` (auto-generated when omitted). This runs without any interactive prompt; ' +
        'if a required value is missing the call fails with a message naming exactly what to pass. ' +
        'This operation modifies the source and is undoable via the editor.';

    // The stock handler declares CreateNodesOutputSchema and derives `createdNodes` from a
    // post-dispatch `modelState.index` diff. In dialogram that diff can never see a create (the
    // model re-sources on a later reload), so the structured payload would always be empty/false.
    // We drop the output schema and return an authoritative TEXT result sourced from the operation
    // handler via {@link AgentCreateNodeOutcomeSink} instead — no fabricated structured content.
    override readonly outputSchema = undefined;

    protected override async createResult(input: CreateNodesInput): Promise<McpToolResult> {
        // Immutably restamp each node so the dispatched operation carries the headless marker.
        const nodes = input.nodes.map((node) => ({
            ...node,
            args: { ...(node.args ?? {}), [HEADLESS_ARG]: true }
        }));

        // Clear any stale outcome, dispatch through the built-in create loop (which the operation
        // handler services by rewriting source and recording the outcome), then read it back.
        this.outcomeSink?.reset();
        const fallback = await super.createResult({ ...input, nodes });
        const outcomes = this.outcomeSink?.take() ?? [];

        const created = outcomes.filter(isCreated);
        const rejected = outcomes.filter(isRejected);

        // No authoritative signal (sink unbound, or a non-headless path that never records) — defer
        // to the built-in result rather than inventing one.
        if (created.length === 0 && rejected.length === 0) {
            return fallback;
        }

        // Only request an auto-layout when a create actually landed on disk — a pure rejection
        // changed nothing, so relaying out would be wrong.
        if (created.length > 0) {
            this.agentSignal?.markPending();
        }

        // Any rejection makes the whole call a hard failure (`isError:true`): the agent MUST see the
        // actionable message rather than a success-shaped "0 created". Created nodes (partial batch)
        // are echoed first so the agent knows what already landed.
        if (rejected.length > 0) {
            const lines = [
                ...created.map((outcome) => `Created ${outcome.type} '${outcome.name}'.`),
                ...rejected.map((outcome) => outcome.message)
            ];
            return this.error(lines.join('\n'));
        }

        const summary = created.map((outcome) => `- ${outcome.type} '${outcome.name}' (#${outcome.name})`).join('\n');
        return this.success(`Successfully created ${created.length} node(s):\n${summary}`);
    }
}

function isCreated(outcome: AgentCreateNodeOutcome): outcome is CreatedNodeOutcome {
    return outcome.kind === 'created';
}

function isRejected(outcome: AgentCreateNodeOutcome): outcome is RejectedNodeOutcome {
    return outcome.kind === 'rejected';
}
