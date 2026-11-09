// @vitest-environment happy-dom
/**
 * The annotation wizard's `@tool` and `@viewer` templates, as they write the
 * annotation today. Characterization before the move to wfpy-ide: see
 * `harness.ts`. The wizard is the Annotations section's "Wizard…" button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEditAnnotationsActionHandler } from '../../src/editing-action-handlers';
import { stockAnnotationTemplates } from '../../src/agent-ui';
import { ui, installPage, taskNode, BASH_TOOL } from './harness';
import { resetAgentUi, rootOf } from './panel';

vi.mock('../../src/vscode-ui', async () => (await import('./harness')).vscodeUiModule());

class TestWizard extends WorkflowEditAnnotationsActionHandler {
    readonly dispatched: any[] = [];
    constructor(node: any) {
        super();
        // What the stock feature module binds.
        (this as any).contributedTemplates = stockAnnotationTemplates();
        (this as any).editorContext = { modelRoot: rootOf(node) };
        (this as any).actionDispatcher = { dispatch: async (a: unknown) => { this.dispatched.push(a); } };
    }
    run(elementId: string): Promise<void> {
        return this.promptAndUpdate({ kind: 'dialogram.editAnnotations', elementId } as any);
    }
}

async function wizard(answers: unknown[], annotations: any[] = []): Promise<{ sent: any[]; asked: unknown[] }> {
    const node = taskNode('wizarded', annotations);
    const handler = new TestWizard(node);
    ui.picks.push(...answers);
    await handler.run(node.id);
    return {
        sent: handler.dispatched,
        asked: ui.calls.filter(c => c.method === 'quickPick' || c.method === 'inputBox').map(c => c.args[0])
    };
}

beforeEach(() => {
    resetAgentUi();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the annotation wizard', () => {
    it('offers the operations, then the templates', async () => {
        const { asked } = await wizard(['upsert']);
        await expect(JSON.stringify(asked, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/wizard-menus.json');
    });

    it('writes a @tool', async () => {
        const { sent, asked } = await wizard(['upsert', 'tool', 'make', '["-C", "build", "all"]', 'false']);
        expect(asked.length).toBe(5);
        expect(sent).toEqual([{
            kind: 'dialogram.updateDefinitionAnnotation', isOperation: true, elementId: 'node:scope:root:wizarded',
            action: 'upsert', annotationName: 'tool',
            annotationText: '@tool(\n    cmd="make",\n    args=["-C", "build", "all"],\n    inheritStdio=false\n)'
        }]);
    });

    it('writes a @viewer that opens the last token', async () => {
        const { sent } = await wizard(['upsert', 'viewer', 'open', '["report"]']);
        expect(sent[0].annotationName).toBe('viewer');
        expect(sent[0].annotationText).toBe('@viewer(\n    action="open",\n    inputs=["report"],\n    token="last"\n)');
    });

    it('writes a @viewer that diffs two last tokens, titled', async () => {
        const { sent } = await wizard(['upsert', 'viewer', 'diff', '["left", "right"]', 'Round diff']);
        expect(sent[0].annotationText).toBe(
            '@viewer(\n    action="diff",\n    inputs=["left", "right"],\n    token="last",\n    title="Round diff"\n)'
        );
    });

    it('writes a @viewer that opens with an editor from the settings', async () => {
        ui.answers.set('getViewerEditors', [{ viewType: 'hexEditor.hexedit', label: 'Hex Editor' }]);
        const { sent, asked } = await wizard(['upsert', 'viewer', 'openWith', '["dump"]', 'hexEditor.hexedit']);
        await expect(JSON.stringify(asked[4], null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/wizard-viewer-editors.json');
        expect(sent[0].annotationText).toBe(
            '@viewer(\n    action="openWith",\n    inputs=["dump"],\n    token="last",\n    viewType="hexEditor.hexedit"\n)'
        );
    });

    it('remembers a custom editor in the settings when asked', async () => {
        ui.answers.set('getViewerEditors', []);
        const { sent } = await wizard(['upsert', 'viewer', 'openWith', '["dump"]', '__custom__', 'my.viewer', 'yes', 'My viewer']);
        expect(ui.calls.filter(c => c.method === 'appendViewerEditor')).toEqual([
            { method: 'appendViewerEditor', args: [{ viewType: 'my.viewer', label: 'My viewer' }] }
        ]);
        expect(sent[0].annotationText).toContain('viewType="my.viewer"');
    });

    it('removes an annotation the definition has', async () => {
        const { sent } = await wizard(['remove', 'tool'], [BASH_TOOL]);
        expect(sent).toEqual([{
            kind: 'dialogram.updateDefinitionAnnotation', isOperation: true, elementId: 'node:scope:root:wizarded',
            action: 'remove', annotationName: 'tool'
        }]);
    });
});
