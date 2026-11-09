/**
 * The contribution point for what a double-click on a node opens
 * (`node-opener.ts`): an opener a product binds answers first, an opener that
 * leaves the node lets the platform open its definition, and the stock
 * module binds the `@viewer` opener until the product that has `@viewer`
 * binds it itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule } from 'inversify';
import { ChangeBoundsTool, EditorContextService, TYPES } from '@eclipse-glsp/client';
import { NavigateToExternalTargetAction } from '@eclipse-glsp/sprotty';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { NodeOpener } from '../src/node-opener';
import { ViewerMouseListener } from '../src/viewer-mouse-listener';
import { workflowFeaturesModule } from '../src/stock-features.module';

// The stock module starts loading the edge router's WASM; nothing here routes.
vi.mock('../src/libavoid-loader', async (original) => ({
    ...(await original<typeof import('../src/libavoid-loader')>()),
    preloadLibavoid: async () => undefined
}));

const SOURCE = 'file:///w/flows/main.py';

/** A task the platform would open the definition of. */
const task = (type = WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR): any => ({
    id: 'task',
    type,
    args: {
        [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR,
        [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/flows/tasks.py',
        [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: []
    },
    children: []
});

const opener = (id: string, answer: unknown[] | undefined, seen: unknown[] = []): NodeOpener => ({
    id,
    open: (node, context) => {
        seen.push([node.id, context.sourceUri]);
        return answer as never;
    }
});

function listenerWith(openers: NodeOpener[] | undefined): any {
    const listener: any = new ViewerMouseListener();
    listener.editorContext = { sourceUri: SOURCE };
    listener.contributedOpeners = openers;
    return listener;
}

const opens = (listener: any, node = task()) => listener.doubleClick(node, {} as MouseEvent);
const isDefinition = (actions: any[]) => actions.length === 1 && actions[0].uri === 'file:///w/flows/tasks.py';

describe('a node opener', () => {
    it('answers before the platform, with the node and the diagram’s source', () => {
        const seen: unknown[] = [];
        const mine = NavigateToExternalTargetAction.create({ uri: 'file:///w/out/report.html' });
        expect(opens(listenerWith([opener('mine', [mine], seen)]))).toEqual([mine]);
        expect(seen).toEqual([['task', SOURCE]]);
    });

    it('leaves the node to the platform, which opens its definition, when it answers nothing', () => {
        expect(isDefinition(opens(listenerWith([opener('mine', undefined)])))).toBe(true);
        expect(isDefinition(opens(listenerWith(undefined)))).toBe(true);
    });

    it('is asked for any node the listener answers for, and the first that answers wins', () => {
        const later: unknown[] = [];
        const first = NavigateToExternalTargetAction.create({ uri: 'file:///first' });
        const listener = listenerWith([opener('quiet', undefined), opener('first', [first]), opener('later', [], later)]);
        expect(opens(listener, task(WorkflowDiagramTypes.NODE_ACTOR))).toEqual([first]);
        expect(later).toEqual([]);
    });

    it('is replaced by a later opener of the same id, which keeps its place', () => {
        const replaced = NavigateToExternalTargetAction.create({ uri: 'file:///replaced' });
        const listener = listenerWith([opener('viewer', undefined), opener('other', undefined), opener('viewer', [replaced])]);
        expect(listener.nodeOpeners().map((o: NodeOpener) => o.id)).toEqual(['viewer', 'other']);
        expect(opens(listener)).toEqual([replaced]);
    });
});

describe('the openers the listener is given', () => {
    function container(...products: ContainerModule[]): Container {
        const c = new Container();
        // What the stock module rebinds and the listener injects, as GLSP binds them.
        c.bind(ChangeBoundsTool).toSelf().inSingletonScope();
        c.bind(TYPES.IActionDispatcher).toConstantValue({ dispatch: async () => undefined });
        c.bind(EditorContextService).toConstantValue({ sourceUri: SOURCE } as never);
        c.load(workflowFeaturesModule, ...products);
        return c;
    }
    // The stock module binds the listener as a mouse listener; resolve one the way the container builds it.
    const ids = (c: Container) => (c.resolve(ViewerMouseListener) as any).nodeOpeners().map((o: NodeOpener) => o.id);

    it('are the stock @viewer opener, then a product’s', () => {
        expect(ids(container())).toEqual(['viewer']);
        expect(ids(container(new ContainerModule(bind => { bind(NodeOpener).toConstantValue(opener('mine', undefined)); }))))
            .toEqual(['viewer', 'mine']);
    });

    it('take a product’s viewer opener in place of the stock one', () => {
        const mine = opener('viewer', undefined);
        const c = container(new ContainerModule(bind => { bind(NodeOpener).toConstantValue(mine); }));
        expect((c.resolve(ViewerMouseListener) as any).nodeOpeners()).toEqual([mine]);
    });

    it('are none when nothing is bound', () => {
        const c = new Container();
        c.bind(EditorContextService).toConstantValue({ sourceUri: SOURCE } as never);
        expect(ids(c)).toEqual([]);
    });
});
