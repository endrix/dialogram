/**
 * The chat's untangle where no port order goes into the source: no writer
 * bound (a read-only product), or a writer that says this diagram's source
 * takes none (a producer without the op).
 * The try is put to the person all the same; Apply saves its layout with the
 * port orders it draws, and no file changes.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { GGraph, GNode, GPort, type Action, type GModelElement } from '@eclipse-glsp/server';
import { WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { definitionKeyOf, drawInSourceOrder } from '../src/model/definition-port-order';
import { ReadOnlySourceModelStorage } from '../src/server/read-only-source-model-storage';
import { WorkflowCommandStack } from '../src/server/command-stack';
import type { DiagramChatCard, DiagramChatTarget } from '../src/server/diagram-chat-host';
import { layoutGeometryOf, type LayoutGeometry } from '../src/server/layout-snapshot';
import { ApplyPortOrdersOperationHandler, APPLY_PORT_ORDERS_OPERATION_KIND } from '../src/untangle/apply-port-orders-handler';
import type { SourcePortOrderWriter } from '../src/untangle/source-port-order-writer';
import {
    UntangleProposeMcpToolHandler,
    UntangleStartMcpToolHandler,
    UntangleTryMcpToolHandler
} from '../src/untangle/untangle-mcp-tools';
import { beginUntangle, untangleOf } from '../src/untangle/untangle-session';

const NET = '/work/net.py';

function el<T extends GModelElement>(cls: new () => T, props: Record<string, unknown>, children: GModelElement[] = []): T {
    const element = Object.assign(new cls(), props, { children });
    for (const child of children) {
        (child as { parent?: GModelElement }).parent = element;
    }
    return element;
}

/** An instance of `Stage` with the inputs A over B as declared, drawn B over A. */
function stage(name: string): GNode {
    const input = (port: string, y: number) => el(GPort, {
        id: `${name}.${port}`,
        type: WorkflowDiagramTypes.PORT_INPUT,
        position: { x: 0, y },
        size: { width: 10, height: 10 },
        args: { [WorkflowDiagramMetadata.PORT_NAME]: port, [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input' }
    });
    return el(GNode, {
        id: name,
        type: WorkflowDiagramTypes.NODE_ACTOR,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 60 },
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: name, [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Stage' }
    }, [input('A', 30), input('B', 10)]);
}

/** A diagram of two `Stage`s. */
function diagram() {
    const s1 = stage('s1');
    const root = el(GGraph, { id: 'g', type: 'graph' }, [s1, stage('s2')]);
    const elements = new Map<string, GModelElement>();
    const index = (element: GModelElement): void => {
        elements.set(element.id, element);
        element.children.forEach(index);
    };
    index(root);
    const modelState = {
        root,
        isReadonly: false,
        sourceUri: pathToFileURL(NET).href,
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: pathToFileURL(NET).href, workflowName: 'net' } : undefined)
    } as any;
    return { modelState, root, s1 };
}

/** A writer that would write every order, and records each it was asked for. */
function writer(canWrite: boolean, asked: string[]): SourcePortOrderWriter {
    return {
        canWrite: async () => canWrite,
        fileOf: () => pathToFileURL('/work/stages.py').href,
        write: async (_source, _file, write) => {
            asked.push(write.entity);
            return { ok: true };
        }
    };
}

/**
 * The tools on `modelState`, the person applying what is put to them; the card asked and the chat told.
 * A try `untangled` draws every port as its source declares it, as the layout does.
 */
function tools(modelState: any, bound?: SourcePortOrderWriter, storage?: unknown) {
    const cards: DiagramChatCard[] = [];
    const posted: string[] = [];
    const dispatched: Action[] = [];
    const targets: DiagramChatTarget[] = [];
    const chat = {
        canAsk: (diagram: DiagramChatTarget) => {
            targets.push(diagram);
            return true;
        },
        confirm: async (_diagram: DiagramChatTarget, card: DiagramChatCard) => {
            cards.push(card);
            return { choice: card.choices[0] };
        },
        post: async (_diagram: DiagramChatTarget, message: { text: string }) => {
            posted.push(message.text);
            return true;
        }
    };
    const preview = {
        geometry: () => layoutGeometryOf(modelState.root),
        run: async (layout: string) => {
            if (layout === 'untangled') {
                drawInSourceOrder(modelState.root);
            }
        },
        show: async (_geometry?: LayoutGeometry) => undefined
    };
    const [start, attempt, propose] = [new UntangleStartMcpToolHandler(), new UntangleTryMcpToolHandler(), new UntangleProposeMcpToolHandler()].map(tool => {
        const handler = tool as any;
        handler.modelState = modelState;
        handler.preview = preview;
        handler.writer = bound;
        handler.storage = storage;
        handler.chat = chat;
        handler.clientId = 'client-1';
        handler.logger = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined };
        handler.requestAction = async () => ({ encoding: 'base64', data: 'PIC' });
        handler.actionDispatcher = {
            dispatch: async (action: Action) => {
                dispatched.push(action);
                untangleOf(modelState)!.applied = { ok: true, files: [] };
            }
        };
        return tool;
    }) as [UntangleStartMcpToolHandler, UntangleTryMcpToolHandler, UntangleProposeMcpToolHandler];
    return { start, attempt, propose, cards, posted, dispatched, targets };
}

const KEPT_CARD = {
    title: 'Untangle: try 1',
    text: [
        '0 edge crossings, against 0 with Layout Diagram.',
        'Apply saves this layout and keeps with it the port order of 1 definition; no file changes:',
        '  Stage: left A, B → B, A',
        'Undo puts the layout back.'
    ].join('\n'),
    choices: ['Apply', 'Discard'],
    figures: [{ data: 'PIC', caption: 'Try 1: 0 crossings' }]
};

describe('an untangle whose port orders stay with the layout', () => {
    for (const [where, bound] of [
        ['no writer is bound', undefined],
        ['the writer says the source takes none', writer(false, [])]
    ] as const) {
        it(`is put to the person, its orders kept with the layout, when ${where}`, async () => {
            const { modelState } = diagram();
            const { start, attempt, propose, cards, posted, dispatched } = tools(modelState, bound);
            const begun = await start.handle({ sessionId: 's' } as any);
            expect(begun.isError).toBeFalsy();
            await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
            const put = await propose.handle({ sessionId: 's', try: 1 } as any);
            expect(put.isError).toBeFalsy();
            await vi.waitFor(() => expect(posted).toHaveLength(1));

            expect(cards).toEqual([KEPT_CARD]);
            expect(dispatched).toEqual([{ kind: APPLY_PORT_ORDERS_OPERATION_KIND, isOperation: true, writes: [] }]);
            expect(posted[0]).toBe(
                'Untangle applied: try 1, 0 edge crossings against 0 with Layout Diagram. The layout is saved, with the port order of 1 definition; no file changed.'
            );
        });
    }
});

describe('the chat an untangle is put to', () => {
    it('is named by the session\'s client, whose editor\'s chat it is, and the file it draws', async () => {
        const { modelState } = diagram();
        const { start, attempt, propose, targets } = tools(modelState);
        await start.handle({ sessionId: 's' } as any);
        await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        await propose.handle({ sessionId: 's', try: 1 } as any);
        expect(targets).toEqual([{ clientId: 'client-1', sourceUri: pathToFileURL(NET).href }]);
    });
});

describe('the card of an untangle', () => {
    it('promises no undo in a read-only diagram, whose host binds none', async () => {
        const { modelState } = diagram();
        const readOnly = Object.create(ReadOnlySourceModelStorage.prototype);
        const { start, attempt, propose, cards } = tools(modelState, undefined, readOnly);
        await start.handle({ sessionId: 's' } as any);
        await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        await propose.handle({ sessionId: 's', try: 1 } as any);
        await vi.waitFor(() => expect(cards).toHaveLength(1));
        expect(cards[0].text).toBe(KEPT_CARD.text.split('\n').slice(0, -1).join('\n'));
    });

    it('says which kept orders a try lets go, drawing them as declared again', async () => {
        // The diagram draws Stage B over A, as its layout keeps it; the try draws A over B.
        const { modelState } = diagram();
        const { start, attempt, propose, cards, posted } = tools(modelState);
        await start.handle({ sessionId: 's' } as any);
        await attempt.handle({ sessionId: 's', layout: 'untangled' } as any);
        await propose.handle({ sessionId: 's', try: 1 } as any);
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(cards[0].text).toBe([
            '0 edge crossings, against 0 with Layout Diagram.',
            'Apply saves this layout and draws Stage in the declared order again; no file changes.',
            'Undo puts the layout back.'
        ].join('\n'));
        expect(posted[0]).toBe(
            'Untangle applied: try 1, 0 edge crossings against 0 with Layout Diagram. The layout is saved, 1 definition drawn in the declared order again; no file changed.'
        );
    });
});

describe('applying an untangle with no writer', () => {
    it('saves the layout with the port orders it draws, writes no file, and undoes it', async () => {
        const { modelState, root, s1 } = diagram();
        const original = layoutGeometryOf(root);
        beginUntangle(modelState, { root, original, baseline: { crossings: 3, definitions: [] }, tries: [] });
        s1.position = { x: 200, y: 0 }; // the try, drawn
        const saved: Array<{ x: number; portOrders: unknown }> = [];
        const handler = new ApplyPortOrdersOperationHandler() as any;
        handler.modelState = modelState;
        handler.layoutPersistence = {
            saveLayoutImmediate: async (_file: string, _network: string, positions: Map<string, { x: number }>, _routes: unknown, portOrders: unknown) => {
                saved.push({ x: positions.get('s1')?.x ?? NaN, portOrders });
            }
        };
        const stack = new WorkflowCommandStack();
        (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
        // An order to write sent all the same is not written: there is no writer.
        await stack.execute(handler.createCommand({
            kind: APPLY_PORT_ORDERS_OPERATION_KIND, isOperation: true, writes: [{ entity: 'Stage', elementId: 's1', order: ['B', 'A'] }]
        }));
        const key = definitionKeyOf(s1)!;
        expect(saved).toEqual([{ x: 200, portOrders: { set: { [key]: { west: ['B', 'A'], east: [] } }, remove: [] } }]);
        expect(untangleOf(modelState)?.applied).toEqual({ ok: true, files: [] });
        expect(stack.canUndo()).toBe(true);

        await stack.undo();
        expect(saved.at(-1)).toEqual({ x: 0, portOrders: original.saved.portOrders });
        expect(s1.position).toEqual({ x: 0, y: 0 });
    });
});
