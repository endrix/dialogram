// @vitest-environment happy-dom
/**
 * The property panel's contribution point for annotation cards
 * (`annotation-editor.ts`): an editor a product binds draws its controls into
 * its annotation's card, owns the arguments it shows, and writes the
 * annotation on Save. Without editors the card is the plain one, a free row
 * per argument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { ChangeBoundsTool, TYPES } from '@eclipse-glsp/client';
import { AnnotationEditor, type AnnotationEditorContext } from '../src/annotation-editor';
import { PropertyPanel } from '../src/property-panel';
import { workflowFeaturesModule } from '../src/stock-features.module';
import { agentUiModule } from '../src/agent-ui';
import { installPage, taskNode } from './agent-ui/harness';
import { TestPanel, button, card, resetAgentUi, rootOf, section, tick } from './agent-ui/panel';

vi.mock('../src/vscode-ui', async () => (await import('./agent-ui/harness')).vscodeUiModule());
// The stock module starts loading the edge router's WASM; nothing here routes.
vi.mock('../src/libavoid-loader', async (original) => ({
    ...(await original<typeof import('../src/libavoid-loader')>()),
    preloadLibavoid: async () => undefined
}));

const UPDATE = 'dialogram.updateDefinitionAnnotation';

/** An editor for `@probe(level=..., ...)`: one input for `level`, and a GUI-only `expanded` it keeps in the map. */
function probeEditor(seen: AnnotationEditorContext[] = [], name = 'probe', label = `Add @${name}`): AnnotationEditor {
    return {
        annotationName: name,
        reservedArgs: ['level', 'expanded'],
        guiOnlyArgs: ['expanded'],
        mergeArgUpdates: true,
        quickAdd: { label, title: 'Add a probe', annotationText: '@probe(level=1)' },
        formatAnnotation: (_args, pairs) =>
            `@probe(${pairs.filter(([k]) => k !== 'expanded').map(([k, v]) => `${k}=${v}`).join(', ')})`,
        render(context) {
            seen.push(context);
            const input = document.createElement('input');
            input.className = 'probe-level';
            input.value = context.args.get('level') ?? '';
            input.addEventListener('input', () => context.args.set('level', input.value));
            context.body.appendChild(input);
            context.args.set('expanded', 'true');
        }
    };
}

const PROBE = { name: 'probe', arguments: [{ name: 'level', value: '1' }, { name: 'note', value: '"x"' }] };

function panelWith(editors: AnnotationEditor[] | undefined): TestPanel {
    const panel = new TestPanel();
    (panel as any).contributedAnnotationEditors = editors;
    return panel;
}

const freeRowKeys = (scope: Element) =>
    [...scope.querySelectorAll('.annotation-add-row .annotation-add-key')].map(input => (input as HTMLInputElement).value);

const headerButtons = () =>
    [...section('Annotations')!.querySelectorAll('.section-actions button')].map(b => b.textContent);

beforeEach(() => {
    resetAgentUi();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('a contributed annotation editor', () => {
    it('draws its controls in its annotation’s card, and the free rows skip the arguments it owns', () => {
        const seen: AnnotationEditorContext[] = [];
        const panel = panelWith([probeEditor(seen)]);
        const node = taskNode('probed', [PROBE]);
        const root = rootOf(node);
        panel.show(node, root);

        const probeCard = card('probe');
        expect((probeCard.querySelector('input.probe-level') as HTMLInputElement).value).toBe('1');
        expect(freeRowKeys(probeCard)).toEqual(['note']);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ elementId: 'node:scope:root:probed', requestDiscovery: true, root });
        expect(seen[0].body).toBe(probeCard.querySelector('.annotation-body'));
        expect(seen[0].dispatcher).toBe((panel as any).actionDispatcher);
    });

    it('saves the text it formats, and merges its arguments without the GUI-only ones', async () => {
        const panel = panelWith([probeEditor()]);
        panel.show(taskNode('probed', [PROBE]));
        const input = card('probe').querySelector('input.probe-level') as HTMLInputElement;
        input.value = '2';
        input.dispatchEvent(new Event('input'));
        button(card('probe'), 'Save').click();
        await tick();
        expect(panel.last(UPDATE)).toEqual({
            kind: UPDATE, isOperation: true, elementId: 'node:scope:root:probed', action: 'upsert',
            annotationName: 'probe', annotationText: '@probe(level=2, note="x")',
            argUpdates: { level: '2', note: '"x"' }
        });
    });

    it('clicks the card’s Save through its context', async () => {
        const seen: AnnotationEditorContext[] = [];
        const panel = panelWith([probeEditor(seen)]);
        panel.show(taskNode('probed', [PROBE]));
        seen[0].save();
        await tick();
        expect(panel.last(UPDATE)?.annotationText).toBe('@probe(level=1, note="x")');
    });

    it('adds its annotation from the header, before the wizard', async () => {
        const panel = panelWith([probeEditor()]);
        panel.show(taskNode('plain', []));
        expect(headerButtons()).toEqual(['Add @probe', 'Wizard…']);
        const add = button(section('Annotations')!, 'Add @probe');
        expect(add.title).toBe('Add a probe');
        add.click();
        await tick();
        expect(panel.last(UPDATE)).toEqual({
            kind: UPDATE, isOperation: true, elementId: 'node:scope:root:plain', action: 'upsert',
            annotationName: 'probe', annotationText: '@probe(level=1)'
        });
    });

    it('is replaced by a later editor of the same annotation, which keeps its place', () => {
        const first: AnnotationEditorContext[] = [];
        const second: AnnotationEditorContext[] = [];
        const panel = panelWith([probeEditor(first), probeEditor([], 'other'), probeEditor(second, 'probe', 'Add @probe again')]);
        panel.show(taskNode('probed', [PROBE]));
        expect([first.length, second.length]).toEqual([0, 1]);
        expect(card('probe').querySelectorAll('input.probe-level')).toHaveLength(1);
        expect(headerButtons()).toEqual(['Add @probe again', 'Add @other', 'Wizard…']);
    });

    it('leaves its GUI-only arguments out of the text and the updates, whether or not it merges', async () => {
        const plain = { ...probeEditor(), mergeArgUpdates: false, formatAnnotation: undefined };
        const panel = panelWith([plain]);
        panel.show(taskNode('probed', [PROBE]));
        button(card('probe'), 'Save').click();
        await tick();
        expect(panel.last(UPDATE)).toEqual({
            kind: UPDATE, isOperation: true, elementId: 'node:scope:root:probed', action: 'upsert',
            annotationName: 'probe', annotationText: '@probe(\n    level=1,\n    note="x"\n)'
        });
    });
});

describe('the panel without annotation editors', () => {
    it('draws every argument as a free row, and saves the plain text', async () => {
        const panel = panelWith(undefined);
        panel.show(taskNode('bare', [{
            name: 'agent',
            arguments: [{ name: 'prompt', value: '"hi"' }, { name: 'model', value: '"m"' }]
        }]));
        expect(headerButtons()).toEqual(['Wizard…']);
        expect(freeRowKeys(card('agent'))).toEqual(['prompt', 'model']);
        button(card('agent'), 'Save').click();
        await tick();
        expect(panel.last(UPDATE)).toEqual({
            kind: UPDATE, isOperation: true, elementId: 'node:scope:root:bare', action: 'upsert',
            annotationName: 'agent', annotationText: '@agent(\n    prompt="hi",\n    model="m"\n)'
        });
    });
});

describe('the editors the panel is given', () => {
    const dispatcher = { dispatch: async () => undefined, dispatchAll: async () => undefined };

    function stockContainer(...products: ContainerModule[]): Container {
        const container = new Container();
        // What the stock module rebinds, as GLSP's default modules bind it.
        container.bind(ChangeBoundsTool).toSelf().inSingletonScope();
        container.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        container.load(workflowFeaturesModule, ...products);
        return container;
    }

    const names = (panel: PropertyPanel) => (panel as any).annotationEditors().map((e: AnnotationEditor) => e.annotationName);

    it('are none in the stock diagram, and only a product’s when it binds one', () => {
        const product = new ContainerModule(bind => {
            bind(AnnotationEditor).toConstantValue(probeEditor());
        });
        expect(names(stockContainer().get(PropertyPanel))).toEqual([]);
        expect(names(stockContainer(product).get(PropertyPanel))).toEqual(['probe']);
    });

    it('are the agent UI’s @tool and @agent when a bundle loads it, then another module’s', () => {
        const product = new ContainerModule(bind => {
            bind(AnnotationEditor).toConstantValue(probeEditor());
        });
        expect(names(stockContainer(agentUiModule).get(PropertyPanel))).toEqual(['tool', 'agent']);
        expect(names(stockContainer(agentUiModule, product).get(PropertyPanel))).toEqual(['tool', 'agent', 'probe']);
    });

    it('take a later module’s editor in place of an earlier one’s for its annotation', () => {
        const mine = probeEditor([], 'agent');
        const product = new ContainerModule(bind => {
            bind(AnnotationEditor).toConstantValue(mine);
        });
        const editors = (stockContainer(agentUiModule, product).get(PropertyPanel) as any).annotationEditors();
        expect(editors.map((e: AnnotationEditor) => e.annotationName)).toEqual(['tool', 'agent']);
        expect(editors[1]).toBe(mine);
    });

    it('are none when nothing is bound', () => {
        const container = new Container();
        container.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        container.bind(PropertyPanel).toSelf();
        expect(names(container.get(PropertyPanel))).toEqual([]);
    });
});
