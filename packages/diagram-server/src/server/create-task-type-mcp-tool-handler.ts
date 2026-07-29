import { injectable } from 'inversify';
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
    name: z.string().describe('Name of the new task type to scaffold (a class added to the source).')
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
        'Scaffold a new task type in the underlying source. Provide the new type `name`; a class ' +
        'is added to the source via a reversible edit. This modifies the source and is undoable via ' +
        "the editor's undo. Requires user approval.";
    readonly inputSchema = CreateTaskTypeInputSchema;

    protected async createResult({ name }: CreateTaskTypeInput): Promise<McpToolResult> {
        await this.actionDispatcher.dispatch(CreateTaskTypeOperation.create({ name }));
        return this.success(`Scaffolded task type '${name}'. Undo via the editor if unintended.`);
    }
}
