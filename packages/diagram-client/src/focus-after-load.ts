/**
 * Select and center a node once the view it is in has loaded.
 *
 * Opening another view is a model request; the node exists only when the new
 * model arrives. "Go to Error" asks for the failing node here before opening
 * its view, and this listener selects it when the view comes in. A product's
 * command asks the same of the node its step added (`RevealNodeAction`),
 * for a while only: a step that turned out to draw no such node must not
 * move the view at some later load that happens to have one.
 */
import { inject, injectable } from 'inversify';
import { TYPES, type IActionDispatcher, type IActionHandler, type ICommand } from '@eclipse-glsp/client';
import { CenterAction, SelectAction, type Action } from '@eclipse-glsp/protocol';
import { RevealNodeAction } from '@dialogram/shared';
import { findNodeIdByEntityName } from './hierarchy-outline';

@injectable()
export class FocusAfterLoadService {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;

    private pending: string | undefined;
    private until: number | undefined;

    /** Select the node named `entityName` in the next view that has it; one that comes within `withinMs`, when given. */
    focusWhenLoaded(entityName: string, withinMs?: number): void {
        this.pending = entityName;
        this.until = withinMs === undefined ? undefined : Date.now() + withinMs;
    }

    modelRootChanged(root: unknown): void {
        const name = this.pending;
        if (!name) {
            return;
        }
        if (this.until !== undefined && Date.now() > this.until) {
            this.pending = undefined;
            return;
        }
        const id = findNodeIdByEntityName(root, name);
        if (!id) {
            return; // not this view: keep waiting for the one that has it
        }
        this.pending = undefined;
        // After the view has rendered it.
        setTimeout(() => {
            void this.dispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [id] }) as never);
            void this.dispatcher.dispatch(CenterAction.create([id], { animate: true, retainZoom: true }) as never);
        }, 0);
    }
}

/** How long a node named to be shown is waited for: the load the command asked for, not one much later. */
export const REVEAL_WITHIN_MS = 20000;

/** Select and centre a node the host names (`RevealNodeAction`), once the model that has it has loaded. */
@injectable()
export class RevealNodeActionHandler implements IActionHandler {
    @inject(FocusAfterLoadService)
    protected readonly focusAfterLoad!: FocusAfterLoadService;

    handle(action: Action): ICommand | Action | void {
        if (RevealNodeAction.is(action)) {
            this.focusAfterLoad.focusWhenLoaded(action.nodeName, REVEAL_WITHIN_MS);
        }
    }
}
