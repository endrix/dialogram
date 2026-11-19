/**
 * The diagram tools an agent edits with, made to address a node by its name and to say what
 * the producer answered.
 *
 * The stock tools take element ids, which an agent only gets by dumping the model, and judge
 * their own success by diffing the model index around the dispatch. A dialogram edit rewrites
 * the source and the model is re-read only on a later reload, so that diff never sees it:
 * `delete-elements` said "deleted 0" for a node it deleted, and `modify-nodes` could not rename
 * at all, its label lookup stopping at a node's direct children while the name sits in the
 * header. Here:
 *
 * - an id that is no element's is tried as a node's name (`splitter`);
 * - the result is read from {@link AgentEditOutcomeSink}: what the producer did, or its reason
 *   for refusing;
 * - a node's name label is its label, so `modify-nodes` `text` renames the node, through the
 *   same reversible rename a label edit in the diagram makes.
 *
 * Neutral: node names and labels are the shared metadata keys and label types, no product words.
 */
import { inject, injectable, optional } from 'inversify';
import { GLabel, type GModelElement, type GModelRoot } from '@eclipse-glsp/server';
import {
    DefaultElementTypesProvider,
    DeleteElementsMcpToolHandler,
    ModifyNodesMcpToolHandler,
    type DeleteElementsInput,
    type ElementTypes,
    type McpLabelProvider,
    type McpToolResult,
    type ModifyNodesInput
} from '@eclipse-glsp/server-mcp';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { AgentEditOutcomeSink, isEditOp, type AgentEditOutcome } from './agent-edit-outcome';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';
import { STORAGE_RUNTIME_OPTIONS, type StorageRuntimeOptions } from './storage-runtime-options';

const NAME_LABEL_TYPES = new Set<string>([WorkflowDiagramTypes.LABEL_NAME, WorkflowDiagramTypes.LABEL_BOUNDARY_NAME]);

/** The id of the node shown with this name, if exactly one is. */
export function idOfNamedNode(root: GModelRoot | undefined, name: string): string | undefined {
    const wanted = name.trim();
    if (!root || wanted === '') {
        return undefined;
    }
    const found: string[] = [];
    const visit = (element: GModelElement): void => {
        const args = (element as { args?: Record<string, unknown> }).args;
        if (typeof element.type === 'string' && element.type.startsWith('node:')
            && args?.[WorkflowDiagramMetadata.ENTITY_NAME] === wanted) {
            found.push(element.id);
            if (element.type === WorkflowDiagramTypes.NODE_GROUP) {
                // The frame of an open node is the node of that name: what it
                // holds (a register named as the block that drives it) is not.
                return;
            }
        }
        for (const child of (element.children ?? []) as GModelElement[]) {
            visit(child);
        }
    };
    visit(root);
    return found.length === 1 ? found[0] : undefined;
}

/** A node's label is its name: the name label in its header, not only a direct child. */
@injectable()
export class NamedNodeMcpLabelProvider implements McpLabelProvider {
    getLabel(element: GModelElement): GLabel | undefined {
        const direct = (element.children ?? []).find((child): child is GLabel => child instanceof GLabel);
        const queue: GModelElement[] = [...((element.children ?? []) as GModelElement[])];
        while (queue.length > 0) {
            const next = queue.shift()!;
            if (next instanceof GLabel && NAME_LABEL_TYPES.has(next.type)) {
                return next;
            }
            // A nested node's name is its own, not this one's.
            if (typeof next.type === 'string' && next.type.startsWith('node:')) {
                continue;
            }
            queue.push(...((next.children ?? []) as GModelElement[]));
        }
        return direct;
    }
}

/** The producer's answers (to these ops, when named), as lines for the agent; `undefined` when none came. */
function answersOf(outcomes: readonly AgentEditOutcome[], ...ops: string[]): { ok: number; refused: string[] } | undefined {
    const answers = ops.length === 0 ? [...outcomes] : outcomes.filter(outcome => isEditOp(outcome.op, ...ops));
    if (answers.length === 0) {
        return undefined;
    }
    return {
        ok: answers.filter(outcome => outcome.ok).length,
        refused: answers.filter(outcome => !outcome.ok).map(outcome => outcome.message ?? 'The edit was refused.')
    };
}

@injectable()
export class AgentDispatchDeleteElementsMcpToolHandler extends DeleteElementsMcpToolHandler {
    @inject(AgentEditOutcomeSink)
    @optional()
    protected editOutcomes?: AgentEditOutcomeSink;

    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentSignal?: AgentStructuralEditSignal;

    // The stock count is a model-index diff, which never sees a dialogram delete.
    override readonly outputSchema = undefined;

    override readonly description =
        'Delete one or more elements from the diagram, with what depends on them (a node takes its ' +
        'edges along). Name each element by its id, or a node by its name (`splitter`). The result ' +
        'says what was deleted, or why not. This modifies the source and is undoable via the editor.';

    protected override async createResult(input: DeleteElementsInput): Promise<McpToolResult> {
        const elementIds = input.elementIds.map(given => this.byName(given));
        if (!this.editOutcomes) {
            return super.createResult({ ...input, elementIds });
        }
        // Every answer while the delete runs is the delete's: a node, an edge, a port, a
        // transition or a view element, each by its own op.
        const { value: stock, outcomes } = await this.editOutcomes.collect(() => super.createResult({ ...input, elementIds }));
        const answers = answersOf(outcomes);
        if (!answers) {
            // No producer answer: either nothing reached the source, or the delete needed none
            // (states the editor holds unwritten), which the model shows gone at once.
            const inModel = (stock as { structuredContent?: { deletedCount?: unknown } }).structuredContent?.deletedCount;
            if (typeof inModel === 'number' && inModel > 0) {
                this.agentSignal?.markPending();
                return this.success(`Deleted ${input.elementIds.join(', ')}.`);
            }
            return this.error(`Nothing was deleted. ${textOf(stock)}`.trim());
        }
        if (answers.ok > 0) {
            this.agentSignal?.markPending();
        }
        if (answers.refused.length > 0) {
            return this.error(['Not deleted:', ...answers.refused.map(each => `- ${each}`)].join('\n'));
        }
        return this.success(`Deleted ${input.elementIds.join(', ')} (${answers.ok} edit(s) to the source).`);
    }

    /** The alias of the node named `given`, when `given` is no element's id. */
    private byName(given: string): string {
        if (this.modelState.index.find(this.aliasService.lookup(given))) {
            return given;
        }
        const id = idOfNamedNode(this.modelState.root, given);
        return id ? this.encodeIds([id])[0] : given;
    }
}

@injectable()
export class AgentDispatchModifyNodesMcpToolHandler extends ModifyNodesMcpToolHandler {
    @inject(AgentEditOutcomeSink)
    @optional()
    protected editOutcomes?: AgentEditOutcomeSink;

    override readonly description =
        'Modify one or more existing nodes: their position, size, and/or name. Name each node by its ' +
        'id, or by its name (`splitter`). `text` renames the node: its uses in the source follow, ' +
        'and a refused name (taken, not an identifier) comes back as an error saying why. Omitted ' +
        'fields keep their value. This modifies the source and is undoable via the editor.';

    protected override async createResult(input: ModifyNodesInput): Promise<McpToolResult> {
        const nodes = input.nodes.map(change => ({ ...change, elementId: this.byName(change.elementId) }));
        if (!this.editOutcomes) {
            return super.createResult({ ...input, nodes });
        }
        const { value: stock, outcomes } = await this.editOutcomes.collect(() => super.createResult({ ...input, nodes }));
        const renaming = input.nodes.filter(change => typeof change.text === 'string' && change.text.trim() !== '');
        if (renaming.length === 0) {
            return stock;
        }
        // A rename is the producer's: with no answer from it, nothing was renamed, whatever the
        // stock result (which reads the label off a model not yet re-read) says.
        const answers = answersOf(outcomes);
        if (!answers) {
            return this.error(`Not renamed: the source was not asked to rename ${renaming.map(change => `'${change.elementId}'`).join(', ')}. ${textOf(stock)}`.trim());
        }
        if (answers.refused.length > 0) {
            return this.error(['Not renamed:', ...answers.refused.map(each => `- ${each}`)].join('\n'));
        }
        const renamed = `Renamed ${renaming.map(change => `'${change.elementId}' to '${change.text!.trim()}'`).join(', ')}; its uses in the source follow.`;
        const moved = input.nodes.some(change => change.position !== undefined || change.size !== undefined);
        return this.success(moved ? `${renamed}\n${textOf(stock)}` : renamed);
    }

    /** The alias of the node named `given`, when `given` is no element's id. */
    private byName(given: string): string {
        if (this.modelState.index.find(this.aliasService.lookup(given))) {
            return given;
        }
        const id = idOfNamedNode(this.modelState.root, given);
        return id ? this.encodeIds([id])[0] : given;
    }
}

/**
 * The creatable types, each labelled with the palette rows it stands for.
 *
 * The stock list labels a type with its operation handler's label, and one handler makes every
 * kind of node here, so each was "Create Node". A product's palette rows say what each type is,
 * and several rows may share a type and differ by their `args`: the description names the args
 * that pick each row.
 */
@injectable()
export class PaletteElementTypesProvider extends DefaultElementTypesProvider {
    @inject(STORAGE_RUNTIME_OPTIONS)
    @optional()
    protected storageOptions?: StorageRuntimeOptions;

    override get(): ElementTypes {
        const types = super.get();
        const rows = this.storageOptions?.entityPaletteItems ?? [];
        if (rows.length === 0) {
            return types;
        }
        const seen = new Set<string>();
        const nodeTypes = types.nodeTypes.flatMap(entry => {
            if (seen.has(entry.id)) {
                return [];
            }
            seen.add(entry.id);
            const own = rows.filter(row => row.elementTypeId === entry.id);
            if (own.length === 0) {
                return [entry];
            }
            return [{
                ...entry,
                label: own.map(row => row.label).join(' / '),
                description: own
                    .map(row => `${row.label}${row.args ? ` (args ${JSON.stringify(row.args)})` : ''}${row.description ? `: ${row.description}` : ''}`)
                    .join('; ')
            }];
        });
        return { ...types, nodeTypes };
    }
}

/** The text of a tool result. */
function textOf(result: McpToolResult): string {
    const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
    return content.map(part => part.text ?? '').join(' ').trim();
}
