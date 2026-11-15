/**
 * What a read-only view lets the reader make and delete besides drawing its
 * transitions (transition-edits.ts):
 *
 * - its states (`VIEW_EDITS`: `state`), placed with the palette's State.
 *   The automaton is written as its transitions, so a placed state has
 *   nowhere to be written yet: the editor holds it, with the view's layout,
 *   until a transition from or to it is written (unwritten-states.ts).
 *   Placing one asks its name; deleting one lets go of it.
 * - what the producer declared (`VIEW_CREATES`), placed with the palette's
 *   entry for it: placing one asks what the entry asks, and has the
 *   producer write it (`viewCreate`, with `create` and the answers).
 * - an element the producer marked (`VIEW_DELETABLE`): Delete has the
 *   producer take it out (`viewDelete`, with `element`, its id in the
 *   producer's graph). Deleting a state the editor once held lets go of it
 *   too, or it would come back as soon as the state was gone.
 *
 * What the producer writes names the view as a transition does
 * (`viewEditTarget`), and is undone as one edit of the diagram's document.
 * What the editor holds is undone too (`HeldStatesCommand`).
 */
import { CreateNodeOperation, TriggerNodeCreationAction } from '@eclipse-glsp/protocol';
import { Command, GModelElement, GModelRoot, MaybePromise, ModelState, OperationHandler, SourceModelStorage } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import * as vscode from 'vscode';
import {
    VIEW_CREATE_ELEMENT_TYPE,
    WORKFLOW_NETWORK_MODEL_KEY,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes,
    viewCreatesOf,
    viewEditsOf,
    type ViewCreate
} from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { collectEdgeRoutes, collectNodePositions } from '@dialogram/diagram-server/server/layout-snapshot';
import { layoutTargetOf } from '@dialogram/diagram-server/server/layout-target';
import type { CommandThatMayChangeNothing } from '@dialogram/diagram-server/server/command-stack';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { SidecarInvoker } from './sidecar-invoker';
import { viewEditTarget, type ViewEditTarget } from './transition-edits';

export interface Place {
    x: number;
    y: number;
}

/** Where the states the editor holds in the view shown are kept, and how the view is drawn again with them. */
export interface StateHolder {
    load(): Promise<Map<string, Place>>;
    /** Keep `held`, and draw the view again if it is still the one shown. */
    save(held: ReadonlyMap<string, Place>): Promise<void>;
}

/** Whether the view on `root` lets states be placed and deleted. */
export function allowsStateEditsOn(root: GModelRoot | undefined): boolean {
    return root?.args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true
        && viewEditsOf(root.args as Record<string, unknown>).includes('state');
}

/** The names of the states the view on `root` draws, written or held. */
export function stateNamesOn(root: GModelRoot | undefined): Set<string> {
    const names = new Set<string>();
    for (const child of root?.children ?? []) {
        const name = child.type === WorkflowDiagramTypes.NODE_STATE ? (child as any).args?.[WorkflowDiagramMetadata.STATE_NAME] : undefined;
        if (typeof name === 'string') {
            names.add(name);
        }
    }
    return names;
}

/** The name of a state the editor holds; nothing for any other element. */
export function heldStateNameOf(element: GModelElement | undefined): string | undefined {
    const args = (element as any)?.args as Record<string, unknown> | undefined;
    if (element?.type !== WorkflowDiagramTypes.NODE_STATE || args?.[WorkflowDiagramMetadata.STATE_UNWRITTEN] !== true) {
        return undefined;
    }
    const name = args[WorkflowDiagramMetadata.STATE_NAME];
    return typeof name === 'string' ? name : undefined;
}

/** What deleting `element` in a read-only view does: let go of a held state, or have the producer take it out. */
export type ViewDelete =
    | { kind: 'held'; name: string }
    | { kind: 'view'; element: string; state?: string };

export function viewDeleteOf(element: GModelElement | undefined, root: GModelRoot | undefined): ViewDelete | undefined {
    const held = heldStateNameOf(element);
    if (held !== undefined) {
        return allowsStateEditsOn(root) ? { kind: 'held', name: held } : undefined;
    }
    const args = (element as any)?.args as Record<string, unknown> | undefined;
    const id = args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID];
    if (args?.[WorkflowDiagramMetadata.VIEW_DELETABLE] !== true || typeof id !== 'string' || id === '') {
        return undefined;
    }
    const state = element?.type === WorkflowDiagramTypes.NODE_STATE ? args[WorkflowDiagramMetadata.STATE_NAME] : undefined;
    return { kind: 'view', element: id, ...(typeof state === 'string' ? { state } : {}) };
}

/**
 * The states the editor holds in the view shown on `modelState`: kept with
 * its layout, under the target it was drawn with. Nothing while no view is,
 * or where no layout is kept.
 */
export function stateHolderOf(modelState: ModelState, layoutPersistence: LayoutPersistenceService | undefined, storage: unknown): StateHolder | undefined {
    const diagramModel = modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
    if (!diagramModel || !layoutPersistence) {
        return undefined;
    }
    const target = layoutTargetOf(diagramModel);
    return {
        load: () => layoutPersistence.loadUnwrittenStates(target.filePath, target.networkId),
        save: async held => {
            await layoutPersistence.saveUnwrittenStates(target.filePath, target.networkId, held);
            // An undo that arrives once the editor shows another view keeps
            // what it holds, and draws nothing: the view it was made in is
            // drawn with it when it is shown again.
            const shownModel = modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
            const shown = shownModel ? layoutTargetOf(shownModel) : undefined;
            const rebuild = (storage as { rebuildFromLastDocument?: (current?: unknown) => Promise<boolean> })?.rebuildFromLastDocument;
            if (shown?.filePath === target.filePath && shown.networkId === target.networkId && typeof rebuild === 'function') {
                await rebuild.call(storage, {
                    positions: collectNodePositions(modelState.root),
                    routes: collectEdgeRoutes(modelState.root)
                });
            }
        }
    };
}

/**
 * A change of the states the editor holds: `change` is given what it holds
 * and answers what it is to hold, or nothing to leave it. Undone and redone
 * by keeping what it held before, and after.
 */
export class HeldStatesCommand implements CommandThatMayChangeNothing {
    private before?: Map<string, Place>;
    private after?: Map<string, Place>;

    constructor(
        private readonly holder: StateHolder,
        private readonly change: (held: Map<string, Place>) => Promise<Map<string, Place> | undefined>
    ) {}

    async execute(): Promise<void> {
        this.before = undefined;
        this.after = undefined;
        const held = await this.holder.load();
        const next = await this.change(new Map(held));
        if (!next) {
            return;
        }
        this.before = held;
        this.after = next;
        await this.holder.save(next);
    }

    async undo(): Promise<void> {
        if (this.before) {
            await this.holder.save(this.before);
        }
    }

    async redo(): Promise<void> {
        if (this.after) {
            await this.holder.save(this.after);
        }
    }

    canUndo(): boolean {
        return true;
    }

    /**
     * Whether it left what the editor holds as it was: a name asked for and
     * not given, or a state to let go of that it did not hold. The stack then
     * keeps no entry for it.
     */
    changedNothing(): boolean {
        return this.after === undefined;
    }
}

/** A name for a new state that none of `taken` has: `state_1`, `state_2`… */
export function freshStateName(taken: ReadonlySet<string>): string {
    for (let n = 1; ; n++) {
        const name = `state_${n}`;
        if (!taken.has(name)) {
            return name;
        }
    }
}

/** Why `name` cannot name a new state, or nothing when it can. */
export function stateNameRefusal(name: string, taken: ReadonlySet<string>): string | undefined {
    if (name.trim() === '') {
        return 'A state needs a name.';
    }
    if (name !== name.trim()) {
        return 'A state\'s name has no spaces round it.';
    }
    if (taken.has(name)) {
        return `There is a state ${name} already.`;
    }
    return undefined;
}

@injectable()
export class CreateStateOperationHandler extends OperationHandler {
    readonly operationType = CreateNodeOperation.KIND;
    override readonly label = 'Create State';
    readonly elementTypeIds = [WorkflowDiagramTypes.NODE_STATE];

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(LayoutPersistenceService)
    @optional()
    protected readonly layoutPersistence?: LayoutPersistenceService;

    @inject(SourceModelStorage)
    @optional()
    protected readonly sourceModelStorage?: SourceModelStorage;

    getTriggerActions(): TriggerNodeCreationAction[] {
        return this.elementTypeIds.map(elementTypeId => ({ kind: TriggerNodeCreationAction.KIND, elementTypeId }));
    }

    createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
        const root = this.modelState.root;
        const holder = allowsStateEditsOn(root) ? stateHolderOf(this.modelState, this.layoutPersistence, this.sourceModelStorage) : undefined;
        if (!holder) {
            return undefined;
        }
        const taken = stateNamesOn(root);
        const place = operation.location ?? { x: 0, y: 0 };
        return new HeldStatesCommand(holder, async held => {
            for (const name of held.keys()) {
                taken.add(name);
            }
            const name = await this.askName(operation, taken);
            if (name === undefined) {
                return undefined;
            }
            held.set(name, { x: place.x, y: place.y });
            return held;
        });
    }

    /** The name the operation gives (an agent's), else the person's; nothing when none is given or it cannot be. */
    protected async askName(operation: CreateNodeOperation, taken: ReadonlySet<string>): Promise<string | undefined> {
        const given = operation.args?.['name'];
        if (typeof given === 'string' || operation.args?.['headless'] === true) {
            const refusal = stateNameRefusal(typeof given === 'string' ? given : '', taken);
            if (refusal) {
                void vscode.window.showWarningMessage(refusal);
                return undefined;
            }
            return given as string;
        }
        return vscode.window.showInputBox({
            prompt: 'Name of the new state. Drawing a transition from or to it writes it.',
            value: freshStateName(taken),
            validateInput: value => stateNameRefusal(value, taken)
        });
    }
}

/** What placing `create` asks, answered from the operation (an agent's) or by the person; nothing when one is not answered. */
export async function answersFor(create: ViewCreate, operationArgs: Record<string, unknown> | undefined): Promise<Record<string, string> | undefined> {
    const answers: Record<string, string> = {};
    const headless = operationArgs?.['headless'] === true;
    for (const ask of create.asks ?? []) {
        const given = operationArgs?.[ask.key];
        if (typeof given === 'string' && given.trim() !== '') {
            answers[ask.key] = given.trim();
            continue;
        }
        if (headless) {
            return undefined;
        }
        const answer = await vscode.window.showInputBox({
            prompt: ask.prompt,
            value: ask.value,
            validateInput: value => (value.trim() === '' ? 'An answer is needed.' : undefined)
        });
        if (answer === undefined) {
            return undefined;
        }
        answers[ask.key] = answer.trim();
    }
    return answers;
}

/**
 * Have the producer write an edit made in a view (`op`, with `args` beside
 * the view's own); false, the reason shown, when it refuses.
 */
export async function writeViewEdit(
    sidecar: SidecarInvoker,
    target: ViewEditTarget,
    op: 'viewCreate' | 'viewDelete',
    args: Record<string, unknown>,
    failed: string
): Promise<boolean> {
    const result = await sidecar.sendSidecarOpDetailed(target.fileUri, { op: sidecar.sidecarOp(op), args: { ...target.args, ...args } });
    if (!result.ok) {
        void vscode.window.showWarningMessage(result.message ?? failed);
    }
    return result.ok;
}

@injectable()
export class ViewCreateOperationHandler extends OperationHandler {
    readonly operationType = CreateNodeOperation.KIND;
    override readonly label = 'Create';
    readonly elementTypeIds = [VIEW_CREATE_ELEMENT_TYPE];

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    getTriggerActions(): TriggerNodeCreationAction[] {
        return this.elementTypeIds.map(elementTypeId => ({ kind: TriggerNodeCreationAction.KIND, elementTypeId }));
    }

    createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
        const root = this.modelState.root;
        const target = root?.args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true ? viewEditTarget(root) : undefined;
        const create = viewCreatesOf(root?.args as Record<string, unknown> | undefined)
            .find(entry => entry.id === operation.args?.['create']);
        if (!target || !create) {
            return undefined;
        }
        const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
            label: `Create ${create.label}` + this.sidecar.undoLabelSuffix(),
            uri: target.document,
            computeEdits: async () => {
                const answers = await answersFor(create, operation.args as Record<string, unknown> | undefined);
                if (!answers) {
                    return undefined;
                }
                const before = await readAuthoritativeSourceText(target.document);
                if (!(await writeViewEdit(this.sidecar, target, 'viewCreate', { create: create.id, ...answers }, `The ${create.label.toLowerCase()} was not made.`))) {
                    return undefined;
                }
                // What the producer wrote, read from the disk it wrote to: the
                // document catches up later, and the undo compares with it.
                (command as any)._sourceBeforeText = before;
                (command as any)._sourceAfterText = await readAuthoritativeSourceText(target.document);
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            }
        });
        return command;
    }
}
