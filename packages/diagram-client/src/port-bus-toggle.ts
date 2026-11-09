/**
 * The toggle inside a bus port's dot: a press opens the bundle, or closes it.
 * The server keeps which bundles are open, in the layout file, and sends the
 * model back with the bundle's members drawn under its header.
 */
import { Ranked } from '@eclipse-glsp/client';
import { Action, GModelElement, MouseListener } from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import { TogglePortBusOperation } from '@dialogram/shared';

/** The attribute the port view puts on a bus port's dot: the port's id. */
export const PORT_BUS_TOGGLE_ATTR = 'data-port-bus-toggle';

/** The bus port whose toggle the event landed on, if it landed on one. */
export function portBusToggleOf(event: Pick<MouseEvent, 'target'>): string | undefined {
    const target = event.target as Element | null;
    const toggle = typeof target?.closest === 'function' ? target.closest(`[${PORT_BUS_TOGGLE_ATTR}]`) : null;
    const portId = toggle?.getAttribute(PORT_BUS_TOGGLE_ATTR);
    return portId ? portId : undefined;
}

@injectable()
export class PortBusToggleMouseListener extends MouseListener implements Ranked {
    // Ahead of the tools, so the press is a toggle and not the start of a drag.
    rank = 9;

    override mouseDown(_target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        if (event.button !== 0) {
            return [];
        }
        const portId = portBusToggleOf(event);
        if (!portId) {
            return [];
        }
        try {
            event.preventDefault();
            event.stopPropagation();
        } catch {
            // A synthetic event may not allow it; the toggle still applies.
        }
        return [TogglePortBusOperation.create({ portId })];
    }
}
