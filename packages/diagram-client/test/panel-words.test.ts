// @vitest-environment happy-dom
/**
 * The property panel names a node's kind in the product's words
 * (`clientBehavior.kindLabels`, from its create-node prompts): an Actor, a
 * Module. A product that gives none gets the platform's: a Task.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata as M, WorkflowDiagramTypes as T } from '@dialogram/shared';
import { installPage } from './panel-harness/harness';
import { TestPanel, resetPanel } from './panel-harness/panel';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the panel\'s words for a node', () => {
    beforeEach(() => resetPanel());

    for (const [behavior, expected, not] of [
        [{ networkPropertySections: true, kindLabels: { instance: 'Actor', network: 'Network' } }, 'Actor', 'Task'],
        [{ networkPropertySections: true, kindLabels: { instance: 'Module', network: 'Module' } }, 'Module', 'Actor'],
        [{ networkPropertySections: true }, 'Task', 'Actor']
    ] as const) {
        it(`call an instance ${expected} where the product says ${behavior.kindLabels?.instance ?? 'nothing'}`, () => {
            installPage(behavior as any);
            const node: any = { id: 'n:add', type: T.NODE_ACTOR, args: { [M.ENTITY_NAME]: 'add', [M.ENTITY_TYPE]: 'Add' }, children: [] };
            const panel = new TestPanel();
            panel.show(node, { id: 'root', type: 'graph', args: {}, children: [node], index: { getById: () => node } });
            const text = document.getElementById('property-content')!.textContent ?? '';
            expect(text).toContain(expected);
            expect(text).not.toContain(not);
        });
    }
});
