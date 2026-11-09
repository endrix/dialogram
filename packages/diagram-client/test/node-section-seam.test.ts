// @vitest-environment happy-dom
/**
 * The property panel's contribution point for a node's panel
 * (`node-section.ts`): Basic Info rows, a section after Annotations and one
 * last, a preparation before a selected node is drawn, the in-place update
 * while the model changes, and a one-time install with a redraw for answers
 * that arrive later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { ChangeBoundsTool, TYPES } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { NodeSectionContribution, type NodeSectionHost } from '../src/node-section';
import { createPropertySection } from '../src/property-section';
import { PropertyPanel } from '../src/property-panel';
import { workflowFeaturesModule } from '../src/stock-features.module';
import { installPage, taskNode, ANALYST_AGENT } from './agent-ui/harness';
import { TestPanel, resetAgentUi, rootOf, section } from './agent-ui/panel';

vi.mock('../src/vscode-ui', async () => (await import('./agent-ui/harness')).vscodeUiModule());
// The stock module starts loading the edge router's WASM; nothing here routes.
vi.mock('../src/libavoid-loader', async (original) => ({
    ...(await original<typeof import('../src/libavoid-loader')>()),
    preloadLibavoid: async () => undefined
}));

type Call = [hook: string, ...args: unknown[]];

/** A contribution that records each call and draws one row and two sections. */
function probe(calls: Call[] = [], tag = 'probe', id = tag): NodeSectionContribution & { host?: NodeSectionHost } {
    const contribution: NodeSectionContribution & { host?: NodeSectionHost } = {
        id,
        install(host) {
            calls.push(['install']);
            contribution.host = host;
        },
        prepare(node, root) {
            calls.push(['prepare', node.id, root]);
        },
        infoRows(node) {
            calls.push(['infoRows', node.id]);
            return [{ label: `${tag} row`, value: `for ${node.id}` }];
        },
        afterAnnotations(node, context) {
            calls.push(['afterAnnotations', node.id, context.entityName]);
            return createPropertySection(`${tag} after`);
        },
        last(node, context) {
            calls.push(['last', node.id, context.entityName]);
            return createPropertySection(`${tag} last`);
        },
        modelChanged(node, content) {
            calls.push(['modelChanged', node.id, content.id]);
        }
    };
    return contribution;
}

function panelWith(contributions: NodeSectionContribution[] | undefined): TestPanel {
    const panel = new TestPanel();
    (panel as any).contributedNodeSections = contributions;
    return panel;
}

const content = () => document.getElementById('property-content')!;
const sectionTitles = () =>
    [...content().children].map(s => s.querySelector('.section-title')?.textContent?.replace(/\s*\(\d+\)$/, '') ?? '');
const infoKeys = () => [...section('Basic Info')!.querySelectorAll('.pp-akey')].map(k => k.textContent!.trim());

beforeEach(() => {
    resetAgentUi();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('a node section contribution', () => {
    it('adds Basic Info rows after the type, a section after Annotations, and the last section', () => {
        const calls: Call[] = [];
        panelWith([probe(calls)]).show(taskNode('probed', []));
        expect(infoKeys()).toEqual(['Name', 'Type', 'probe row']);
        const titles = sectionTitles();
        expect(titles[titles.indexOf('Annotations') + 1]).toBe('probe after');
        expect(titles.at(-1)).toBe('probe last');
        expect(calls.map(c => c[0])).toEqual(['prepare', 'infoRows', 'afterAnnotations', 'last']);
        expect(calls[2]).toEqual(['afterAnnotations', 'node:scope:root:probed', 'probed']);
    });

    it('asks contributions in the order they were bound', () => {
        panelWith([probe([], 'first'), probe([], 'second')]).show(taskNode('two', []));
        expect(infoKeys().slice(2)).toEqual(['first row', 'second row']);
        const titles = sectionTitles();
        const after = titles.indexOf('Annotations') + 1;
        expect(titles.slice(after, after + 2)).toEqual(['first after', 'second after']);
        expect(titles.slice(-2)).toEqual(['first last', 'second last']);
    });

    it('is replaced by a later contribution of the same id, which keeps its place', () => {
        const first: Call[] = [];
        panelWith([probe(first, 'first', 'shared'), probe([], 'other'), probe([], 'second', 'shared')]).show(taskNode('swapped', []));
        expect(first).toEqual([]);
        expect(infoKeys().slice(2)).toEqual(['second row', 'other row']);
        expect(sectionTitles().slice(-2)).toEqual(['second last', 'other last']);
    });

    it('prepares a selected node with the root, but not the node of a selected port', () => {
        const calls: Call[] = [];
        const node = taskNode('ported', []);
        const port = { id: `${node.id}:in`, type: 'port', args: { [WorkflowDiagramMetadata.IS_INPUT_PORT]: true }, parent: node, children: [] };
        node.children = [port];
        const root = rootOf(node, port);
        const panel = panelWith([probe(calls)]);
        panel.show(node, root);
        expect(calls[0]).toEqual(['prepare', node.id, root]);
        calls.length = 0;
        (panel as any).updateContent(port);
        expect(calls.map(c => c[0])).toEqual(['infoRows', 'afterAnnotations', 'last']);
    });

    it('updates in place when the model changes for the node shown, and the panel does not redraw', () => {
        const calls: Call[] = [];
        const node = taskNode('streaming', []);
        const panel = panelWith([probe(calls)]);
        panel.show(node);
        const drawn = content().firstElementChild;
        calls.length = 0;
        panel.modelRootChanged(rootOf({ ...node, args: { ...node.args, extra: 1 } }) as any);
        expect(calls).toEqual([['modelChanged', node.id, 'property-content']]);
        expect(content().firstElementChild).toBe(drawn);
    });

    it('is not told of model changes while the panel is collapsed or shows no node', () => {
        const calls: Call[] = [];
        const node = taskNode('quiet', []);
        const panel = panelWith([probe(calls)]);
        panel.show(node);
        calls.length = 0;
        document.getElementById('property-panel')!.classList.add('collapsed');
        panel.modelRootChanged(rootOf(node) as any);
        document.getElementById('property-panel')!.classList.remove('collapsed');
        (panel as any).showNoSelection();
        panel.modelRootChanged(rootOf(node) as any);
        expect(calls.filter(c => c[0] === 'modelChanged')).toEqual([]);
    });

    it('redraws through its host only the node shown, and only while the panel is open', () => {
        const calls: Call[] = [];
        const contribution = probe(calls);
        const panel = panelWith([contribution]);
        (panel as any).installNodeSections();
        expect(calls).toEqual([['install']]);
        const node = taskNode('shown', []);
        panel.show(node);
        calls.length = 0;

        contribution.host!.redrawIfShowing('node:scope:root:other');
        expect(calls).toEqual([]);

        document.getElementById('property-panel')!.classList.add('collapsed');
        contribution.host!.redrawIfShowing(node.id);
        expect(calls).toEqual([]);

        document.getElementById('property-panel')!.classList.remove('collapsed');
        contribution.host!.redrawIfShowing(node.id);
        expect(calls.map(c => c[0])).toEqual(['prepare', 'infoRows', 'afterAnnotations', 'last']);
    });
});

describe('an agent node without the agent sections', () => {
    it('has no Skill row, no Agent Tools and no Agent Context', () => {
        const node = taskNode('bare', [ANALYST_AGENT], {
            'wf:agentSpec': { skill: 'turnus-reader' },
            [WorkflowDiagramMetadata.AGENT_CHAT_HISTORY]: JSON.stringify([{ role: 'user', content: 'hi' }])
        });
        panelWith(undefined).show(node);
        expect(infoKeys()).toEqual(['Name', 'Type']);
        expect(sectionTitles()).not.toContain('Agent Tools');
        expect(sectionTitles().some(t => t.startsWith('Agent Context'))).toBe(false);
    });
});

describe('the node sections the panel is given', () => {
    const dispatcher = { dispatch: async () => undefined, dispatchAll: async () => undefined };

    function stockContainer(...products: ContainerModule[]): Container {
        const container = new Container();
        // What the stock module rebinds, as GLSP's default modules bind it.
        container.bind(ChangeBoundsTool).toSelf().inSingletonScope();
        container.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        container.load(workflowFeaturesModule, ...products);
        return container;
    }

    const kinds = (panel: PropertyPanel) =>
        (panel as any).nodeSections().map((s: NodeSectionContribution) => s.constructor?.name === 'Object' ? 'product' : s.constructor?.name);

    it('are the stock agent sections, then a product’s, each installed once after injection', () => {
        const calls: Call[] = [];
        const product = new ContainerModule(bind => {
            bind(NodeSectionContribution).toConstantValue(probe(calls));
        });
        const panel = stockContainer(product).get(PropertyPanel);
        expect(kinds(panel)).toEqual(['AgentNodeSections', 'product']);
        expect(calls).toEqual([['install']]);
    });

    it('take a product’s agent sections in place of the stock ones', () => {
        const calls: Call[] = [];
        const mine = probe(calls, 'mine', 'agent');
        const product = new ContainerModule(bind => {
            bind(NodeSectionContribution).toConstantValue(mine);
        });
        const panel = stockContainer(product).get(PropertyPanel);
        expect((panel as any).nodeSections()).toEqual([mine]);
        expect(calls).toEqual([['install']]);
    });

    it('are none when nothing is bound', () => {
        const container = new Container();
        container.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        container.bind(PropertyPanel).toSelf();
        expect(kinds(container.get(PropertyPanel))).toEqual([]);
    });
});
