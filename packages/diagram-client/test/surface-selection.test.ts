// @vitest-environment happy-dom
/**
 * A diagram surface's selection reaches the property panel and the chat as a
 * node's does: the panel draws Basic Info and the surface's sections with
 * the panel's own section builder, its links go back to the surface, it
 * stays through the platform's own model updates, and it goes when cleared;
 * a double-click on the graph's whitespace is the surface's when it hears
 * clicks, so the root's properties do not replace what it selected; the chat
 * is told a capped summary on every change and with every message.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPage } from './panel-harness/harness';
import { TestPanel, resetPanel, rootOf, section } from './panel-harness/panel';
import { DiagramSurfaceHost } from '../src/diagram-surface-host';
import { ChatPanel } from '../src/chat-panel-integrated';
import { WhitespaceRootPropertiesMouseListener } from '../src/whitespace-root-properties-mouse-listener';
import { summarizeSurfaceSelection, type DiagramSurface, type DiagramSurfaceContext, type SurfaceSelection } from '../src/diagram-surface';

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

/** A host with a mounted surface whose context the test drives, and the links it was asked to follow. */
function surfaceHost(click?: DiagramSurface['click']): { host: DiagramSurfaceHost; context: () => DiagramSurfaceContext; followed: string[] } {
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
    host.decorate({}, root);
    host.postUpdate();
    return { host, context: () => context!, followed };
}

function panelOn(host: DiagramSurfaceHost): TestPanel {
    const panel = new TestPanel();
    (panel as any).surfaceHost = host;
    (panel as any).installNodeSections();
    return panel;
}

const rows = (title: string) => [...section(title)!.querySelectorAll('.pp-arow')]
    .map(row => [row.querySelector('.pp-akey')!.textContent!.trim(), row.querySelector('.pp-aval')!.textContent!.replace(/\s+/g, ' ').trim()]);

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
    const graph = { type: 'graph' } as never;
    const mouse = (detail: number) => ({ clientX: 40, clientY: 30, button: 0, detail, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });

    /** The two listeners in the order a browser runs them: the second mouseup, then dblclick. */
    function doubleClick(host: DiagramSurfaceHost | undefined, panel: TestPanel): void {
        host?.click(mouse(2));
        const listener = new WhitespaceRootPropertiesMouseListener();
        Object.assign(listener as any, { propertyPanel: panel, surfaceHost: host });
        expect(listener.doubleClick(graph, new MouseEvent('dblclick'))).toEqual([]);
    }

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
    function chatOn(host: DiagramSurfaceHost) {
        const sent: Array<{ method: string; env: any }> = [];
        const chat = new ChatPanel();
        (chat as any).channel = { sendToHost: (method: string, env: any) => sent.push({ method, env }) };
        (chat as any).surfaceHost = host;
        (chat as any).listenToSurface();
        (globalThis as any).diagramIdentifier = { uri: 'file:///w/shapes.txt' };
        return { chat, sent };
    }

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
