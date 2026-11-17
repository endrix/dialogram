/**
 * Agent-dispatch override of the built-in GLSP-MCP `create-edges` tool.
 *
 * Two responsibilities on top of the stock handler:
 *
 * 1. Name-addressable endpoints. The stock tool addresses each endpoint by raw element id, which an
 *    agent can only obtain by dumping the model (query-elements / diagram-model / diagram-svg) to
 *    map a human-meaningful `nodeName.portName` onto the opaque id. This override ALSO accepts
 *    `args.source` / `args.target` as `"nodeName.portName"` strings, resolved server-side against
 *    the current model tree — so an agent that just created a node (whose confirmation lists its
 *    port names) can connect it with no further queries. Raw `sourceElementId` / `targetElementId`
 *    addressing keeps working unchanged; the name path is a strict superset. A spec that names an
 *    unknown node/port, or resolves ambiguously, fails the whole call with an actionable message.
 *
 * 2. Auto-layout signal. Connecting two nodes is a structural edit: the override raises the
 *    {@link AgentStructuralEditSignal} after a (non-dry-run) create so the model-submission handler
 *    runs a full boundary-flow layout on the next reload. A dry-run (validation only, no source
 *    rewrite) never raises the flag. The palette/webview edge-creation flow does not use this
 *    handler, so its behaviour is untouched.
 */
import { inject, injectable, optional } from 'inversify';
import * as z from 'zod/v4';
import {
    CreateEdgesMcpToolHandler,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';
import { AgentEditOutcomeSink, isEditOp } from './agent-edit-outcome';
import { resolveEndpointElementId, type EndpointResolution } from './edge-endpoint-name-resolver';

/**
 * Loosened input schema: `sourceElementId` / `targetElementId` become OPTIONAL so an edge may be
 * addressed purely by `args.source` / `args.target` name specs. Everything else mirrors the stock
 * schema so raw-id addressing is byte-compatible.
 */
const NameAddressableEdgeSpecSchema = z.object({
    elementTypeId: z.string(),
    sourceElementId: z.string().optional(),
    targetElementId: z.string().optional(),
    routingPoints: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
    args: z.record(z.string(), z.any()).optional()
});

const NameAddressableCreateEdgesInputSchema = z.object({
    sessionId: z.string(),
    edges: z.array(NameAddressableEdgeSpecSchema),
    dryRun: z.boolean().optional()
});

type NameAddressableEdge = z.infer<typeof NameAddressableEdgeSpecSchema>;
type NameAddressableCreateEdgesInput = z.infer<typeof NameAddressableCreateEdgesInputSchema>;

@injectable()
export class AgentDispatchCreateEdgesMcpToolHandler extends CreateEdgesMcpToolHandler {
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentSignal?: AgentStructuralEditSignal;

    @inject(AgentEditOutcomeSink)
    @optional()
    protected editOutcomes?: AgentEditOutcomeSink;

    // The stock result is a diff of the model index, which never sees a dialogram edge (the model
    // is re-read from the source on a later reload): it said "Edge creation likely failed" for an
    // edge it made. The result is text read from what the producer answered instead.
    override readonly outputSchema = undefined;

    override readonly description =
        'Create one or multiple edges connecting two elements in the diagram. Address each endpoint ' +
        "EITHER by raw element id (`sourceElementId` / `targetElementId`, from query-elements) OR by " +
        "name via `args.source` / `args.target` as \"nodeName.portName\" (e.g. args.source " +
        '"producer.out", args.target "consumer.in") — the name form is resolved server-side and needs ' +
        'no query-elements/diagram-model dump. After create-nodes, the confirmation lists each new ' +
        "node's port names, so the very next create-edges can use nodeName.portName directly. When " +
        "the diagram's edges come in kinds, name the kind in `args.role`; without it the diagram's " +
        "default kind is made (never a question to the person). One of the diagram's own ports (a " +
        "workflow input or output) is named alone, without a dot (args.source \"TextFile\"). Set " +
        '`dryRun: true` to validate without creating. Use `element-types` for valid edge type IDs. ' +
        'The result says, per edge, whether it was made and if not why. ' +
        'This modifies the source and is undoable via the editor.';

    override readonly inputSchema = NameAddressableCreateEdgesInputSchema as unknown as CreateEdgesMcpToolHandler['inputSchema'];

    protected override async createResult(rawInput: unknown): Promise<McpToolResult> {
        const input = rawInput as NameAddressableCreateEdgesInput;

        const resolvedEdges: NameAddressableEdge[] = [];
        const errors: string[] = [];
        for (const edge of input.edges) {
            const source = this.resolveEndpoint(edge, 'source');
            const target = this.resolveEndpoint(edge, 'target');
            if (!source.ok && source.message) {
                errors.push(source.message);
            }
            if (!target.ok && target.message) {
                errors.push(target.message);
            }
            if (source.ok && target.ok) {
                // Drop the name specs from args (they are addressing, not model metadata) and fill
                // the concrete ids the stock handler dispatches.
                // An agent's edge is made headless: no one is at the screen to
                // answer a question in the middle of its tool call.
                const { source: _s, target: _t, ...restArgs } = (edge.args ?? {}) as Record<string, unknown>;
                resolvedEdges.push({
                    ...edge,
                    sourceElementId: source.elementId,
                    targetElementId: target.elementId,
                    args: { ...restArgs, headless: true }
                });
            }
        }

        // Any unresolved endpoint fails the whole call with the actionable message(s): a partial
        // dispatch would connect the wrong ports or leave the agent guessing which edge landed.
        if (errors.length > 0) {
            return this.error(errors.join('\n'));
        }

        if (input.dryRun === true || !this.editOutcomes) {
            const result = await super.createResult({ ...input, edges: resolvedEdges } as Parameters<CreateEdgesMcpToolHandler['createResult']>[0]);
            if (input.dryRun !== true) {
                this.agentSignal?.markPending();
            }
            return result;
        }

        // One edge at a time, so each one's answer is its own.
        const made: string[] = [];
        const refused: string[] = [];
        for (const [at, edge] of resolvedEdges.entries()) {
            const label = this.edgeLabel(input.edges[at], edge);
            this.editOutcomes.reset();
            const stock = await super.createResult({ ...input, edges: [edge] } as Parameters<CreateEdgesMcpToolHandler['createResult']>[0]);
            const answers = this.editOutcomes.take().filter(outcome => isEditOp(outcome.op, 'connect'));
            if (answers.length === 0) {
                // Nothing reached the producer: the diagram could not use these endpoints.
                refused.push(`${label}: not connected. ${textOf(stock)}`.trim());
            } else if (answers.every(outcome => outcome.ok)) {
                made.push(label);
            } else {
                refused.push(`${label}: ${answers.find(outcome => !outcome.ok)?.message ?? 'the connection was refused.'}`);
            }
        }
        if (made.length > 0) {
            this.agentSignal?.markPending();
        }
        const lines = [
            ...(made.length > 0 ? [`Connected ${made.length} edge(s):`, ...made.map(each => `- ${each}`)] : []),
            ...(refused.length > 0 ? [`Not connected (${refused.length}):`, ...refused.map(each => `- ${each}`)] : [])
        ];
        return refused.length > 0 ? this.error(lines.join('\n')) : this.success(lines.join('\n'));
    }

    /** How the agent named an edge: its name specs, or the ids it gave. */
    private edgeLabel(given: NameAddressableEdge, resolved: NameAddressableEdge): string {
        const args = (given.args ?? {}) as Record<string, unknown>;
        const source = typeof args.source === 'string' ? args.source : given.sourceElementId ?? resolved.sourceElementId;
        const target = typeof args.target === 'string' ? args.target : given.targetElementId ?? resolved.targetElementId;
        return `${source} → ${target}`;
    }

    /**
     * Resolve one endpoint. Raw `<endpoint>ElementId` wins (pass-through — could be an alias id from
     * query-elements). Otherwise `args.<endpoint>` is treated as a `nodeName.portName` spec, resolved
     * against the model tree and re-encoded to the alias space the stock handler looks up.
     */
    private resolveEndpoint(edge: NameAddressableEdge, endpoint: 'source' | 'target'): EndpointResolution {
        const rawId = endpoint === 'source' ? edge.sourceElementId : edge.targetElementId;
        if (typeof rawId === 'string' && rawId.trim() !== '') {
            return { ok: true, elementId: rawId };
        }
        const nameSpec = (edge.args as Record<string, unknown> | undefined)?.[endpoint];
        if (typeof nameSpec !== 'string' || nameSpec.trim() === '') {
            return {
                ok: false,
                message: `Missing ${endpoint} endpoint: pass ${endpoint}ElementId (raw id) or args.${endpoint} as "nodeName.portName".`
            };
        }
        const resolution = resolveEndpointElementId(this.modelState.root, nameSpec);
        if (!resolution.ok || !resolution.elementId) {
            return { ok: false, message: resolution.message };
        }
        return { ok: true, elementId: this.encodeIds([resolution.elementId])[0] };
    }
}

/** The text of a tool result. */
function textOf(result: McpToolResult): string {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    return content.map(part => part.text ?? '').join(' ').trim();
}
