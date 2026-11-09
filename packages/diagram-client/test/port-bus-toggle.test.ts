/**
 * The toggle in front of a bus port's name: a left press on it asks the server
 * to open or close the bundle, and a press anywhere else is left to the tools.
 * The drawing is read from the sources, as the other view tests do, since the
 * views need a browser to render.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TogglePortBusOperation } from '@dialogram/shared';
import { PORT_BUS_TOGGLE_ATTR, PortBusToggleMouseListener, portBusToggleOf } from '../src/port-bus-toggle';

/** An element the press landed on, inside a toggle for `portId` or not. */
function pressOn(portId: string | undefined, button = 0): MouseEvent & { stopped: boolean } {
    const toggle = portId ? { getAttribute: (name: string) => (name === PORT_BUS_TOGGLE_ATTR ? portId : null) } : null;
    const event = {
        button,
        stopped: false,
        target: { closest: (selector: string) => (selector === `[${PORT_BUS_TOGGLE_ATTR}]` ? toggle : null) },
        preventDefault() {},
        stopPropagation() { event.stopped = true; }
    };
    return event as unknown as MouseEvent & { stopped: boolean };
}

describe('the bus toggle', () => {
    const listener = new PortBusToggleMouseListener();

    it('opens or closes the bundle of the port it belongs to', () => {
        const event = pressOn('u_prod_bus_out');
        expect(listener.mouseDown({} as any, event)).toEqual([TogglePortBusOperation.create({ portId: 'u_prod_bus_out' })]);
        expect(event.stopped).toBe(true);
    });

    it('leaves a press elsewhere, or with another button, to the tools', () => {
        expect(listener.mouseDown({} as any, pressOn(undefined))).toEqual([]);
        expect(listener.mouseDown({} as any, pressOn('u_prod_bus_out', 2))).toEqual([]);
        expect(portBusToggleOf({ target: null })).toBeUndefined();
    });

    it('is drawn in the port label, carrying its port, and is clickable where the label is not', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const views = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
        const css = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');
        const module = readFileSync(path.resolve(here, '../src/stock-features.module.ts'), 'utf8');
        expect(views).toMatch(/\[PORT_BUS_TOGGLE_ATTR\]: String\(port\?\.id/);
        expect(css).toMatch(/\.port-bus-toggle \{[^}]*pointer-events: all/);
        expect(module).toMatch(/bindAsService\(context, TYPES\.MouseListener, PortBusToggleMouseListener\)/);
    });

    it('is on top of the port’s hit area: both port views draw the label after it', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const views = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
        for (const view of ['WorkflowInputPortView', 'WorkflowOutputPortView']) {
            const body = views.slice(views.indexOf(`export class ${view}`));
            const end = body.indexOf('\n}\n');
            expect(body.slice(0, end)).toMatch(/\.\.\.children,\s*\.\.\.context\.renderChildren\(port\)/);
        }
    });

    it('does not open the node when double-clicked', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        for (const file of ['network-navigation-mouse-listener.ts', 'viewer-mouse-listener.ts']) {
            const source = readFileSync(path.resolve(here, '../src', file), 'utf8');
            expect(source, file).toMatch(/override doubleClick\(target: GModelElement, event: MouseEvent\)[^{]*\{[^}]*if \(portBusToggleOf\(event\)\) \{\s*return \[\];/);
        }
    });
});
