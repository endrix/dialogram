/**
 * `set-node-parameters`: give a node's parameters new values, as the property panel does.
 *
 * Without it an agent changed a parameter by editing the file by hand: no undo, and nothing
 * checked the value against what the node's type takes. Each value goes through the same
 * reversible operation a panel edit dispatches, and the result says, per parameter, that it
 * was set or the producer's reason it was not.
 */
import { inject, injectable, optional } from 'inversify';
import * as z from 'zod/v4';
import {
    McpDiagramScopedInputSchema,
    OperationMcpDiagramToolHandler,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { AgentEditOutcomeSink, isEditOp } from '@dialogram/diagram-server/server/agent-edit-outcome';
import { idOfNamedNode } from '@dialogram/diagram-server/server/mcp-named-elements';
import { UpdateEntityParameterOperation } from './update-entity-parameter-handler';

export const SetNodeParametersInputSchema = McpDiagramScopedInputSchema.extend({
    node: z.string().describe('The node: its name (`splitter`), or its element id.'),
    parameters: z
        .record(z.string(), z.string())
        .describe('Each parameter to set, to its new value as source text: `5`, `"in.txt"`, `File(path="in.txt")`.')
});
export type SetNodeParametersInput = z.infer<typeof SetNodeParametersInputSchema>;

@injectable()
export class SetNodeParametersMcpToolHandler extends OperationMcpDiagramToolHandler<SetNodeParametersInput> {
    static readonly NAME = 'set-node-parameters';
    readonly name = SetNodeParametersMcpToolHandler.NAME;
    override readonly title = 'Set Node Parameters';
    readonly description =
        "Set one or more of a node's parameters, as the property panel does. Name the node by its " +
        'name or element id; give each value as source text (`5`, `"in.txt"`). The result says per ' +
        "parameter that it was set, or the source's reason it was not (a parameter the node's type " +
        "does not take, say). This modifies the source and is undoable via the editor's undo.";
    readonly inputSchema = SetNodeParametersInputSchema;

    @inject(AgentEditOutcomeSink)
    @optional()
    protected editOutcomes?: AgentEditOutcomeSink;

    protected async createResult({ node, parameters }: SetNodeParametersInput): Promise<McpToolResult> {
        const elementId = this.nodeId(node);
        if (!elementId) {
            return this.error(`No node '${node}' in the diagram.`);
        }
        const entries = Object.entries(parameters);
        if (entries.length === 0) {
            return this.error('Name at least one parameter to set.');
        }
        const set: string[] = [];
        const refused: string[] = [];
        for (const [parameterName, newValue] of entries) {
            this.editOutcomes?.reset();
            const operation: UpdateEntityParameterOperation.Operation = {
                kind: UpdateEntityParameterOperation.KIND,
                elementId,
                parameterName,
                newValue
            };
            await this.actionDispatcher.dispatch(operation);
            if (!this.editOutcomes) {
                set.push(`${parameterName} = ${newValue}`);
                continue;
            }
            const answers = this.editOutcomes.take().filter(outcome => isEditOp(outcome.op, 'updateNodeParameter'));
            const failed = answers.find(outcome => !outcome.ok);
            if (answers.length === 0) {
                refused.push(`${parameterName}: not changed (nothing reached the source).`);
            } else if (failed) {
                refused.push(`${parameterName}: ${failed.message ?? 'refused.'}`);
            } else {
                set.push(`${parameterName} = ${newValue}`);
            }
        }
        const lines = [
            ...(set.length > 0 ? [`Set on '${node}':`, ...set.map(each => `- ${each}`)] : []),
            ...(refused.length > 0 ? [`Not set on '${node}':`, ...refused.map(each => `- ${each}`)] : [])
        ];
        return refused.length > 0 ? this.error(lines.join('\n')) : this.success(lines.join('\n'));
    }

    /** The real id of the node given by id, alias or name. */
    private nodeId(given: string): string | undefined {
        if (this.modelState.index.find(given)) {
            return given;
        }
        const real = this.aliasService.lookup(given);
        if (real && this.modelState.index.find(real)) {
            return real;
        }
        return idOfNamedNode(this.modelState.root, given);
    }
}
