// @vitest-environment happy-dom
/**
 * The property panel after an edit: the new model it is handed is drawn, not
 * the one it was drawn from. A port retyped, renamed or taken out shows as it
 * is now; a node renamed away gives way to the network; a run's state on the
 * node draws nothing again; nor does a model that comes while the reader
 * types in the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata as M, WorkflowDiagramTypes as T } from '@dialogram/shared';
import { installPage } from './panel-harness/harness';
import { TestPanel, resetPanel } from './panel-harness/panel';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

function port(node: string, name: string, type: string, input: boolean): any {
    return {
        id: `${node}_port_${name}`,
        type: input ? T.PORT_INPUT : T.PORT_OUTPUT,
        args: { [M.PORT_NAME]: name, [M.PORT_TYPE]: type, [M.IS_INPUT_PORT]: input }
    };
}

/** `add`, an instance of Add, with the ports given (name, type, input?). */
function add(ports: Array<[string, string, boolean]>, name = 'add'): any {
    const id = `n:${name}`;
    const node: any = {
        id,
        type: T.NODE_ACTOR,
        args: { [M.ENTITY_NAME]: name, [M.ENTITY_TYPE]: 'Add' },
        children: ports.map(([p, type, input]) => port(id, p, type, input))
    };
    node.children.forEach((child: any) => { child.parent = node; });
    return node;
}

function rootWith(...nodes: any[]): any {
    const byId = new Map<string, any>();
    const visit = (e: any) => { byId.set(e.id, e); (e.children ?? []).forEach(visit); };
    nodes.forEach(visit);
    return { id: 'root', type: 'graph', args: { [M.NETWORK_NAME]: 'motion' }, children: nodes, index: { getById: (id: string) => byId.get(id) } };
}

const rows = () => [...document.querySelectorAll('.pp-prow')]
    .map(r => `${(r as HTMLElement).dataset.portName}:${r.querySelector('.pp-ptype')?.textContent?.trim()}`);
const content = () => document.getElementById('property-content')!;

const MOT: [string, string, boolean] = ['MOT', 'Int(8)', true];
const VID: [string, string, boolean] = ['VID', 'Int(8)', false];

beforeEach(() => {
    resetPanel();
    installPage({ networkPropertySections: true });
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the property panel after an edit', () => {
    it('shows a port retyped, renamed and taken out as the new model has it', () => {
        const panel = new TestPanel();
        const node = add([MOT, VID]);
        panel.show(node, rootWith(node));
        expect(rows()).toEqual(['MOT:Int(8)', 'VID:Int(8)']);

        panel.modelRootChanged(rootWith(add([['MOT', 'Int(9)', true], VID])));
        expect(rows()).toEqual(['MOT:Int(9)', 'VID:Int(8)']);

        panel.modelRootChanged(rootWith(add([['MOT', 'Int(9)', true], ['VIDEO', 'Int(8)', false]])));
        expect(rows()).toEqual(['MOT:Int(9)', 'VIDEO:Int(8)']);

        panel.modelRootChanged(rootWith(add([['VIDEO', 'Int(8)', false]])));
        expect(rows()).toEqual(['VIDEO:Int(8)']);
    });

    it('shows a selected port\'s node again when the port is renamed away', () => {
        const panel = new TestPanel();
        const node = add([MOT, VID]);
        const root = rootWith(node);
        (panel as any).lastRoot = root;
        (panel as any).updateContent(node.children[1]);
        panel.modelRootChanged(rootWith(add([MOT, ['VIDEO', 'Int(8)', false]])));
        expect(rows()).toEqual(['MOT:Int(8)', 'VIDEO:Int(8)']);
    });

    it('gives way to the network when the node shown is renamed away', () => {
        const panel = new TestPanel();
        const node = add([MOT]);
        panel.show(node, rootWith(node));
        panel.modelRootChanged(rootWith(add([MOT], 'adder')));
        expect(content().textContent).toContain('motion');
        expect(rows()).toEqual([]);
    });

    it('draws nothing again for a run\'s state on the node', () => {
        const panel = new TestPanel();
        const node = add([MOT, VID]);
        panel.show(node, rootWith(node));
        const drawn = content().firstElementChild;
        const running = add([MOT, VID]);
        running.args['wf:executionState'] = 'firing';
        panel.modelRootChanged(rootWith(running));
        expect(content().firstElementChild).toBe(drawn);
    });

    it('waits while something in the panel is typed into, and draws once the focus leaves the panel', async () => {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        const node = add([MOT]);
        panel.show(node, rootWith(node));
        const input = document.createElement('input');
        content().appendChild(input);
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        panel.modelRootChanged(rootWith(add([['MOT', 'Int(9)', true]])));
        expect(rows()).toEqual(['MOT:Int(8)']);
        input.blur();
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(rows()).toEqual(['MOT:Int(9)']);
    });

    it('draws the model a choice made in a list makes, the list keeping the focus', () => {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        const node = add([MOT]);
        panel.show(node, rootWith(node));
        const select = document.createElement('select');
        content().appendChild(select);
        select.focus();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        panel.modelRootChanged(rootWith(add([['MOT', 'Int(9)', true]])));
        expect(rows()).toEqual(['MOT:Int(9)']);
    });

    it('draws the model a value committed with Enter makes, the field keeping the focus', () => {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        const node = add([MOT]);
        panel.show(node, rootWith(node));
        const input = document.createElement('input');
        content().appendChild(input);
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        panel.modelRootChanged(rootWith(add([['MOT', 'Int(9)', true]])));
        expect(rows()).toEqual(['MOT:Int(9)']);
    });
});
