/**
 * The transitions of an automaton, drawn and deleted in a view that allows
 * it (`VIEW_EDITS` on its root: `transition`).
 *
 * Drawing one with the palette's Transition, from a state to a state, asks
 * what takes it (one of `TRANSITION_LABELS`) and has the producer write it:
 * `addTransition` with the two states by their names (`STATE_NAME`) and the
 * label's id. Deleting one has it taken out: `removeTransition` with its id.
 * Both name the view as it was asked for (`VIEW_REQUEST`): the unit and the
 * view, or the root and the path of instances, asked of the same file. The
 * diagram's document goes with them (`document`): it is the file the undo
 * reverts, and a producer that would write another refuses instead.
 *
 * A refusal says why, in the editor: a state the automaton has none of, an
 * action no schedule can name, a schedule written in a way the producer
 * does not rewrite. Nothing is drawn or deleted that the producer has not
 * written; the view is read again from the file.
 */
import { CreateEdgeOperation, TriggerEdgeCreationAction } from '@eclipse-glsp/protocol';
import { Command, GModelElement, GModelRoot, MaybePromise, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import {
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes,
    transitionLabelsOf,
    viewEditsOf,
    type ViewRequest
} from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { SidecarInvoker } from './sidecar-invoker';

/** Where an edit made in a view goes: the file asked, what it is asked for, the document undone. */
export interface ViewEditTarget {
    /** The file the view was asked of. */
    fileUri: string;
    /** The diagram's document: the file the undo reverts. */
    document: vscode.Uri;
    /** The view, named as it was asked for. */
    args: Record<string, unknown>;
}

/** Whether the view on `root` allows drawing and deleting its transitions. */
export function allowsTransitionEdits(root: GModelRoot | undefined): boolean {
    return viewEditsOf(root?.args as Record<string, unknown> | undefined).includes('transition');
}

/** Where an edit made in the view on `root` goes; nothing for a root that says no document. */
export function viewEditTarget(root: GModelRoot | undefined): ViewEditTarget | undefined {
    const args = (root?.args ?? {}) as Record<string, unknown>;
    const sourceUri = typeof args['sourceUri'] === 'string' ? args['sourceUri'] : undefined;
    if (!sourceUri) {
        return undefined;
    }
    const request = (args[WorkflowDiagramMetadata.VIEW_REQUEST] ?? {}) as ViewRequest;
    const network = request.networkName ?? (typeof args['wf:workflowName'] === 'string' ? args['wf:workflowName'] : undefined);
    const document = vscode.Uri.parse(sourceUri);
    return {
        fileUri: request.graphSourceUri ?? sourceUri,
        document,
        args: {
            ...(network ? { network } : {}),
            ...(request.view ? { view: request.view } : {}),
            ...(request.rootWorkflow && request.instancePath?.length ? { rootNetwork: request.rootWorkflow, instancePath: request.instancePath } : {}),
            document: document.fsPath
        }
    };
}

/** A state's name in what the automaton is written in; nothing for any other element, or a state that has none. */
export function stateNameOf(element: GModelElement | undefined): string | undefined {
    if (element?.type !== WorkflowDiagramTypes.NODE_STATE) {
        return undefined;
    }
    const name = (element as any).args?.[WorkflowDiagramMetadata.STATE_NAME];
    return typeof name === 'string' ? name : undefined;
}

/**
 * Have the producer write an edit of the view's transitions (`op`, with
 * `args` beside the view's own); false, the reason shown, when it refuses.
 */
export async function writeTransitionEdit(
    sidecar: SidecarInvoker,
    target: ViewEditTarget,
    op: 'addTransition' | 'removeTransition',
    args: Record<string, unknown>
): Promise<boolean> {
    const result = await sidecar.sendSidecarOpDetailed(target.fileUri, { op: sidecar.sidecarOp(op), args: { ...target.args, ...args } });
    if (!result.ok) {
        void vscode.window.showWarningMessage(result.message ?? `The ${op === 'addTransition' ? 'transition was not drawn' : 'transition was not deleted'}.`);
    }
    return result.ok;
}

@injectable()
export class CreateTransitionOperationHandler extends OperationHandler {
    readonly operationType = CreateEdgeOperation.KIND;
    override readonly label = 'Create Transition';
    readonly elementTypeIds = [WorkflowDiagramTypes.EDGE_TRANSITION];

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    getTriggerActions(): TriggerEdgeCreationAction[] {
        return this.elementTypeIds.map(elementTypeId => ({ kind: TriggerEdgeCreationAction.KIND, elementTypeId }));
    }

    createCommand(operation: CreateEdgeOperation): MaybePromise<Command | undefined> {
        const root = this.modelState.root;
        const target = viewEditTarget(root);
        if (!target || !allowsTransitionEdits(root)) {
            return undefined;
        }
        const from = stateNameOf(this.modelState.index.find(operation.sourceElementId));
        const to = stateNameOf(this.modelState.index.find(operation.targetElementId));
        const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
            label: 'Create Transition' + this.sidecar.undoLabelSuffix(),
            uri: target.document,
            computeEdits: async () => {
                if (from === undefined || to === undefined) {
                    void vscode.window.showInformationMessage(
                        'A transition goes from a state of the automaton to a state of it: unfold a run to draw one from a state inside it.'
                    );
                    return undefined;
                }
                const label = await this.pickLabel(operation, from, to);
                if (!label) {
                    return undefined;
                }
                const before = await readAuthoritativeSourceText(target.document);
                if (!(await writeTransitionEdit(this.sidecar, target, 'addTransition', { from, to, label }))) {
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

    /**
     * What takes the transition: the label the operation names (an agent's,
     * with no one to ask), else the one the view offers when it offers one,
     * else the person's pick. Nothing when none is chosen.
     */
    protected async pickLabel(operation: CreateEdgeOperation, from: string, to: string): Promise<string | undefined> {
        const given = typeof operation.args?.['label'] === 'string' ? String(operation.args['label']).trim() : '';
        if (given !== '') {
            return given;
        }
        const labels = transitionLabelsOf(this.modelState.root.args as Record<string, unknown> | undefined);
        if (labels.length === 1) {
            return labels[0].id;
        }
        if (operation.args?.['headless'] === true) {
            return undefined;
        }
        if (labels.length === 0) {
            void vscode.window.showInformationMessage('This view offers nothing to take a transition.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            labels.map(entry => ({ label: entry.label, description: entry.description, id: entry.id })),
            { placeHolder: `What takes the transition from ${from} to ${to}?`, matchOnDescription: true }
        );
        return picked?.id;
    }
}
