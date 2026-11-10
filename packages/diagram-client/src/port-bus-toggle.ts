/**
 * The toggle inside a bus port's dot: a press opens the bundle, or closes it.
 * The server keeps which bundles are open, in the layout file, and sends the
 * model back with the bundle's members drawn under its header.
 */
import { Ranked } from '@eclipse-glsp/client';
import { Action, GModelElement, MouseListener } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import { TogglePortBusOperation } from '@dialogram/shared';
import { ToggleAnchor } from './toggle-anchor';

/** The attribute the port view puts on a bus port's dot: the port's id. */
export const PORT_BUS_TOGGLE_ATTR = 'data-port-bus-toggle';

/** The value of `attr` on the toggle the event landed in, if it landed in one. */
export function toggleTargetOf(event: Pick<MouseEvent, 'target'>, attr: string): string | undefined {
    const target = event.target as Element | null;
    const toggle = typeof target?.closest === 'function' ? target.closest(`[${attr}]`) : null;
    const value = toggle?.getAttribute(attr);
    return value ? value : undefined;
}

/**
 * A left press in a toggle carrying `attr`: the action it asks for, the event
 * kept from the tools (so it is a toggle, not the start of a drag); else none.
 */
export function pressToggle(event: MouseEvent, attr: string, toAction: (value: string) => Action): Action[] {
    if (event.button !== 0) {
        return [];
    }
    const value = toggleTargetOf(event, attr);
    if (!value) {
        return [];
    }
    try {
        event.preventDefault();
        event.stopPropagation();
    } catch {
        // A synthetic event may not allow it; the toggle still applies.
    }
    return [toAction(value)];
}

/** The bus port whose toggle the event landed on, if it landed on one. */
export function portBusToggleOf(event: Pick<MouseEvent, 'target'>): string | undefined {
    return toggleTargetOf(event, PORT_BUS_TOGGLE_ATTR);
}

@injectable()
export class PortBusToggleMouseListener extends MouseListener implements Ranked {
    // Ahead of the tools, so the press is a toggle and not the start of a drag.
    rank = 9;

    /** Keeps the bus where it was on screen once the view is laid out again. */
    @inject(ToggleAnchor) @optional() protected readonly anchor?: ToggleAnchor;

    override mouseDown(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        return pressToggle(event, PORT_BUS_TOGGLE_ATTR, portId => {
            this.anchor?.remember(target.root, portId);
            return TogglePortBusOperation.create({ portId });
        });
    }
}
