/**
 * The toggle in the header of a node holding a graph of its own, and in its
 * frame's header when open: a left press asks the server to open or close
 * it, a press anywhere else is left to the tools. The drawing is read from
 * the sources, as the other view tests do.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToggleNodeOpenOperation } from '@dialogram/shared';
import { NODE_OPEN_TOGGLE_ATTR, NodeOpenToggleMouseListener, nodeOpenToggle, nodeOpenToggleOf } from '../src/node-open-toggle';

function pressOn(nodeId: string | undefined, button = 0): MouseEvent & { stopped: boolean } {
    const toggle = nodeId ? { getAttribute: (name: string) => (name === NODE_OPEN_TOGGLE_ATTR ? nodeId : null) } : null;
    const event = {
        button,
        stopped: false,
        target: { closest: (selector: string) => (selector === `[${NODE_OPEN_TOGGLE_ATTR}]` ? toggle : null) },
        preventDefault() {},
        stopPropagation() { event.stopped = true; }
    };
    return event as unknown as MouseEvent & { stopped: boolean };
}

describe('the node toggle', () => {
    const listener = new NodeOpenToggleMouseListener();

    it('opens or closes the node it belongs to', () => {
        const event = pressOn('EndBusy');
        expect(listener.mouseDown({} as any, event)).toEqual([ToggleNodeOpenOperation.create({ nodeId: 'EndBusy' })]);
        expect(event.stopped).toBe(true);
    });

    it('leaves a press elsewhere, or with another button, to the tools', () => {
        expect(listener.mouseDown({} as any, pressOn(undefined))).toEqual([]);
        expect(listener.mouseDown({} as any, pressOn('EndBusy', 2))).toEqual([]);
        expect(nodeOpenToggleOf({ target: null })).toBeUndefined();
    });

    it('is a + to open and a − to close, carrying the element it toggles', () => {
        const drawn = (open: boolean) => nodeOpenToggle('n1', open, 'q', 10, 10) as any;
        // The test stub's svg: { tag, props, children }.
        expect(drawn(false).props.attrs[NODE_OPEN_TOGGLE_ATTR]).toBe('n1');
        const marks = (open: boolean) => drawn(open).children.filter((c: any) => c.props?.class?.['node-open-toggle-mark']).length;
        expect([marks(false), marks(true)]).toEqual([2, 1]);
    });

    it('is drawn in an openable node’s header and an open frame’s, and its listener is bound', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const views = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
        const module = readFileSync(path.resolve(here, '../src/stock-features.module.ts'), 'utf8');
        expect(views).toMatch(/NODE_OPENABLE\] === true\s*\?\s*\[nodeOpenToggle\(/);
        expect(views).toMatch(/openNode \? \[nodeOpenToggle\(String\(node\.id\), true/);
        expect(module).toMatch(/bindAsService\(context, TYPES\.MouseListener, NodeOpenToggleMouseListener\)/);
    });
});
