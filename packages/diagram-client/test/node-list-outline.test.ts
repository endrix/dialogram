// @vitest-environment happy-dom
/**
 * The node list: a viewer the product's opener cannot open yet is dimmed,
 * says why, and takes no click; one it can is opened by a double click
 * straight from the row, the opener given the node as the canvas would
 * draw it; its button sits under the hierarchy's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GModelElement } from '@eclipse-glsp/sprotty';
import { NODE_LIST_ARG, type HierarchyOutlineEntry, type NodeListOutline } from '@dialogram/shared';
import { NodeListOutlinePanel } from '../src/node-list-outline';
import { placeInButtonStack } from '../src/hierarchy-outline';
import type { NodeOpener, NodeOpenerContext } from '../src/node-opener';

const FILE = 'file:///w/top.py';
const TOKEN = 'wf:viewerLastToken';

const viewerRow = (path: string[], id: string, token?: string): HierarchyOutlineEntry => ({
    path, workflowName: 'top', role: 'node', nodeId: `g-${id}`, label: path[path.length - 1], family: 'viewer',
    detachedNode: {
        id, type: 'node:external-actor', args: { 'cal:entityName': path[path.length - 1] },
        edges: [{ id: `e-${id}`, type: 'edge:connection', sourceId: 'src_port_Out', targetId: `${id}_port_In`, args: token ? { [TOKEN]: token } : {} }],
        rootArgs: token ? { 'wf:viewerOverlayRunId': 'run-1' } : undefined
    },
    children: []
});

const listWith = (tokens: { report?: string; plot?: string }): NodeListOutline => ({
    title: 'Viewers',
    codicon: 'eye',
    outline: {
        path: [], workflowName: 'top', sourceUri: FILE,
        children: [
            viewerRow(['report'], 'n-report', tokens.report),
            {
                path: ['inner'], workflowName: 'inner', nodeId: 'g-inner',
                children: [viewerRow(['inner', 'plot'], 'n-plot', tokens.plot)]
            }
        ]
    }
});

const rootWith = (list: NodeListOutline) => ({
    id: 'graph', type: 'graph',
    args: { sourceUri: FILE, [NODE_LIST_ARG]: JSON.stringify(list) },
    children: []
});

/** An opener as a product's viewer opener is: it opens a node whose input carries a token. */
class TokenOpener implements NodeOpener {
    readonly id = 'viewer';
    readonly asked: Array<{ node: GModelElement; context: NodeOpenerContext }> = [];
    private tokenOf(node: GModelElement): string | undefined {
        const edges = ((node as any).root?.children ?? []).filter((child: any) => String(child.type).startsWith('edge'));
        const into = edges.find((edge: any) => edge.targetId === `${node.id}_port_In`);
        return into?.args?.[TOKEN];
    }
    canOpen(node: GModelElement): true | string {
        return this.tokenOf(node) ? true : 'Run the workflow first';
    }
    open(node: GModelElement, context: NodeOpenerContext) {
        this.asked.push({ node, context });
        return [{ kind: 'navigateToExternalTarget', target: { uri: this.tokenOf(node) ?? '' } } as any];
    }
}

class TestPanel extends NodeListOutlinePanel {
    readonly dispatched: any[] = [];
    constructor(opener: NodeOpener) {
        super();
        (this as any).dispatcher = { dispatch: (action: unknown) => { this.dispatched.push(action); return Promise.resolve(); } };
        (this as any).editorContext = { sourceUri: FILE, diagramType: 'x' };
        (this as any).contributedOpeners = [opener];
    }
}

const body = (): HTMLElement => document.getElementById('workflow-node-list-outline-body')!;
const rowSaying = (text: string): HTMLElement | undefined =>
    Array.from(body().querySelectorAll<HTMLElement>('.workflow-hierarchy-outline-row'))
        .find(row => row.querySelector('.workflow-hierarchy-outline-label')?.textContent === text);
const settle = () => new Promise(resolve => setTimeout(resolve, 260));

let opener: TokenOpener;
let panel: TestPanel;

beforeAll(() => {
    (globalThis as any).diagramIdentifier = { clientBehavior: { nestedNavigation: 'in-place' } };
});

afterAll(() => {
    delete (globalThis as any).diagramIdentifier;
});

beforeEach(() => {
    document.body.replaceChildren();
    try {
        localStorage.setItem('dialogram.nodeListOutline.open', '1');
    } catch {
        // happy-dom has it
    }
    opener = new TokenOpener();
    panel = new TestPanel(opener);
});

describe('the node list', () => {
    it('is the product\'s title and icon, every instance in it open', () => {
        panel.modelRootChanged(rootWith(listWith({})));
        const aside = document.getElementById('workflow-node-list-outline')!;
        expect(aside.classList.contains('workflow-node-list')).toBe(true);
        expect(aside.querySelector('.workflow-hierarchy-outline-title')?.textContent).toBe('Viewers');
        expect(document.querySelector('#workflow-node-list-outline-toggle .codicon-eye')).not.toBeNull();
        expect(rowSaying('plot')).toBeDefined();
    });

    it('dims a viewer before any run, says why, and takes neither click', async () => {
        panel.modelRootChanged(rootWith(listWith({})));
        const report = rowSaying('report')!;
        expect(report.classList.contains('unavailable')).toBe(true);
        expect(report.getAttribute('aria-disabled')).toBe('true');
        expect(report.title).toBe('Run the workflow first');
        report.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        report.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        expect(opener.asked).toHaveLength(0);
        expect(panel.dispatched).toHaveLength(0);
    });

    it('opens a viewer the run left a token for on a double click, without opening its view', async () => {
        panel.modelRootChanged(rootWith(listWith({ plot: '/runs/1/plot.png' })));
        expect(rowSaying('report')!.classList.contains('unavailable')).toBe(true);
        const plot = rowSaying('plot')!;
        expect(plot.classList.contains('unavailable')).toBe(false);
        plot.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        expect(opener.asked).toHaveLength(1);
        const { node, context } = opener.asked[0];
        expect(node.id).toBe('n-plot');
        expect((node as any).root.args['wf:viewerOverlayRunId']).toBe('run-1');
        expect(context.sourceUri).toBe(FILE);
        // The viewer's own action, and no request for the instance's view.
        expect(panel.dispatched.map(action => action.kind)).toEqual(['navigateToExternalTarget']);
        expect(panel.dispatched[0].target.uri).toBe('/runs/1/plot.png');
    });

    it('takes its title and icon from the list even when its button was made before', () => {
        // A model with no list first: the chrome is made, hidden, with the defaults.
        panel.modelRootChanged({ id: 'graph', type: 'graph', args: { sourceUri: FILE }, children: [] });
        panel.modelRootChanged(rootWith(listWith({})));
        const toggle = document.getElementById('workflow-node-list-outline-toggle')!;
        expect(toggle.querySelector('.codicon')?.className).toBe('codicon codicon-eye');
        expect(toggle.title).toBe('Viewers');
        expect(document.querySelector('#workflow-node-list-outline .workflow-hierarchy-outline-title')?.textContent).toBe('Viewers');
    });

    it('asks again when a run brings tokens', () => {
        panel.modelRootChanged(rootWith(listWith({})));
        expect(rowSaying('report')!.classList.contains('unavailable')).toBe(true);
        panel.modelRootChanged(rootWith(listWith({ report: '/runs/2/report.html' })));
        expect(rowSaying('report')!.classList.contains('unavailable')).toBe(false);
    });

    it('is offered only while the model carries one', () => {
        panel.modelRootChanged(rootWith(listWith({})));
        const toggle = document.getElementById('workflow-node-list-outline-toggle')!;
        expect(toggle.hidden).toBe(false);
        panel.modelRootChanged({ id: 'graph', type: 'graph', args: { sourceUri: FILE }, children: [] });
        expect(toggle.hidden).toBe(true);
    });
});

describe('its button', () => {
    it('sits directly under the hierarchy\'s, which sits under the chat\'s, whichever is placed first', () => {
        document.body.replaceChildren();
        const stack = document.createElement('div');
        stack.className = 'workflow-fab-stack';
        const chat = Object.assign(document.createElement('button'), { id: 'workflow-chat-toggle-btn' });
        const hierarchy = Object.assign(document.createElement('button'), { id: 'workflow-hierarchy-outline-toggle' });
        const list = Object.assign(document.createElement('button'), { id: 'workflow-node-list-outline-toggle' });
        stack.append(chat);
        document.body.append(stack, hierarchy, list);
        const under = ['workflow-hierarchy-outline-toggle', 'workflow-chat-toggle-btn'];
        for (let round = 0; round < 3; round++) {
            placeInButtonStack(list, document, under);
            placeInButtonStack(hierarchy);
        }
        // A reversed column: what comes first sits lowest.
        expect(Array.from(stack.children).map(button => button.id))
            .toEqual(['workflow-node-list-outline-toggle', 'workflow-hierarchy-outline-toggle', 'workflow-chat-toggle-btn']);
    });
});
