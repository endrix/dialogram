/**
 * What a producer offers on a node or on the canvas (`meta.actions`,
 * shared/node-actions.ts), carried from the click to the product's command.
 *
 * The server lists the actions in the context menu; a double-click does the
 * one the producer marked for it, on the node or on the port clicked. Either
 * way a `NodeActionAction` arrives here, and the handler calls the product's
 * command (`clientBehavior.nodeActionCommand`) with what it was made on.
 * Which command a product names is the client's to know, not the server's,
 * so it is here that a menu loses the entries no command would carry out
 * (`offeredMenuItems`): without the command nothing is offered. The
 * command does the work in the host (a producer's CLI, usually) and asks for
 * the diagram again; nothing here changes the model. The command may name a
 * node for the reader to be shown (`RevealNodeAction`, focus-after-load.ts):
 * it is selected and centred when the model that has it comes in.
 */
import { EditorContextService, type IActionHandler, type ICommand } from '@eclipse-glsp/client';
import type { Action, GModelElement } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import {
    doubleClickAction,
    NodeActionAction,
    parseNodeActions,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes,
    type NodeActionRequest,
    type NodeActionSpec
} from '@dialogram/shared';
import { clientBehavior } from './profile';
import { VscodeUi } from './vscode-ui';

type Args = Record<string, unknown>;

const argsOf = (element: unknown): Args | undefined => (element as { args?: Args } | undefined)?.args;

/** The node an element is, or is part of, when its producer offers actions on it; and those actions. */
export function nodeWithActions(target: GModelElement | undefined): { node: GModelElement; actions: NodeActionSpec[] } | undefined {
    let current: GModelElement | undefined = target;
    while (current) {
        const meta = argsOf(current)?.[WorkflowDiagramMetadata.NODE_META];
        if (meta && typeof meta === 'object') {
            const actions = parseNodeActions((meta as Args)['actions']);
            return actions.length > 0 ? { node: current, actions } : undefined;
        }
        const parent = (current as unknown as { parent?: GModelElement }).parent;
        // A node does not stand for the frame it is in (an open node's, which is that node).
        if (String(current.type).startsWith('node:') && parent?.type === WorkflowDiagramTypes.NODE_GROUP) {
            return undefined;
        }
        current = parent;
    }
    return undefined;
}

/** The port an element is, or is part of, by the name its producer gave it. */
export function portNameOf(target: GModelElement | undefined): string | undefined {
    let current: GModelElement | undefined = target;
    while (current) {
        const type = (current as { type?: string }).type;
        if (typeof type === 'string' && type.startsWith('port')) {
            const name = argsOf(current)?.[WorkflowDiagramMetadata.PORT_NAME];
            return typeof name === 'string' && name !== '' ? name : undefined;
        }
        if (argsOf(current)?.[WorkflowDiagramMetadata.NODE_META]) {
            return undefined;
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

/**
 * A context menu's items as the reader is offered them: what a producer
 * lists is left out when the product names no command to carry it out. An
 * entry that does nothing when clicked is worse than no entry.
 */
export function offeredMenuItems<T extends { actions?: readonly unknown[]; children?: T[] }>(items: readonly T[]): T[] {
    if (clientBehavior().nodeActionCommand) {
        return [...items];
    }
    return items
        .filter(item => !(item.actions ?? []).some(action => NodeActionAction.is(action)))
        .map(item => (Array.isArray(item.children) && item.children.length > 0
            ? { ...item, children: offeredMenuItems(item.children) }
            : item));
}

/**
 * What a double-click on `target` does of what its producer offers, as the
 * action to dispatch; `undefined` when the producer marked nothing for it, or
 * the product has no command to carry it out.
 */
export function doubleClickNodeAction(target: GModelElement): NodeActionAction.Action | undefined {
    if (!clientBehavior().nodeActionCommand) {
        return undefined;
    }
    const found = nodeWithActions(target);
    if (!found) {
        return undefined;
    }
    const port = portNameOf(target);
    const action = doubleClickAction(found.actions, port !== undefined);
    if (!action) {
        return undefined;
    }
    return {
        kind: NodeActionAction.KIND,
        action: action.id,
        elementId: found.node.id,
        ...(action.doubleClick === 'port' && port !== undefined ? { port } : {})
    };
}

/** The request the product's command gets for an action on `element` (the root, for the canvas). */
export function nodeActionRequest(action: NodeActionAction.Action, root: GModelElement | undefined, element: GModelElement | undefined): NodeActionRequest | undefined {
    const rootArgs = argsOf(root) ?? {};
    const sourceUri = rootArgs['sourceUri'];
    if (typeof sourceUri !== 'string' || sourceUri === '') {
        return undefined;
    }
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
    const request: NodeActionRequest = {
        action: action.action,
        sourceUri,
        ...(text(rootArgs['wf:selectedWorkflow']) ? { workflowName: text(rootArgs['wf:selectedWorkflow']) } : {}),
        ...(text(rootArgs['wf:view']) ? { view: text(rootArgs['wf:view']) } : {})
    };
    if (element && element !== root) {
        const args = argsOf(element) ?? {};
        const meta = args[WorkflowDiagramMetadata.NODE_META];
        const graphNodeId = text(args['wf:graphNodeId']);
        request.nodeId = graphNodeId ?? element.id;
        const label = text(args[WorkflowDiagramMetadata.ENTITY_NAME]) ?? text(args[WorkflowDiagramMetadata.PORT_NAME]);
        if (label) {
            request.label = label;
        }
        if (meta && typeof meta === 'object') {
            request.meta = meta as Record<string, unknown>;
        }
        if (action.port) {
            request.port = action.port;
        }
    }
    return request;
}

@injectable()
export class NodeActionActionHandler implements IActionHandler {
    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    handle(action: Action): ICommand | Action | void {
        if (!NodeActionAction.is(action)) {
            return;
        }
        const command = clientBehavior().nodeActionCommand;
        if (!command) {
            return;
        }
        const root = this.editorContext.modelRoot as unknown as GModelElement & { index?: { getById(id: string): GModelElement | undefined } };
        const element = action.elementId ? root.index?.getById(action.elementId) : root;
        if (action.elementId && !element) {
            return; // the node went with a reload between the click and here
        }
        const request = nodeActionRequest(action, root, element);
        if (!request) {
            return;
        }
        void VscodeUi.instance.executeCommand(command, [request]).catch(error => {
            console.warn('[dialogram] node action failed:', error);
        });
    }
}
