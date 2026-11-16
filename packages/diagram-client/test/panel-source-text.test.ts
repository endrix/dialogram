// @vitest-environment happy-dom
/**
 * The panel shows what the source writes, and offers to write back only what
 * the source holds:
 *
 *   - an argument the producer gives the source text of (`expression`) is
 *     shown as that text (`FRONT_OPTIONS`), not the value it evaluated to;
 *   - an annotation the class does not write (`derived`: the viewer worked
 *     out for a source) is shown with no Save or Remove;
 *   - an argument the decorator does not write (`derived`: the port of a
 *     `@source`) is shown, and not saved with the annotation;
 *   - a factory's default is its `defaultValue`; one `required` has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { installPage, taskNode } from './panel-harness/harness';
import { TestPanel, button, card, resetPanel, section, tick } from './panel-harness/panel';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());
vi.mock('../src/libavoid-loader', async (original) => ({
    ...(await original<typeof import('../src/libavoid-loader')>()),
    preloadLibavoid: async () => undefined
}));

const UPDATE = 'dialogram.updateDefinitionAnnotation';

beforeEach(() => {
    resetPanel();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

const buttons = (scope: Element) => [...scope.querySelectorAll('button')].map(b => (b.textContent ?? '').trim());

describe('an argument', () => {
    it('is shown as the source writes it, not as what it evaluated to', () => {
        const panel = new TestPanel();
        panel.show(taskNode('front_options', [], {
            [WorkflowDiagramMetadata.ENTITY_PARAMETERS]: [
                { name: 'text', kind: 'value', type: 'str', value: "'ftd=off'", expression: 'FRONT_OPTIONS' },
                { name: 'path', kind: 'value', type: 'File', value: "File(path='/abs/tb.cpp', ext='')", expression: 'File(path=TESTBENCH)' }
            ],
            [WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS]: [{ name: 'text', type: 'str' }, { name: 'path', type: 'File' }]
        }));
        const inputs = [...section('Instance Parameters')!.querySelectorAll('input.pp-input')]
            .map(input => (input as HTMLInputElement).value).filter(value => value !== '');
        expect(inputs).toEqual(['FRONT_OPTIONS', 'File(path=TESTBENCH)']);
    });
});

describe('an annotation the producer works out', () => {
    const VIEWER = { name: 'viewer', derived: true, arguments: [{ name: 'action', value: '"open"' }, { name: 'path', value: '"/abs/tb.cpp"' }] };
    const SOURCE = { name: 'source', arguments: [{ name: 'port', value: '"Out"', derived: true }] };
    const STREAMBLOCKS = {
        name: 'streamblocks',
        arguments: [{ name: 'facade', value: '"instance"' }, { name: 'run', value: 'False' }, { name: 'network', value: '"top"', derived: true }]
    };

    it('is shown, with nothing to save or remove', () => {
        new TestPanel().show(taskNode('tb', [VIEWER as any, SOURCE]));
        const viewer = card('viewer');
        expect(buttons(viewer)).toEqual([]);
        expect([...viewer.querySelectorAll('.annotation-derived-arg')].map(row => row.textContent)).toEqual(['action = "open"', 'path = "/abs/tb.cpp"']);
        expect(viewer.querySelector('.annotation-derived-note')?.textContent).toContain('Nothing here to save or remove');
    });

    it('in an argument, is shown and not saved with the annotation the class writes', async () => {
        const panel = new TestPanel();
        panel.show(taskNode('model', [STREAMBLOCKS as any]));
        const streamblocks = card('streamblocks');
        expect([...streamblocks.querySelectorAll('.annotation-add-row .annotation-add-key')].map(input => (input as HTMLInputElement).value))
            .toEqual(['facade', 'run']);
        expect([...streamblocks.querySelectorAll('.annotation-derived-arg')].map(row => row.textContent)).toEqual(['network = "top"']);
        button(streamblocks, 'Save').click();
        await tick();
        expect(panel.last(UPDATE)?.annotationText).toBe('@streamblocks(\n    facade="instance",\n    run=False\n)');
    });
});

describe('a factory-made workflow shown in place', () => {
    it('takes its defaults from its signature: what the instance was given is not one', () => {
        const panel = new TestPanel();
        const node = taskNode('flow', []);
        const root = {
            id: 'root', type: 'graph', children: [node], index: { getById: () => node },
            args: {
                [WorkflowDiagramMetadata.NETWORK_FACTORY_NAME]: 'gemmini',
                [WorkflowDiagramMetadata.NETWORK_PARAMETERS]: [
                    { name: 'commands', value: 12, type: 'int', required: true },
                    { name: 'core', value: 'Gemmini', type: 'str', defaultValue: '"Gemmini"' },
                    { name: 'depth', value: 3, type: 'int' }
                ]
            }
        };
        (panel as any).lastRoot = root;
        const built = (panel as any).buildWorkflowParametersSection('root', root.args) as HTMLElement;
        document.body.appendChild(built);
        const defaults = [...built.querySelectorAll('input')].map(input => (input as HTMLInputElement).value).slice(0, 9);
        // name, type, default per row; a producer that names no defaults (depth) keeps the value given.
        expect(defaults).toEqual(['commands', 'int', '', 'core', 'str', '"Gemmini"', 'depth', 'int', '3']);
    });
});
