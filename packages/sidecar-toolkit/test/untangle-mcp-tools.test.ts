/**
 * The untangle tools the chat's `/untangle` hands the agent: at most ten
 * tries, an order the diagram has no place for refused without using one, and
 * the try put to the person carried out by the platform, as the person
 * answers: applied, its port orders written and the two drawings shown in the
 * chat; discarded, the diagram drawn as it was and nothing written.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { GGraph, GNode, GPort, type Action, type GModelElement } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { DECLARED_ROW_ARG } from '@dialogram/diagram-server/model/definition-port-order';
import { layoutGeometryOf, type LayoutGeometry } from '@dialogram/diagram-server/server/layout-snapshot';
import type { DiagramChatCard } from '@dialogram/diagram-server/server/diagram-chat-host';
import { APPLY_PORT_ORDERS_OPERATION_KIND } from '../src/server/untangle/apply-port-orders-handler';
import { MAX_TRIES, untangleOf } from '../src/server/untangle/untangle-session';
import {
    UntangleProposeMcpToolHandler,
    UntangleStartMcpToolHandler,
    UntangleTryMcpToolHandler
} from '../src/server/untangle/untangle-mcp-tools';

const STAGES = '/work/stages.py';

function el<T extends GModelElement>(cls: new () => T, props: Record<string, unknown>, children: GModelElement[] = []): T {
    const element = Object.assign(new cls(), props, { children });
    for (const child of children) {
        (child as { parent?: GModelElement }).parent = element;
    }
    return element;
}

/** An instance of `Stage` (stages.py) with the inputs A over B as declared, drawn B over A. */
function stage(name: string): GNode {
    const input = (port: string, y: number, declared: number) => el(GPort, {
        id: `${name}.${port}`,
        type: WorkflowDiagramTypes.PORT_INPUT,
        position: { x: 0, y },
        size: { width: 10, height: 10 },
        args: { [WorkflowDiagramMetadata.PORT_NAME]: port, [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input', [DECLARED_ROW_ARG]: declared }
    });
    return el(GNode, {
        id: name,
        type: WorkflowDiagramTypes.NODE_ACTOR,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 60 },
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: name,
            [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Stage',
            [WorkflowDiagramMetadata.REFERENCED_URI]: pathToFileURL(STAGES).href,
            [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true
        }
    }, [input('A', 30, 10), input('B', 10, 30)]);
}

type Chat = {
    canAsk: (uri: string) => boolean;
    confirm: (uri: string, card: DiagramChatCard) => Promise<{ choice?: string } | undefined>;
    post: (uri: string, message: { text: string; figures?: Array<{ data: string; caption?: string }> }) => Promise<boolean>;
};

/** The three tools on one diagram (net.py: s1 and s2, both `Stage`), their preview and picture stubbed. */
function diagram(chat?: Chat) {
    const root = el(GGraph, { id: 'g', type: 'graph' }, [stage('s1'), stage('s2')]);
    const elements = new Map<string, GModelElement>();
    const index = (element: GModelElement): void => {
        elements.set(element.id, element);
        element.children.forEach(index);
    };
    index(root);
    const modelState = {
        root,
        isReadonly: false,
        sourceUri: pathToFileURL('/work/net.py').href,
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) }
    } as any;
    const runs: Array<{ layout: string; orders?: unknown }> = [];
    const shown: Array<LayoutGeometry | undefined> = [];
    const preview = {
        geometry: () => layoutGeometryOf(root),
        run: async (layout: string, orders?: unknown) => {
            runs.push({ layout, ...(orders && Object.keys(orders).length > 0 ? { orders } : {}) });
        },
        show: async (geometry?: LayoutGeometry) => {
            shown.push(geometry);
        }
    };
    const dispatched: Action[] = [];
    const tools = [new UntangleStartMcpToolHandler(), new UntangleTryMcpToolHandler(), new UntangleProposeMcpToolHandler()].map(tool => {
        const handler = tool as any;
        handler.modelState = modelState;
        handler.preview = preview;
        handler.sidecar = { supportsOp: async () => true, hasFeature: async () => false };
        handler.chat = chat;
        handler.logger = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined };
        handler.requestAction = async () => ({ encoding: 'base64', data: 'PIC' });
        handler.actionDispatcher = {
            dispatch: async (action: Action) => {
                dispatched.push(action);
                const state = untangleOf(modelState);
                if (state) {
                    state.applied = { ok: true, files: [STAGES] };
                }
            }
        };
        return tool;
    });
    const [start, attempt, propose] = tools as [UntangleStartMcpToolHandler, UntangleTryMcpToolHandler, UntangleProposeMcpToolHandler];
    return { modelState, runs, shown, dispatched, start, attempt, propose };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(each => each.text ?? `[${each.type}]`).join('\n');

describe('the untangle tools', () => {
    it(`make at most ${MAX_TRIES} tries, refusing an order the diagram has no place for without using one`, async () => {
        const { modelState, runs, start, attempt } = diagram();
        const begun = await start.handle({ sessionId: 's' } as any);
        expect(begun.isError).toBeFalsy();
        expect(text(begun)).toContain('Layout Diagram: 0 edge crossings');
        expect(text(begun)).toContain('- Stage (s1, s2): left B, A (declared: left A, B)');
        expect(begun.content.at(-1)).toEqual({ type: 'image', data: 'PIC', mimeType: 'image/png' });

        const refused = [
            await attempt.handle({ sessionId: 's', layout: 'free-ports', orders: { Merge: { left: ['A', 'B'] } } } as any),
            await attempt.handle({ sessionId: 's', layout: 'free-ports', orders: { Stage: { left: ['A'] } } } as any),
            await attempt.handle({ sessionId: 's', layout: 'untangled', orders: { Stage: { left: ['A', 'B'] } } } as any)
        ];
        expect(refused.map(each => each.isError)).toEqual([true, true, true]);
        expect(text(refused[1])).toContain("The left side of 'Stage' has the ports A, B: name each of them once.");
        expect(untangleOf(modelState)?.tries).toHaveLength(0);

        const first = await attempt.handle({ sessionId: 's', layout: 'free-ports', orders: { Stage: { left: ['B', 'A'] } } } as any);
        expect(text(first)).toContain(`Try 1 of ${MAX_TRIES} (free-ports, your orders for Stage): 0 edge crossings`);
        for (let n = 2; n <= MAX_TRIES; n++) {
            const made = await attempt.handle({ sessionId: 's', layout: n === 2 ? 'untangled' : 'free-ports' } as any);
            expect(made.isError, `try ${n}`).toBeFalsy();
        }
        const over = await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        expect(over.isError).toBe(true);
        expect(text(over)).toContain(`All ${MAX_TRIES} tries are used`);
        expect(runs.slice(0, 3)).toEqual([
            { layout: 'default' },
            { layout: 'free-ports', orders: { Stage: { west: ['B', 'A'] } } },
            { layout: 'untangled' }
        ]);
        expect(runs).toHaveLength(1 + MAX_TRIES);
    });

    it('put a try to the person and, applied, write its orders and show the chat both drawings', async () => {
        const cards: DiagramChatCard[] = [];
        const posted: Array<{ text: string; figures?: Array<{ data: string; caption?: string }> }> = [];
        const chat: Chat = {
            canAsk: () => true,
            confirm: async (_uri, card) => {
                cards.push(card);
                return { choice: card.choices[0] };
            },
            post: async (_uri, message) => {
                posted.push(message);
                return true;
            }
        };
        const { modelState, dispatched, start, attempt, propose } = diagram(chat);
        await start.handle({ sessionId: 's' } as any);
        await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        const put = await propose.handle({ sessionId: 's', try: 1 } as any);
        expect(put.isError).toBeFalsy();
        expect(text(put)).toContain('and stop');
        await vi.waitFor(() => expect(posted).toHaveLength(1));

        expect(cards).toEqual([{
            title: 'Untangle: try 1',
            text: [
                '0 edge crossings, against 0 with Layout Diagram.',
                'Apply saves this layout and writes the port order of 1 definition in 1 file:',
                'stages.py',
                '  Stage: left A, B → B, A',
                'Undo puts the files and the layout back.'
            ].join('\n'),
            choices: ['Apply to 1 file', 'Discard'],
            figures: [{ data: 'PIC', caption: 'Try 1: 0 crossings' }]
        }]);
        expect(dispatched).toEqual([{
            kind: APPLY_PORT_ORDERS_OPERATION_KIND,
            isOperation: true,
            writes: [{ entity: 'Stage', elementId: 's1', order: ['B', 'A'] }]
        }]);
        expect(posted[0].text).toBe('Untangle applied: try 1, 0 edge crossings against 0 with Layout Diagram. Port orders written in stages.py; the layout is saved.');
        expect(posted[0].figures).toEqual([
            { data: 'PIC', caption: 'Layout Diagram: 0 crossings' },
            { data: 'PIC', caption: 'Untangled (try 1): 0 crossings' }
        ]);
        expect(untangleOf(modelState)).toBeUndefined();
        expect((await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any)).isError).toBe(true);
    });

    it('discarded, draw the diagram as it was and write nothing', async () => {
        const posted: string[] = [];
        const chat: Chat = {
            canAsk: () => true,
            confirm: async () => ({ choice: 'Discard' }),
            post: async (_uri, message) => {
                posted.push(message.text);
                return true;
            }
        };
        const { modelState, dispatched, shown, start, attempt, propose } = diagram(chat);
        await start.handle({ sessionId: 's' } as any);
        const original = untangleOf(modelState)!.original;
        await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        await propose.handle({ sessionId: 's', try: 1 } as any);
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toBe('Untangle discarded: the diagram is drawn as it was, and nothing was written.');
        expect(dispatched).toEqual([]);
        expect(shown.at(-1)).toBe(original);
        expect(untangleOf(modelState)).toBeUndefined();
    });

    it('refuse to put a try with no chat open on the diagram, the untangle going on', async () => {
        const { modelState, start, attempt, propose } = diagram({ canAsk: () => false, confirm: async () => undefined, post: async () => false });
        await start.handle({ sessionId: 's' } as any);
        await attempt.handle({ sessionId: 's', layout: 'free-ports' } as any);
        const put = await propose.handle({ sessionId: 's', try: 1 } as any);
        expect(put.isError).toBe(true);
        expect(untangleOf(modelState)?.proposed).toBeUndefined();
        expect((await propose.handle({ sessionId: 's', try: 2 } as any)).isError).toBe(true);
    });
});
