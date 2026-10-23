/**
 * "Show <label>" and "Clear <label>" on the diagram's context menu: the
 * profile's status source, offered where the person is looking.
 *
 * The host registers the two commands and says so in the client behavior
 * (`statusSource`, derived from the profile, so the menu offers exactly what
 * the host can answer). The items sit on the canvas's menu, not a node's: a
 * status source reports on the whole diagram. Clear is offered only while
 * states are shown. A click asks the host to run the command; with no
 * argument it acts on the diagram in front of the person, which is this one.
 *
 * Client-side, beside the server's items, because the server has no reason to
 * know a product's commands: the provider is one more `IContextMenuItemProvider`,
 * whose items the context menu merges with the server's.
 */
import type { Action as GlspAction, GModelElement, ICommand, IActionHandler, IContextMenuItemProvider, LabeledAction, Point } from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import { shownExecutionStates } from './execution-states';
import { clientBehavior } from './profile';
import { VscodeUi } from './vscode-ui';

/** A context-menu item: a labelled action with the menu's id and group. */
type StatusMenuItem = LabeledAction & { id: string; group?: string; sortString?: string };

export interface RunStatusCommandAction extends GlspAction {
    kind: typeof RunStatusCommandAction.KIND;
    command: string;
}

export namespace RunStatusCommandAction {
    export const KIND = 'dialogram.runStatusCommand';

    export function create(command: string): RunStatusCommandAction {
        return { kind: KIND, command };
    }

    export function is(action: unknown): action is RunStatusCommandAction {
        return !!action
            && (action as { kind?: unknown }).kind === KIND
            && typeof (action as { command?: unknown }).command === 'string';
    }
}

/**
 * The status items for a right-click: none on a node (`onCanvas` false) or
 * without a status source, Show on the canvas, and Clear beside it while
 * states are shown. Their own group, so a separator sets them apart.
 */
export function statusSourceMenuItems(
    source: { label: string; showCommand: string; clearCommand: string } | undefined,
    onCanvas: boolean,
    statesShown: boolean
): StatusMenuItem[] {
    if (!source || !onCanvas) {
        return [];
    }
    const items: StatusMenuItem[] = [{
        id: 'dialogram.statusSource.show',
        label: `Show ${source.label}`,
        group: 'status',
        sortString: 's0',
        actions: [RunStatusCommandAction.create(source.showCommand)]
    }];
    if (statesShown) {
        items.push({
            id: 'dialogram.statusSource.clear',
            label: `Clear ${source.label}`,
            group: 'status',
            sortString: 's1',
            actions: [RunStatusCommandAction.create(source.clearCommand)]
        });
    }
    return items;
}

@injectable()
export class StatusSourceContextMenuItemProvider implements IContextMenuItemProvider {
    async getItems(root: Readonly<GModelElement>, _lastMousePosition?: Point): Promise<LabeledAction[]> {
        // The context menu selects what was right-clicked and clears the
        // selection on the canvas, so no selection means the canvas.
        const index = (root as unknown as { index?: { all(): Iterable<unknown> } }).index;
        const onCanvas = !index || ![...index.all()].some(element => (element as { selected?: boolean }).selected === true);
        return statusSourceMenuItems(clientBehavior().statusSource, onCanvas, shownExecutionStates().length > 0);
    }
}

/** Runs the status command a menu item names, on the host. */
@injectable()
export class RunStatusCommandActionHandler implements IActionHandler {
    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!RunStatusCommandAction.is(action)) {
            return;
        }
        void VscodeUi.instance.executeCommand(action.command);
    }
}
