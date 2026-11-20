// @vitest-environment happy-dom
/**
 * The node list: a viewer the product's opener cannot open yet is dimmed,
 * says why, and takes no click; one it can is opened by a double click
 * straight from the row, the opener given the node as the canvas would
 * draw it; its button sits under the chat's and above the hierarchy's,
 * moving only the chat's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GModelElement } from '@eclipse-glsp/sprotty';
import { NODE_LIST_ARG, OUTLINE_REVEAL_MESSAGE, type HierarchyOutlineEntry, type NodeListOutline } from '@dialogram/shared';
import { NodeListOutlinePanel } from '../src/node-list-outline';
import { HierarchyOutlinePanel, outlineToggleId, placeInButtonStack } from '../src/hierarchy-outline';
import type { NodeOpener, NodeOpenerContext } from '../src/node-opener';

const FILE = 'file:///w/top.py';
const TOKEN = 'wf:viewerLastToken';

const viewerRow = (path: string[], id: string, token?: string): HierarchyOutlineEntry => ({
    path, workflowName: 'top', role: 'node', nodeId: `g-${id}`, label: path[path.length - 1], family: 'viewer',
    detachedNode: {
        id, type: 'node:external-actor', args: { 'cal:entityName': path[path.length - 1] },
        edges: [{ id: `e-${id}`, type: 'edge:connection', sourceId: 'src_port_Out', targetId: `${id}_port_In`, args: token ? { [TOKEN]: token } : {} }]
    },
    children: []
});

const listWith = (tokens: { report?: string; plot?: string }): NodeListOutline => ({
    title: 'Viewers',
    codicon: 'eye',
    ...(tokens.report || tokens.plot ? { rootArgs: { 'wf:viewerOverlayRunId': 'run-1' } } : {}),
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

    it('leaves the host\'s "show this row" to the hierarchy', async () => {
        try {
            localStorage.setItem('dialogram.nodeListOutline.open', '0');
        } catch {
            // happy-dom has it
        }
        const closed = new TestPanel(opener);
        closed.modelRootChanged(rootWith(listWith({})));
        window.dispatchEvent(new MessageEvent('message', { data: { type: OUTLINE_REVEAL_MESSAGE, payload: { id: 'inner', show: true } } }));
        await settle();
        expect(document.getElementById('workflow-node-list-outline')!.hidden).toBe(true);
    });

    it('says why a rejected opener could not open a row, and goes on', async () => {
        const rejecting: NodeOpener = {
            id: 'viewer',
            canOpen: () => true,
            open: () => [Promise.reject(new Error('no host'))]
        };
        const warned: unknown[] = [];
        const warn = console.warn;
        console.warn = (...args: unknown[]) => { warned.push(args[0]); };
        try {
            const own = new TestPanel(rejecting);
            own.modelRootChanged(rootWith(listWith({ plot: '/p' })));
            rowSaying('plot')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await settle();
        } finally {
            console.warn = warn;
        }
        expect(warned).toContain('[dialogram] a node list row could not be opened');
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
    // The panels of the tests above place their buttons again a frame after
    // each model: let those frames pass before a stack of these tests exists.
    beforeEach(async () => {
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
        document.body.replaceChildren();
    });

    const ORDER = ['run-history', 'workflow-hierarchy-outline-toggle', 'workflow-node-list-outline-toggle', 'workflow-chat-toggle-btn'];

    function buttons(): { stack: HTMLElement; run: HTMLElement; chat: HTMLElement; hierarchy: HTMLElement; list: HTMLElement } {
        document.body.replaceChildren();
        const stack = document.createElement('div');
        stack.className = 'workflow-fab-stack';
        const button = (id: string): HTMLElement => Object.assign(document.createElement('button'), { id });
        const parts = {
            stack,
            run: button('run-history'),
            chat: button('workflow-chat-toggle-btn'),
            hierarchy: button('workflow-hierarchy-outline-toggle'),
            list: button('workflow-node-list-outline-toggle')
        };
        stack.append(parts.run);
        document.body.append(stack);
        return parts;
    }

    const ids = (stack: HTMLElement): string[] => Array.from(stack.children).map(button => button.id);
    // Where each panel says its button goes, read from the panels themselves.
    const listUnder = (): string[] => (new TestPanel(opener) as any).config.under;
    const HIERARCHY_UNDER: string[] = (new HierarchyOutlinePanel() as any).config.under;

    it('sits under the chat\'s and above the hierarchy\'s, whichever is placed first', () => {
        for (const order of [['hierarchy', 'list'], ['list', 'hierarchy']] as const) {
            const parts = buttons();
            parts.stack.append(parts.chat);
            for (let round = 0; round < 3; round++) {
                for (const which of order) {
                    placeInButtonStack(parts[which], document, which === 'list' ? listUnder() : HIERARCHY_UNDER);
                }
            }
            // A reversed column: what comes first sits lowest.
            expect(ids(parts.stack)).toEqual(ORDER);
        }
    });

    it('stays under the chat\'s when the chat\'s joins the stack after it', () => {
        const parts = buttons();
        placeInButtonStack(parts.hierarchy, document, HIERARCHY_UNDER);
        placeInButtonStack(parts.list, document, listUnder());
        // The navigation appends the chat's button when it first draws.
        parts.stack.appendChild(parts.chat);
        // Each panel places its button again a frame later.
        placeInButtonStack(parts.hierarchy, document, HIERARCHY_UNDER);
        placeInButtonStack(parts.list, document, listUnder());
        expect(ids(parts.stack)).toEqual(ORDER);
    });

    it('is placed under the chat\'s by the panel itself, and the hierarchy\'s under it, by the button the panel draws', () => {
        expect(listUnder()).toEqual(['workflow-chat-toggle-btn']);
        expect(HIERARCHY_UNDER).toEqual(['workflow-node-list-outline-toggle', 'workflow-chat-toggle-btn']);
        // The id the hierarchy places under is the one the list's panel gives its button.
        expect(outlineToggleId((new TestPanel(opener) as any).config.id)).toBe(HIERARCHY_UNDER[0]);
    });

    it('moves only the chat\'s button when it shows or hides', () => {
        const parts = buttons();
        parts.stack.append(parts.chat);
        placeInButtonStack(parts.hierarchy, document, HIERARCHY_UNDER);
        placeInButtonStack(parts.list, document, listUnder());

        // Only the chat's comes after it, so only the chat's can shift when it hides.
        expect(parts.list.nextElementSibling).toBe(parts.chat);
        expect(parts.hierarchy.nextElementSibling).toBe(parts.list);
    });

    it('leaves the hierarchy\'s under the chat\'s in a product without a node list', () => {
        const parts = buttons();
        parts.stack.append(parts.chat);
        placeInButtonStack(parts.hierarchy, document, HIERARCHY_UNDER);
        expect(ids(parts.stack)).toEqual(['run-history', 'workflow-hierarchy-outline-toggle', 'workflow-chat-toggle-btn']);
    });
});
