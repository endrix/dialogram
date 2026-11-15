import { DeleteElementOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, MaybePromise, Action, ModelState, Command, GModelElement, GModelRoot, SourceModelStorage } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import { WorkflowDiagramMetadata, WorkflowDiagramTypeGuards, WorkflowDiagramTypes } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';
import { allowsTransitionEdits, viewEditTarget, writeTransitionEdit } from './transition-edits';
import { HeldStatesCommand, stateHolderOf, viewDeleteOf, writeViewEdit, type ViewDelete } from './view-edits';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { CompoundCommandThatMayChangeNothing } from '@dialogram/diagram-server/server/command-stack';

/**
 * Whether `element` of the view on `root` may be taken out of the source, by
 * a delete or a cut. Never a read-only element. A read-only view lets
 * nothing go but what its edits name: its transitions, where it allows
 * editing them (transition-edits.ts); a transition elsewhere stays too.
 */
export function mayRemove(root: GModelRoot | undefined, element: GModelElement | undefined): boolean {
    const args = (element as { args?: Record<string, unknown> } | undefined)?.args;
    if (element && WorkflowDiagramTypeGuards.isReadOnlyElement(element.type, args)) {
        return false;
    }
    if (element?.type === WorkflowDiagramTypes.EDGE_TRANSITION) {
        return allowsTransitionEdits(root) && viewEditTarget(root) !== undefined;
    }
    return root?.args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] !== true;
}

/** One thing a delete asks the producer to take out. */
type PlannedDelete =
    | { kind: 'transition'; id: string }
    | ViewDelete
    | { kind: 'node'; name: unknown }
    | { kind: 'edge'; fromExpr: string; toExpr: string; role: unknown }
    | { kind: 'port'; direction: string; portName: string };

@injectable()
export class DeleteElementOperationHandler extends OperationHandler {
    readonly operationType = DeleteElementOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    @inject(LayoutPersistenceService)
    @optional()
    protected readonly layoutPersistence?: LayoutPersistenceService;

    @inject(SourceModelStorage)
    @optional()
    protected readonly sourceModelStorage?: SourceModelStorage;

    constructor() {
        super();
    }

    createCommand(operation: Action): Command | undefined {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation as DeleteElementOperation, sourceUri);
    }

    private createPythonCommand(operation: DeleteElementOperation, sourceUri: string): Command | undefined {
        // What the selection deletes is known before any command is made: a
        // selection that deletes nothing makes none, so nothing goes on the
        // undo stack. (A command that writes nothing cannot be undone, and on
        // top of the stack it would keep every edit below it from being undone.)
        const deletes = this.plannedDeletes(operation.elementIds ?? []);
        if (deletes.length === 0) {
            return undefined;
        }

        // The states the editor holds go from what it holds, and so do the
        // written ones it once held, once the producer has taken them out:
        // deleting one would otherwise bring it back, held, as soon as it was
        // gone (view-edits.ts). One the producer refused stays as it was.
        const writtenStates = new Set<string>();
        let sourceWritten = false;
        const mayLetGo = deletes.some(planned => planned.kind === 'held' || (planned.kind === 'view' && planned.state !== undefined));
        const holder = mayLetGo ? stateHolderOf(this.modelState, this.layoutPersistence, this.sourceModelStorage) : undefined;
        const letGo = holder
            ? new HeldStatesCommand(holder, async held => {
                const lettingGo = deletes.flatMap(planned => (planned.kind === 'held' ? [planned.name] : []));
                lettingGo.push(...writtenStates);
                return lettingGo.map(name => held.delete(name)).some(Boolean) ? held : undefined;
            }, () => !sourceWritten)
            : undefined;
        if (deletes.every(planned => planned.kind === 'held')) {
            return letGo;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);
        const workflowName = this.modelState.root.args?.['wf:workflowName'] as string | undefined;
        const transitions = viewEditTarget(this.modelState.root);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Delete' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                let wrote = false;
                // What the producer refuses to take out (it said why) stays,
                // and the rest of the selection goes: each is named by its
                // name, a transition by its states and action, not by a place
                // in a list, so one taken out leaves the others' as they were.
                // What was taken out before a refusal stays taken out, and is
                // undone with the rest, as one edit.
                for (const planned of deletes) {
                    if (planned.kind === 'held') {
                        continue;
                    }
                    if (planned.kind === 'view') {
                        // Like a transition: one the producer refuses to take
                        // out (it said why) stays, and the others go.
                        if (transitions && (await writeViewEdit(this.sidecar, transitions, 'viewDelete', { element: planned.element }, 'It was not deleted.'))) {
                            wrote = true;
                            if (planned.state !== undefined) {
                                writtenStates.add(planned.state);
                            }
                        }
                        continue;
                    }
                    if (planned.kind === 'transition') {
                        if (transitions && (await writeTransitionEdit(this.sidecar, transitions, 'removeTransition', { transition: planned.id }))) {
                            wrote = true;
                        }
                        continue;
                    }
                    let args: Record<string, unknown>;
                    if (planned.kind === 'node') {
                        args = { workflow: workflowName, name: planned.name };
                    } else if (planned.kind === 'edge') {
                        // The kind of edge, when the producer said (`meta.role`)
                        // and the sidecar makes edges of several kinds: two nodes
                        // may then be joined by more than one, and the sidecar
                        // needs to know which one goes. A sidecar that lists no
                        // kinds gets no role, as before.
                        const role = (await this.sidecar.edgeRoles(sourceUri)) ? planned.role : undefined;
                        args = {
                            workflow: workflowName,
                            from_expr: planned.fromExpr,
                            to_expr: planned.toExpr,
                            ...(typeof role === 'string' && role.trim() !== '' ? { role: role.trim() } : {})
                        };
                    } else {
                        args = { workflow: workflowName, direction: planned.direction, portName: planned.portName };
                    }
                    const op = planned.kind === 'node' ? 'deleteNode' : planned.kind === 'edge' ? 'deleteEdge' : 'deletePort';
                    const outcome = await this.writeDelete(sourceUri, planned.kind, { op: this.sidecar.sidecarOp(op), args });
                    if (outcome === 'written') {
                        wrote = true;
                    } else if (outcome === 'failed') {
                        // The producer did not run (it could not start, timed
                        // out, crashed): the rest would fail the same way.
                        break;
                    }
                }
                if (!wrote) {
                    return undefined;
                }
                // The view is drawn again from what was written: what the
                // editor lets go of with it need not draw it first.
                sourceWritten = true;
                const afterText = await readAuthoritativeSourceText(vscodeUri);
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        // The source first, then what the editor holds: each says whether it
        // changed anything, and a delete the producer refused throughout,
        // letting go of nothing, leaves no entry on the undo stack.
        return letGo ? new CompoundCommandThatMayChangeNothing(command, letGo) : command;
    }

    /**
     * What deleting `elementIds` asks the producer to delete, in their order:
     * what may be taken out ({@link mayRemove}), and of that, what names
     * something the producer can find. A read-only view also lets go what a
     * cut does not take: the states the editor holds, and what the producer
     * marked deletable (view-edits.ts).
     */
    private plannedDeletes(elementIds: readonly string[]): PlannedDelete[] {
        const root = this.modelState.root;
        const readOnlyView = root.args?.[WorkflowDiagramMetadata.READ_ONLY_VIEW] === true;
        const deletedEdges = new Set<string>();
        const deletes: PlannedDelete[] = [];
        for (const id of elementIds) {
            const element = this.modelState.index.get(id) as any;
            const elementArgs = element?.args as Record<string, unknown> | undefined;
            const elementType = element?.type as string | undefined;
            if (!mayRemove(root, element) || elementType === WorkflowDiagramTypes.NODE_STATE) {
                // What a read-only view lets go besides its transitions: a
                // state the editor holds, and what the producer marked
                // deletable (view-edits.ts). Never a read-only element. A
                // state is no node of the producer's network, in any view:
                // only these take one out.
                const viewDelete = (readOnlyView || elementType === WorkflowDiagramTypes.NODE_STATE) && element
                    && elementType !== WorkflowDiagramTypes.EDGE_TRANSITION
                    && !WorkflowDiagramTypeGuards.isReadOnlyElement(elementType as string, elementArgs)
                    && viewEditTarget(root) !== undefined
                    ? viewDeleteOf(element, root)
                    : undefined;
                if (viewDelete) {
                    deletes.push(viewDelete);
                }
                continue;
            }

            if (elementType === WorkflowDiagramTypes.EDGE_TRANSITION) {
                deletes.push({ kind: 'transition', id });
                continue;
            }

            if (elementType && (elementType.startsWith('node:') || elementType.startsWith('node ')) && elementArgs?.[WorkflowDiagramMetadata.ENTITY_NAME]) {
                deletes.push({ kind: 'node', name: elementArgs[WorkflowDiagramMetadata.ENTITY_NAME] });
                continue;
            }

            if (elementType === WorkflowDiagramTypes.EDGE_CONNECTION && elementArgs) {
                // A piece of an edge split at group frames stands for the
                // edge (`EDGE_OF`): two pieces of one edge delete it once.
                // A piece several edges share inside a group stands for
                // more than one, and which to delete is not for this
                // handler to guess; their stretch between frames is each
                // one's own, and deletes it.
                const edgesOf = elementArgs[WorkflowDiagramMetadata.EDGES_OF];
                if (Array.isArray(edgesOf) && edgesOf.length > 1) {
                    void vscode.window.showInformationMessage(
                        `That line inside the group stands for ${edgesOf.length} edges. Select one of them where it runs between groups to delete it.`
                    );
                    continue;
                }
                const edgeOf = elementArgs[WorkflowDiagramMetadata.EDGE_OF];
                if (typeof edgeOf === 'string') {
                    if (deletedEdges.has(edgeOf)) {
                        continue;
                    }
                    deletedEdges.add(edgeOf);
                }
                const outPort = elementArgs['wf:outPort'] as string | undefined;
                const inPort = elementArgs['wf:inPort'] as string | undefined;
                if (!outPort || !inPort) continue;
                deletes.push({
                    kind: 'edge',
                    fromExpr: this.edgeEndpointExpr(elementArgs['wf:from'] as string | undefined, outPort),
                    toExpr: this.edgeEndpointExpr(elementArgs['wf:to'] as string | undefined, inPort),
                    role: elementArgs[WorkflowDiagramMetadata.EDGE_ROLE]
                });
                continue;
            }

            if (elementType && elementType.startsWith('port:') && elementArgs) {
                const portName = elementArgs[WorkflowDiagramMetadata.PORT_NAME] as string | undefined;
                const portDirection = elementArgs[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
                if (portName && portDirection) {
                    deletes.push({ kind: 'port', direction: portDirection, portName });
                }
                continue;
            }
        }
        // The edges first: a node or a port taken out takes the edges at it
        // with it, and an edge selected with its node would then be asked
        // for when it is already gone, and refused. The rest keep their order.
        return [...deletes.filter(planned => planned.kind === 'edge'), ...deletes.filter(planned => planned.kind !== 'edge')];
    }

    /**
     * Have the producer take out a node, an edge or a port: `written`;
     * `refused`, the reason shown, when it answered no; `failed`, shown too,
     * when it did not answer (it could not start, timed out, crashed).
     */
    private async writeDelete(sourceUri: string, kind: 'node' | 'edge' | 'port', payload: { op: string; args: Record<string, unknown> }): Promise<'written' | 'refused' | 'failed'> {
        const result = await this.sidecar.sendSidecarOpDetailed(sourceUri, payload);
        if (result.ok) {
            return 'written';
        }
        void vscode.window.showWarningMessage(result.message ?? `The ${kind} was not deleted.`);
        return result.failure === 'rejected' ? 'refused' : 'failed';
    }

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
