/**
 * Select and center a node once the view it is in has loaded.
 *
 * Opening another view is a model request; the node exists only when the new
 * model arrives. "Go to Error" asks for the failing node here before opening
 * its view, and this listener selects it when the view comes in.
 */
import { inject, injectable } from 'inversify';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { CenterAction, SelectAction } from '@eclipse-glsp/protocol';
import { findNodeIdByEntityName } from './hierarchy-outline';

@injectable()
export class FocusAfterLoadService {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;

    private pending: string | undefined;

    /** Select the node named `entityName` in the next view that has it. */
    focusWhenLoaded(entityName: string): void {
        this.pending = entityName;
    }

    modelRootChanged(root: unknown): void {
        const name = this.pending;
        if (!name) {
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
