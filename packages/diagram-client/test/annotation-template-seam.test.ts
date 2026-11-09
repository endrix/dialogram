// @vitest-environment happy-dom
/**
 * The annotation wizard's contribution point (`annotation-template.ts`): the
 * templates a product binds are the wizard's menu, before its own "Custom
 * annotation…" entry, and the one picked composes the annotation's text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { ChangeBoundsTool, EditorContextService, TYPES } from '@eclipse-glsp/client';
import { AnnotationTemplate, type AnnotationTemplateContext } from '../src/annotation-template';
import { WorkflowEditAnnotationsActionHandler } from '../src/editing-action-handlers';
import { workflowFeaturesModule } from '../src/stock-features.module';
import { ui, installPage, taskNode } from './panel-harness/harness';
import { resetPanel, rootOf } from './panel-harness/panel';

vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule());
// The stock module starts loading the edge router's WASM; nothing here routes.
vi.mock('../src/libavoid-loader', async (original) => ({
    ...(await original<typeof import('../src/libavoid-loader')>()),
    preloadLibavoid: async () => undefined
}));

const UPDATE = 'dialogram.updateDefinitionAnnotation';

function probe(name: string, text: string | undefined, seen: AnnotationTemplateContext[] = [], label = `@${name} (probe)`): AnnotationTemplate {
    return {
        annotationName: name,
        label,
        compose: async (context) => {
            seen.push(context);
            return text;
        }
    };
}

class TestWizard extends WorkflowEditAnnotationsActionHandler {
    readonly dispatched: any[] = [];
    constructor(node: any, templates: AnnotationTemplate[] | undefined) {
        super();
        (this as any).contributedTemplates = templates;
        (this as any).editorContext = { modelRoot: rootOf(node) };
        (this as any).actionDispatcher = { dispatch: async (a: unknown) => { this.dispatched.push(a); } };
    }
    run(elementId: string): Promise<void> {
        return this.promptAndUpdate({ kind: 'dialogram.editAnnotations', elementId } as any);
    }
}

async function wizard(templates: AnnotationTemplate[] | undefined, answers: unknown[], annotations: any[] = []) {
    const node = taskNode('wizarded', annotations);
    const handler = new TestWizard(node, templates);
    ui.picks.push(...answers);
    await handler.run(node.id);
    const menus = ui.calls.filter(c => c.method === 'quickPick').map(c => (c.args[0] as any).items.map((i: any) => i.id));
    return { sent: handler.dispatched, menu: menus[1] as string[] | undefined, node };
}

beforeEach(() => {
    resetPanel();
    installPage();
});

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('an annotation template', () => {
    it('is a menu entry before the wizard’s own, and writes what it composes', async () => {
        const seen: AnnotationTemplateContext[] = [];
        const existing = { name: 'retry', arguments: [{ name: 'times', value: '2' }] };
        const { sent, menu, node } = await wizard([probe('retry', '@retry(times=3)', seen)], ['upsert', 'retry'], [existing]);
        expect(menu).toEqual(['retry', 'custom']);
        expect(seen).toEqual([{ elementId: node.id, existing }]);
        expect(sent).toEqual([{
            kind: UPDATE, isOperation: true, elementId: node.id, action: 'upsert',
            annotationName: 'retry', annotationText: '@retry(times=3)'
        }]);
    });

    it('sends nothing when the person cancels it, or it composes nothing', async () => {
        expect((await wizard([probe('retry', undefined)], ['upsert', 'retry'])).sent).toEqual([]);
        resetPanel();
        expect((await wizard([probe('retry', '  ')], ['upsert', 'retry'])).sent).toEqual([]);
    });

    it('is not offered without a name', async () => {
        const { menu } = await wizard([probe('', '@'), probe(' ', '@')], ['upsert', 'custom', 'x', '']);
        expect(menu).toEqual(['custom']);
    });

    it('is replaced by a later template of the same annotation, which keeps its place', async () => {
        const first: AnnotationTemplateContext[] = [];
        const second: AnnotationTemplateContext[] = [];
        const templates = [probe('retry', '@retry(times=1)', first), probe('other', '@other'), probe('retry', '@retry(times=9)', second, 'again')];
        const { sent, menu } = await wizard(templates, ['upsert', 'retry']);
        expect(menu).toEqual(['retry', 'other', 'custom']);
        expect([first.length, second.length]).toEqual([0, 1]);
        expect(sent[0].annotationText).toBe('@retry(times=9)');
    });

    it('cannot take the place of the wizard’s own entry', async () => {
        const { menu, sent } = await wizard([probe('custom', '@custom')], ['upsert', 'custom', 'mine', 'x=1']);
        expect(menu).toEqual(['custom']);
        expect(sent[0]).toMatchObject({ annotationName: 'mine', annotationText: '@mine(x=1)' });
    });
});

describe('the wizard without templates', () => {
    it('offers only its own entry', async () => {
        const { menu, sent } = await wizard(undefined, ['upsert', 'custom', 'note', '']);
        expect(menu).toEqual(['custom']);
        expect(sent[0]).toMatchObject({ annotationName: 'note', annotationText: '@note' });
    });
});

describe('the templates the wizard is given', () => {
    const dispatcher = { dispatch: async () => undefined, dispatchAll: async () => undefined };

    function container(...products: ContainerModule[]): Container {
        const c = new Container();
        // What the stock module rebinds and the handler injects, as GLSP binds them.
        c.bind(ChangeBoundsTool).toSelf().inSingletonScope();
        c.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        c.bind(EditorContextService).toConstantValue({} as EditorContextService);
        c.load(workflowFeaturesModule, ...products);
        return c;
    }

    const names = (h: any) => h.annotationTemplates().map((t: AnnotationTemplate) => t.annotationName);

    it('are none in the stock diagram, and only a product’s when it binds one', () => {
        const product = new ContainerModule(bind => {
            bind(AnnotationTemplate).toConstantValue(probe('retry', '@retry'));
        });
        expect(names(container().resolve(WorkflowEditAnnotationsActionHandler))).toEqual([]);
        expect(names(container(product).resolve(WorkflowEditAnnotationsActionHandler))).toEqual(['retry']);
    });

    it('are those every module binds, in the order they were bound', () => {
        const first = new ContainerModule(bind => {
            bind(AnnotationTemplate).toConstantValue(probe('tool', '@tool'));
            bind(AnnotationTemplate).toConstantValue(probe('viewer', '@viewer'));
        });
        const second = new ContainerModule(bind => {
            bind(AnnotationTemplate).toConstantValue(probe('retry', '@retry'));
        });
        expect(names(container(first, second).resolve(WorkflowEditAnnotationsActionHandler))).toEqual(['tool', 'viewer', 'retry']);
    });

    it('are none when nothing is bound', () => {
        const c = new Container();
        c.bind(TYPES.IActionDispatcher).toConstantValue(dispatcher);
        c.bind(EditorContextService).toConstantValue({} as EditorContextService);
        expect(names(c.resolve(WorkflowEditAnnotationsActionHandler))).toEqual([]);
    });
});
