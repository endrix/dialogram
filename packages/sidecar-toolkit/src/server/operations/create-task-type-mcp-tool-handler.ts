import { inject, injectable, optional } from 'inversify';
import { AgentEditOutcomeSink, isEditOp } from '@dialogram/diagram-server/server/agent-edit-outcome';
import * as z from 'zod/v4';
import {
    McpDiagramScopedInputSchema,
    OperationMcpDiagramToolHandler,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { CreateTaskTypeOperation } from '@dialogram/shared';

/**
 * Input schema for the `create-task-type` operation tool. Extends the diagram-scoped base (which
 * carries `sessionId`) with the new type's name. Zod v4 to match the built-in operation tools;
 * `toRegistrationConfig()` applies `.strict()` so an LLM-typoed field surfaces as a validation
 * error rather than a silent no-op.
 *
 * Only `name` is accepted: the dispatched operation resolves server-side to a source-rewrite
 * that takes just the type name, so no `inputs`/`outputs` are exposed here (they would be
 * silently dropped).
 */
export const CreateTaskTypeInputSchema = McpDiagramScopedInputSchema.extend({
    name: z.string().describe('Name of the new task type to scaffold (a class added to the source).'),
    kind: z.string().optional().describe(
        "The kind of type: the source's own word for it (for a decorator-based language, the decorator: " +
        'task, tool, agent, viewer, source, workflow). Default: task.'
    )
});
export type CreateTaskTypeInput = z.infer<typeof CreateTaskTypeInputSchema>;

/**
 * GLSP-MCP operation tool that scaffolds a new task type. Extends
 * {@link OperationMcpDiagramToolHandler} (not the read base) so it inherits the write annotations
 * (`readOnlyHint = false`) and the `McpReadOnlyError` gate, and dispatches the reversible
 * {@link CreateTaskTypeOperation} through the injected `ActionDispatcher` — routed server-side to
 * the toolkit's registered handler exactly like the built-in operation tools. The scaffold is
 * undoable via the editor's document undo (the reversible workspace edit the operation performs).
 */
@injectable()
export class CreateTaskTypeMcpToolHandler extends OperationMcpDiagramToolHandler<CreateTaskTypeInput> {
    static readonly NAME = 'create-task-type';
    readonly name = CreateTaskTypeMcpToolHandler.NAME;
    override readonly title = 'Create Task Type';
    readonly description =
        'Scaffold a new type in the underlying source. Provide the new type `name` and, for other ' +
        'than a plain task, its `kind`; the definition is added to the source via a reversible edit. ' +
        "The result says it was made, or the source's reason it was not (a name taken, say). This " +
        "modifies the source and is undoable via the editor's undo. Requires user approval.";
    readonly inputSchema = CreateTaskTypeInputSchema;

    @inject(AgentEditOutcomeSink)
    @optional()
    protected editOutcomes?: AgentEditOutcomeSink;

    protected async createResult({ name, kind }: CreateTaskTypeInput): Promise<McpToolResult> {
        this.editOutcomes?.reset();
        await this.actionDispatcher.dispatch(CreateTaskTypeOperation.create({ name, typeKind: kind }));
        const label = `${kind?.trim() || 'task'} type '${name}'`;
        if (!this.editOutcomes) {
            return this.success(`Scaffolded ${label}. Undo via the editor if unintended.`);
        }
        const answer = this.editOutcomes.take().find(outcome => isEditOp(outcome.op, 'createTaskType', 'createWorkflowType'));
        if (!answer) {
            return this.error(`The ${label} was not created: the diagram could not ask the source for it.`);
        }
        if (!answer.ok) {
            return this.error(`The ${label} was not created: ${answer.message ?? 'refused.'}`);
        }
        return this.success(`Created the ${label}. Undo via the editor if unintended.`);
    }
}
