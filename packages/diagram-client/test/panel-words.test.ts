// @vitest-environment happy-dom
/**
 * The property panel names a node in its runtime's words: on a network
 * runtime an instance is an Actor (as its subnetwork is a Network), not a
 * Task.
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

    for (const [network, expected, not] of [[true, 'Actor', 'Task'], [false, 'Task', 'Actor']] as const) {
        it(`call an instance ${expected} on a ${network ? 'network' : 'workflow'} runtime`, () => {
            installPage({ networkPropertySections: network });
            const node: any = { id: 'n:add', type: T.NODE_ACTOR, args: { [M.ENTITY_NAME]: 'add', [M.ENTITY_TYPE]: 'Add' }, children: [] };
            const panel = new TestPanel();
            panel.show(node, { id: 'root', type: 'graph', args: {}, children: [node], index: { getById: () => node } });
            const text = document.getElementById('property-content')!.textContent ?? '';
            expect(text).toContain(expected);
            expect(text).not.toContain(not);
        });
    }
});
