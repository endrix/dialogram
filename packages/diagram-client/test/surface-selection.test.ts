// @vitest-environment happy-dom
/**
 * A diagram surface's selection reaches the property panel and the chat as a
 * node's does: the panel draws Basic Info and the surface's sections with
 * the panel's own section builder, its links go back to the surface, it
 * stays through the platform's own model updates, and it goes when cleared;
 * a double-click on the graph's whitespace is the surface's when it hears
 * clicks, so the root's properties do not replace what it selected, and the
 * panel shows them by itself there while nothing is selected, from the first
 * model on; the chat is told a capped summary on every change and with every
 * message.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata as M } from '@dialogram/shared';
import { installPage } from './panel-harness/harness';
import { TestPanel, resetPanel, rootOf, section, tick } from './panel-harness/panel';
import { DiagramSurfaceHost } from '../src/diagram-surface-host';
import { ChatPanel } from '../src/chat-panel-integrated';
import { WhitespaceRootPropertiesMouseListener } from '../src/whitespace-root-properties-mouse-listener';
import { summarizeSurfaceSelection, type DiagramSurface, type DiagramSurfaceContext, type SurfaceSelection } from '../src/diagram-surface';
import { render, type TemplateResult } from 'lit';
import { ppNumberField } from '../src/property-fields';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

const via: SurfaceSelection = {
    ids: ['shape:42'],
    title: 'Rectangle 42',
    kind: 'Rectangle',
    note: '1 of 2 here: click again for the one beneath',
    source: { uri: 'file:///w/shapes.txt', line: 12 },
    sections: [
        {
            title: 'Geometry',
            rows: [
                { label: 'Width', value: 12 },
                { label: 'Next', value: 'Rectangle 43', link: 'shape:43' },
                { label: 'Around', value: [{ text: 'Rectangle 41', link: 'shape:41' }, { text: ', ' }, { text: 'Rectangle 43', link: 'shape:43' }] }
            ],
            more: 7
        },
        { title: 'Notes', rows: [{ label: 'Note', value: 'drawn last' }], collapsed: true }
    ],
    bounds: { x: 420, y: 0, width: 12, height: 9 }
};

/**
 * A host with a surface whose context the test drives, and the links it was
 * asked to follow. The surface is mounted at once, as at a first render,
 * unless `mounted: false`: `mount()` mounts it then.
 */
function surfaceHost(
    click?: DiagramSurface['click'],
    options: { mounted?: boolean } = {}
): { host: DiagramSurfaceHost; context: () => DiagramSurfaceContext; followed: string[]; mount: () => void } {
    let context: DiagramSurfaceContext | undefined;
    const followed: string[] = [];
    const surface: DiagramSurface = {
        id: 'probe',
        mount: c => { context = c; return document.createElement('canvas'); },
        render: () => undefined,
        followLink: link => { followed.push(link); },
        ...(click ? { click } : {})
    };
    const host = new DiagramSurfaceHost();
    Object.assign(host as any, {
        contributedSurfaces: [surface],
        actionDispatcher: { dispatch: async () => undefined },
        viewerOptions: { baseDiv: 'diagram' }
    });
    const base = document.createElement('div');
    base.id = 'diagram';
    base.innerHTML = '<svg></svg>';
    document.body.appendChild(base);
    const root = { id: 'graph', type: 'graph', zoom: 1, scroll: { x: 0, y: 0 }, canvasBounds: { x: 0, y: 0, width: 800, height: 600 }, args: {} };
    const mount = () => {
        host.decorate({}, root);
        host.postUpdate();
    };
    if (options.mounted !== false) {
        mount();
    }
    return { host, context: () => context!, followed, mount };
}

function panelOn(host: DiagramSurfaceHost): TestPanel {
    const panel = new TestPanel();
    (panel as any).surfaceHost = host;
    (panel as any).installNodeSections();
    return panel;
}

const rows = (title: string) => [...section(title)!.querySelectorAll('.pp-arow')]
    .map(row => [row.querySelector('.pp-akey')!.textContent!.trim(), row.querySelector('.pp-aval')!.textContent!.replace(/\s+/g, ' ').trim()]);

const graph = { type: 'graph' } as never;
const mouse = (detail: number) => ({ clientX: 40, clientY: 30, button: 0, detail, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });

/** A double-click on the graph's whitespace: its two listeners in the order a browser runs them, the second mouseup, then dblclick. */
function doubleClick(host: DiagramSurfaceHost | undefined, panel: TestPanel): void {
    host?.click(mouse(2));
    const listener = new WhitespaceRootPropertiesMouseListener();
    Object.assign(listener as any, { propertyPanel: panel, surfaceHost: host });
    expect(listener.doubleClick(graph, new MouseEvent('dblclick'))).toEqual([]);
}

/** The chat panel on a host, and what it sent its own host. */
function chatOn(host: DiagramSurfaceHost) {
    const sent: Array<{ method: string; env: any }> = [];
    const chat = new ChatPanel();
    (chat as any).channel = { sendToHost: (method: string, env: any) => sent.push({ method, env }) };
    (chat as any).surfaceHost = host;
    // A chat is open: a message sent with none waits for its session first
    // (chat-panel-first-message.test.ts).
    (chat as any).currentSessionId = 's1';
    (chat as any).listenToSurface();
    (globalThis as any).diagramIdentifier = { uri: 'file:///w/shapes.txt' };
    return { chat, sent };
}

beforeEach(() => {
    resetPanel();
    installPage();
});

afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    document.body.innerHTML = '';
});

describe('the property panel shows a surface\'s selection', () => {
    it('as Basic Info, a note, an Opens row, then the surface\'s sections', () => {
        const { host, context } = surfaceHost();
        panelOn(host);
        context().setSelection(via);

        expect(rows('Basic Info')).toEqual([['Name', 'Rectangle 42'], ['Type', 'Rectangle'], ['Opens', '…/w/shapes.txt:12']]);
        expect(section('Basic Info')!.querySelector('.pp-surface-note')!.textContent).toBe('1 of 2 here: click again for the one beneath');
        expect(section('Basic Info')!.querySelector('a[href]')!.getAttribute('href')).toBe('file:///w/shapes.txt#L12');
        expect(rows('Geometry')).toEqual([['Width', '12'], ['Next', 'Rectangle 43'], ['Around', 'Rectangle 41, Rectangle 43']]);
        expect(section('Geometry')!.querySelector('.pp-surface-more')!.textContent).toBe('and 7 more');
        expect(section('Notes')!.classList.contains('collapsed')).toBe(true);
    });

    it('hands a link back to the surface, by click and by key, and never as an href', () => {
        const { host, context, followed } = surfaceHost();
        panelOn(host);
        context().setSelection(via);
        const links = [...section('Geometry')!.querySelectorAll<HTMLElement>('.pp-surface-link')];
        expect(links.map(link => link.textContent)).toEqual(['Rectangle 43', 'Rectangle 41', 'Rectangle 43']);
        expect(links.every(link => !link.hasAttribute('href'))).toBe(true);
        links[0].click();
        links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(followed).toEqual(['shape:43', 'shape:41']);
    });

    it('stays through the platform\'s own model updates', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        context().setSelection(via);
        panel.modelRootChanged(rootOf({ id: 'n1', type: 'node:task', args: {}, children: [] }) as never);
        // The deselection a model update brings is the graph's, and empty.
        host.selectionChanged(undefined, []);
        panel.selectionChanged(rootOf(), []);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
        expect(host.currentSelection()?.title).toBe('Rectangle 42');
    });

    it('stays in the panel after a click on nothing clears it, as a node deselected by a click does', () => {
        const { host, context } = surfaceHost();
        panelOn(host);
        context().setSelection(via);
        host.click({ clientX: 40, clientY: 30, button: 0, detail: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
        expect(host.currentSelection()).toBeUndefined();
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
    });

    it('goes when Escape clears it, and gives way to a node selected', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        context().setSelection(via);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(section('Geometry')).toBeUndefined();

        context().setSelection(via);
        const node = { id: 'n1', type: 'node:task', args: { 'wf:entityName': 'first' }, children: [] };
        panel.selectionChanged(rootOf(node), ['n1']);
        host.selectionChanged(undefined, ['n1']);
        expect(section('Geometry')).toBeUndefined();
        expect(host.currentSelection()).toBeUndefined();
    });
});

describe('a double-click on the graph\'s whitespace', () => {
    it('is the surface\'s, when it hears clicks: what it selected stays in the panel', () => {
        const counts: number[] = [];
        let context: () => DiagramSurfaceContext = () => { throw new Error('not mounted'); };
        const mounted = surfaceHost(point => {
            counts.push(point.clickCount);
            if (point.clickCount >= 2) {
                context().setSelection(via);
            }
        });
        context = mounted.context;
        const panel = panelOn(mounted.host);
        panel.modelRootChanged(rootOf() as never);

        doubleClick(mounted.host, panel);

        expect(counts).toEqual([2]);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
        expect(section('Geometry')).toBeDefined();
        expect(mounted.host.currentSelection()?.title).toBe('Rectangle 42');
    });

    it('still shows the root\'s properties over a surface that does not hear clicks', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        panel.modelRootChanged(rootOf() as never);
        context().setSelection(via);
        expect(section('Geometry')).toBeDefined();

        doubleClick(host, panel);

        expect(section('Geometry')).toBeUndefined();
    });

    it('still shows the root\'s properties where no surface is bound', () => {
        const panel = new TestPanel();
        panel.show({ id: 'the-node', type: 'node:task', args: {}, children: [] });
        expect(rows('Basic Info')[0]).toEqual(['Name', 'the-node']);

        doubleClick(undefined, panel);

        expect(document.getElementById('property-content')!.textContent).not.toContain('the-node');
    });
});

describe('the chat is told a surface\'s selection', () => {
    it('on every change, as a summary without link targets, and cleared', () => {
        const { host, context } = surfaceHost();
        const { sent } = chatOn(host);
        context().setSelection(via);
        const told = sent.filter(s => s.env?.type === 'chat.selection').map(s => s.env.data);
        expect(told.at(-1).selectedNodeIds).toEqual([]);
        expect(told.at(-1).surfaceSelection).toEqual({
            ids: ['shape:42'],
            title: 'Rectangle 42',
            kind: 'Rectangle',
            rows: [
                { section: 'Geometry', label: 'Width', value: '12' },
                { section: 'Geometry', label: 'Next', value: 'Rectangle 43' },
                { section: 'Geometry', label: 'Around', value: 'Rectangle 41, Rectangle 43' },
                { section: 'Notes', label: 'Note', value: 'drawn last' }
            ]
        });
        context().setSelection(undefined);
        expect(sent.filter(s => s.env?.type === 'chat.selection').at(-1)!.env.data.surfaceSelection).toBeUndefined();
    });

    it('with the message sent, without a turn being needed to see it', () => {
        const { host, context } = surfaceHost();
        const { chat, sent } = chatOn(host);
        context().setSelection(via);
        (chat as any).inputValue = 'what is this?';
        (chat as any).sendMessage();
        const message = sent.find(s => s.env?.type === 'chat.sendMessage');
        expect(message!.env.data.surfaceSelection.title).toBe('Rectangle 42');
    });

    it('capped: never a dump of a large selection', () => {
        const many: SurfaceSelection = {
            ids: Array.from({ length: 500 }, (_, i) => `shape:${i}`),
            title: 'Many',
            sections: [{ title: 'All', rows: Array.from({ length: 500 }, (_, i) => ({ label: `r${i}`, value: 'x'.repeat(1000) })) }]
        };
        const summary = summarizeSurfaceSelection(many);
        expect(summary.ids).toHaveLength(50);
        expect(summary.rows).toHaveLength(40);
        expect(summary.rows[0].value.length).toBe(200);
    });
});

describe('over a surface that hears clicks, the panel opens on the view\'s own properties', () => {
    /** What the editor provider writes into the panel before any model. */
    const HINT = '<div class="no-selection">Select an element to view properties</div>';
    const hint = () => document.querySelector('#property-content .no-selection')?.textContent;
    const node = { id: 'n1', type: 'node:task', args: { [M.ENTITY_NAME]: 'first' }, children: [] };

    /** The page as the editor provider writes it: the panel holds the hint. */
    function freshPage(): void {
        installPage();
        document.getElementById('property-content')!.innerHTML = HINT;
    }

    /** A view's root, as a layout viewer's producer sends it: of the view itself, a name and a fact. */
    function view(cells = '1200', ...nodes: any[]): any {
        return { ...rootOf(...nodes), args: { [M.READ_ONLY_VIEW]: true, [M.NETWORK_NAME]: 'top', [M.FACTS]: [{ label: 'Cells', value: cells }] } };
    }

    /** The view's own properties as the panel shows them; undefined while it shows anything else. */
    function viewShown(): string[][] | undefined {
        const name = section('View')?.querySelector('.property-value')?.textContent?.trim();
        return name === undefined ? undefined : [['Name', name], ...rows('Facts')];
    }

    /** A click on nothing: the graph's deselection, then the surface's click, which this surface leaves unanswered. */
    function clickOnNothing(host: DiagramSurfaceHost, panel: TestPanel, root: any): void {
        panel.selectionChanged(root, []);
        host.selectionChanged(undefined, []);
        host.click(mouse(1));
    }

    beforeEach(freshPage);

    it('from the first model, whether the surface mounts before it comes or after', () => {
        const drawn: string[] = [];
        for (const modelFirst of [false, true]) {
            freshPage();
            const { host, mount } = surfaceHost(() => undefined, { mounted: !modelFirst });
            const panel = panelOn(host);
            panel.modelRootChanged(view() as never);
            if (modelFirst) {
                expect(hint()).toBe('Select an element to view properties');
                mount();
            }
            expect(hint()).toBeUndefined();
            expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);
            drawn.push(document.getElementById('property-content')!.innerHTML);
            window.dispatchEvent(new Event('pagehide'));
        }
        expect(drawn[1]).toBe(drawn[0]);
    });

    it('never in place of a node or a surface\'s selection, when a model comes or the surface mounts', () => {
        const { host, context } = surfaceHost(() => undefined);
        const panel = panelOn(host);
        panel.modelRootChanged(view('1200', node) as never);
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);

        panel.selectionChanged(view('1200', node), ['n1']);
        host.selectionChanged(undefined, ['n1']);
        panel.modelRootChanged(view('1300', node) as never);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);

        context().setSelection(via);
        panel.modelRootChanged(view('1400', node) as never);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
        window.dispatchEvent(new Event('pagehide'));

        // A node selected before the surface mounts stays when it mounts.
        freshPage();
        const later = surfaceHost(() => undefined, { mounted: false });
        const second = panelOn(later.host);
        second.modelRootChanged(view('1200', node) as never);
        second.selectionChanged(view('1200', node), ['n1']);
        later.mount();
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);
        expect(viewShown()).toBeUndefined();
    });

    it('follows the model while it shows them, and draws nothing again for a model that changes none of them', () => {
        const { host } = surfaceHost(() => undefined);
        const panel = panelOn(host);
        panel.modelRootChanged(view('1200') as never);
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);
        const drawn = section('View');

        panel.modelRootChanged(view('1200') as never);
        expect(section('View')).toBe(drawn);

        panel.modelRootChanged(view('1300') as never);
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1300']]);
    });

    it('only there: without a surface, or over one that hears no clicks, the hint stays until a double-click shows them', () => {
        const hosts: Array<() => DiagramSurfaceHost | undefined> = [
            () => undefined,
            () => {
                // The stock modules bind a host for every product; this one has no surface bound.
                const bare = new DiagramSurfaceHost();
                Object.assign(bare as any, { actionDispatcher: { dispatch: async () => undefined }, viewerOptions: { baseDiv: 'diagram' } });
                bare.decorate({}, { id: 'graph', type: 'graph', zoom: 1, scroll: { x: 0, y: 0 }, canvasBounds: { x: 0, y: 0, width: 800, height: 600 } });
                bare.postUpdate();
                return bare;
            },
            () => surfaceHost().host
        ];
        for (const make of hosts) {
            freshPage();
            const host = make();
            const panel = host ? panelOn(host) : new TestPanel();
            panel.modelRootChanged(view() as never);
            expect(hint()).toBe('Select an element to view properties');

            doubleClick(host, panel);
            expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);
            window.dispatchEvent(new Event('pagehide'));
        }

        freshPage();
        panelOn(surfaceHost(() => undefined).host).modelRootChanged(view() as never);
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);
    });

    it('keeps what the panel shows on a click on nothing, through the models that come after it', () => {
        const { host, context } = surfaceHost(() => undefined);
        const panel = panelOn(host);
        panel.modelRootChanged(view('1200', node) as never);
        clickOnNothing(host, panel, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);

        // Nothing is selected after the click, and the node stays in the panel all the same.
        panel.selectionChanged(view('1200', node), ['n1']);
        host.selectionChanged(undefined, ['n1']);
        clickOnNothing(host, panel, view('1200', node));
        panel.modelRootChanged(view('1300', node) as never);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);

        context().setSelection(via);
        clickOnNothing(host, panel, view('1300', node));
        panel.modelRootChanged(view('1400', node) as never);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
    });

    it('selects nothing: the graph is asked to select nothing, and the chat is told of no selection', () => {
        const { host } = surfaceHost(() => undefined);
        const { chat, sent } = chatOn(host);
        const panel = panelOn(host);
        panel.modelRootChanged(view() as never);
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);

        expect(panel.dispatched).toEqual([]);
        expect(host.currentSelection()).toBeUndefined();
        expect(sent.filter(s => s.env?.type === 'chat.selection')).toEqual([]);
        (chat as any).inputValue = 'what is this?';
        (chat as any).sendMessage();
        const message = sent.find(s => s.env?.type === 'chat.sendMessage')!.env.data;
        expect(message.selectedNodeIds).toEqual([]);
        expect(message.surfaceSelection).toBeUndefined();
    });

    it('waits while something in the panel is typed into, and shows them once the focus leaves the panel', async () => {
        const { host } = surfaceHost(() => undefined);
        const panel = panelOn(host);
        (panel as any).initializeEditTracking();
        const input = document.createElement('input');
        document.getElementById('property-content')!.appendChild(input);
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        input.value = 'a';

        panel.modelRootChanged(view() as never);
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('a');
        expect(hint()).toBe('Select an element to view properties');

        input.blur();
        await tick();
        expect(viewShown()).toEqual([['Name', 'top'], ['Cells', '1200']]);
    });
});

/**
 * Where the product asks (`clientBehavior.viewFactsWhileNothingSelected`),
 * the panel shows a view's own facts (`graph.meta.facts`) while nothing is
 * selected, with or without a surface: at the open, in place of the hint, and
 * again when a click on nothing clears a selection. Without it, the panel is
 * as the describe above holds it, for a view with facts too.
 */
describe('a view with facts of its own, where the product asks for them while nothing is selected', () => {
    const HINT = '<div class="no-selection">Select an element to view properties</div>';
    const hint = () => document.querySelector('#property-content .no-selection')?.textContent;
    const node = { id: 'n1', type: 'node:task', args: { [M.ENTITY_NAME]: 'first' }, children: [] };

    /** The page as the editor provider writes it for a product that asks: the panel holds the hint. */
    function freshPage(): void {
        installPage({ viewFactsWhileNothingSelected: true });
        document.getElementById('property-content')!.innerHTML = HINT;
    }

    /** A view's root with a name and a fact (`count`), or a name alone (`count: null`). */
    function view(count: string | null = '1200', ...nodes: any[]): any {
        const facts = count === null ? {} : { [M.FACTS]: [{ label: 'Nodes', value: count }] };
        return { ...rootOf(...nodes), args: { [M.READ_ONLY_VIEW]: true, [M.NETWORK_NAME]: 'top', ...facts } };
    }

    function viewShown(): string[][] | undefined {
        const name = section('View')?.querySelector('.property-value')?.textContent?.trim();
        return name === undefined ? undefined : [['Name', name], ...(section('Facts') ? rows('Facts') : [])];
    }

    /** The node selected, as GLSP tells the panel and the surface host. */
    function selectNode(panel: TestPanel, host: DiagramSurfaceHost | undefined, root: any): void {
        panel.selectionChanged(root, ['n1']);
        host?.selectionChanged(root, ['n1']);
    }

    /** A click on nothing that clears the node: GLSP's deselection, then the surface's click. */
    function clickOnNothing(panel: TestPanel, host: DiagramSurfaceHost | undefined, root: any): void {
        panel.selectionChanged(root, [], ['n1']);
        host?.selectionChanged(root, []);
        host?.click(mouse(1));
    }

    /** No surface; the stock host with no surface in it; a surface that hears no clicks. */
    const hosts: Array<() => DiagramSurfaceHost | undefined> = [
        () => undefined,
        () => {
            const bare = new DiagramSurfaceHost();
            Object.assign(bare as any, { actionDispatcher: { dispatch: async () => undefined }, viewerOptions: { baseDiv: 'diagram' } });
            bare.decorate({}, { id: 'graph', type: 'graph', zoom: 1, scroll: { x: 0, y: 0 }, canvasBounds: { x: 0, y: 0, width: 800, height: 600 } });
            bare.postUpdate();
            return bare;
        },
        () => surfaceHost().host
    ];

    beforeEach(freshPage);

    it('shows them from the first model, in place of the hint, with or without a surface, and selects nothing', () => {
        for (const make of hosts) {
            freshPage();
            const host = make();
            const panel = host ? panelOn(host) : new TestPanel();
            panel.modelRootChanged(view() as never);

            expect(hint()).toBeUndefined();
            expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
            expect(panel.dispatched).toEqual([]);
            window.dispatchEvent(new Event('pagehide'));
        }
    });

    it('shows them once a click on nothing clears a node\'s selection, with or without a surface, and follows the model', () => {
        for (const make of hosts) {
            freshPage();
            const host = make();
            const panel = host ? panelOn(host) : new TestPanel();
            panel.modelRootChanged(view('1200', node) as never);
            selectNode(panel, host, view('1200', node));
            expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);

            clickOnNothing(panel, host, view('1200', node));
            expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);

            panel.modelRootChanged(view('1300', node) as never);
            expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1300']]);
            window.dispatchEvent(new Event('pagehide'));
        }
    });

    it('shows them once a click on nothing clears a surface\'s selection', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        panel.modelRootChanged(view() as never);
        context().setSelection(via);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);

        host.click(mouse(1));

        expect(host.currentSelection()).toBeUndefined();
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('never over a surface\'s selection: a shape picked while a node was selected stays, as the graph lets the node go', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        const root = view('1200', node);
        panel.modelRootChanged(root as never);
        selectNode(panel, host, root);
        // The reader picks a shape: the host shows it and asks GLSP to let the node go, which it reports after.
        context().setSelection(via);
        panel.selectionChanged(root, [], ['n1']);
        host.selectionChanged(root, []);

        expect(host.currentSelection()?.title).toBe('Rectangle 42');
        expect(rows('Basic Info')[0]).toEqual(['Name', 'Rectangle 42']);
        expect(viewShown()).toBeUndefined();
    });

    it('pinned or not: the pin keeps the panel visible and keeps no content', () => {
        const panel = new TestPanel();
        (panel as any).chrome.pinned = true;
        panel.modelRootChanged(view('1200', node) as never);
        selectNode(panel, undefined, view('1200', node));
        clickOnNothing(panel, undefined, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('does not take the place of a node a selection gone with the model gave way to', () => {
        // A port shown, then renamed by an edit: the model no longer has it,
        // the panel shows its node, and GLSP reports the port deselected.
        // That is the model's doing, not the reader's.
        const withPort = (portId: string) => {
            const port: any = { id: portId, type: 'port:input', args: { [M.IS_INPUT_PORT]: true }, children: [] };
            const owner: any = { ...node, children: [port] };
            port.parent = owner;
            const root = view('1200', owner);
            const byId = new Map<string, any>([[owner.id, owner], [port.id, port]]);
            root.index = { getById: (id: string) => byId.get(id) };
            return root;
        };
        const panel = new TestPanel();
        panel.modelRootChanged(withPort('n1.p') as never);
        panel.selectionChanged(withPort('n1.p'), ['n1.p']);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);

        const after = withPort('n1.q');
        panel.modelRootChanged(after as never);
        panel.selectionChanged(after, [], ['n1.p']);

        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);
        expect(viewShown()).toBeUndefined();
    });

    it('keeps a field that holds text typed and not committed after the focus left it, until Enter commits it', () => {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        panel.modelRootChanged(view('1200', node) as never);
        selectNode(panel, undefined, view('1200', node));
        const input = document.createElement('input');
        // As a field whose Enter commits does: it takes the key.
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
            }
        });
        document.getElementById('property-content')!.appendChild(input);
        input.focus();
        input.value = 'typed, not committed';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        // The click on nothing takes the focus first.
        input.blur();

        clickOnNothing(panel, undefined, view('1200', node));
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('typed, not committed');

        // Committed with Enter, before any model comes of it: the next click on nothing shows the view.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        clickOnNothing(panel, undefined, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    /** A node selected, the panel's edit tracking on, and `field` put in its content and typed into. */
    function typedInto(field: HTMLInputElement | HTMLTextAreaElement | HTMLElement): TestPanel {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        panel.modelRootChanged(view('1200', node) as never);
        selectNode(panel, undefined, view('1200', node));
        const content = document.getElementById('property-content')!;
        if (!field.isConnected) {
            content.appendChild(field);
        }
        const input = (field.matches('input, textarea') ? field : field.querySelector('input, textarea'))! as HTMLInputElement;
        input.focus();
        input.value = 'typed';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return panel;
    }

    it('takes a change of the producer\'s field as its commit, as Enter: the next click on nothing shows them', () => {
        const probe = new TestPanel();
        const section = (probe as any).buildProducerFieldsSection('n1', [{ name: 'mode', value: 'typed' }]) as HTMLElement;
        const panel = typedInto(section);
        const input = section.querySelector('input')!;
        // Committed by its change (the value as it was: no model comes of it), then the focus leaves.
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        clickOnNothing(panel, undefined, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('takes no change of the panel\'s own fields as a commit (Enter or their button commits them): the typed text stays', () => {
        const input = document.createElement('input');
        const panel = typedInto(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        clickOnNothing(panel, undefined, view('1200', node));
        expect(input.isConnected).toBe(true);
    });

    /** A field the panel draws, rendered into its content. */
    function drawn(template: TemplateResult): HTMLElement {
        const holder = document.createElement('div');
        document.getElementById('property-content')!.appendChild(holder);
        render(template, holder);
        return holder;
    }
    const enter = (field: Element, keys: KeyboardEventInit = {}) =>
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...keys }));

    it('takes no Enter as a commit where the field commits nothing on it (an annotation\'s argument row): the typed text stays', () => {
        const input = document.createElement('input');
        input.className = 'annotation-input annotation-add-value';
        const panel = typedInto(input);
        enter(input);
        input.blur();
        clickOnNothing(panel, undefined, view('1200', node));
        expect(input.isConnected).toBe(true);
    });

    it('takes the Enter of each field whose Enter commits as its commit: the panel\'s value field, a field of lines on Ctrl+Enter, the number field, the producer\'s field', () => {
        const probe = new TestPanel();
        const fields: Array<[string, () => HTMLElement, KeyboardEventInit]> = [
            ['value field', () => drawn((probe as any).sourceField('x', { className: 'param-map-input', onCommit: () => undefined })), {}],
            ['field of lines', () => drawn((probe as any).sourceField('a\nb', { className: 'param-map-input', onCommit: () => undefined })), { ctrlKey: true }],
            ['number field', () => drawn(ppNumberField({ value: 3, onCommit: () => undefined })), {}],
            ['producer\'s field', () => (probe as any).buildProducerFieldsSection('n1', [{ name: 'mode', value: 'typed' }]), {}]
        ];
        for (const [kind, make, keys] of fields) {
            const holder = make();
            const panel = typedInto(holder);
            const field = holder.querySelector('input, textarea')!;
            enter(field, keys);
            (field as HTMLElement).blur();
            clickOnNothing(panel, undefined, view('1200', node));
            expect(viewShown(), kind).toEqual([['Name', 'top'], ['Nodes', '1200']]);
        }
    });

    it('takes a plain Enter in a field of lines as a line, not a commit', () => {
        const probe = new TestPanel();
        const holder = drawn((probe as any).sourceField('a\nb', { className: 'param-map-input', onCommit: () => undefined }));
        const panel = typedInto(holder);
        const lines = holder.querySelector('textarea')!;
        enter(lines);
        lines.blur();
        clickOnNothing(panel, undefined, view('1200', node));
        expect(lines.isConnected).toBe(true);
    });

    it('holds nothing typed into a search field, which filters and commits nothing', () => {
        const search = document.createElement('input');
        search.type = 'search';
        const panel = typedInto(search);
        search.blur();
        clickOnNothing(panel, undefined, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('forgets what was typed once the panel is drawn anew, for a node or a surface\'s selection', () => {
        const { host, context } = surfaceHost();
        const panel = panelOn(host);
        (panel as any).initializeEditTracking();
        const root = view('1200', node);
        panel.modelRootChanged(root as never);
        const typeAndLeave = () => {
            const input = document.createElement('input');
            document.getElementById('property-content')!.appendChild(input);
            input.value = 'typed';
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        };

        // Typed into the node's panel, then the node selected again: its panel drawn anew.
        selectNode(panel, host, root);
        typeAndLeave();
        panel.selectionChanged(root, [], ['n1']);
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);
        selectNode(panel, host, root);
        clickOnNothing(panel, host, root);
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);

        // Typed into the view's panel, then a surface's selection drawn, then cleared by a click on nothing.
        typeAndLeave();
        context().setSelection(via);
        host.click(mouse(1));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('leaves the panel as it is while a field has the focus, and after: the next click on nothing shows them', async () => {
        const panel = new TestPanel();
        (panel as any).initializeEditTracking();
        panel.modelRootChanged(view('1200', node) as never);
        selectNode(panel, undefined, view('1200', node));
        const input = document.createElement('input');
        document.getElementById('property-content')!.appendChild(input);
        input.focus();

        clickOnNothing(panel, undefined, view('1200', node));
        expect(input.isConnected).toBe(true);
        input.blur();
        await tick();
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);

        clickOnNothing(panel, undefined, view('1200', node));
        expect(viewShown()).toEqual([['Name', 'top'], ['Nodes', '1200']]);
    });

    it('draws nothing again for a click on nothing while it shows them', () => {
        const panel = new TestPanel();
        panel.modelRootChanged(view('1200', node) as never);
        const drawn = section('View');
        clickOnNothing(panel, undefined, view('1200', node));
        expect(section('View')).toBe(drawn);
    });

    it('is as without it for a view with no facts: the hint at the open, the panel kept on a click on nothing', () => {
        const { host } = surfaceHost();
        const panel = panelOn(host);
        panel.modelRootChanged(view(null, node) as never);
        expect(hint()).toBe('Select an element to view properties');
        selectNode(panel, host, view(null, node));
        clickOnNothing(panel, host, view(null, node));
        expect(rows('Basic Info')[0]).toEqual(['Name', 'first']);
    });
});
