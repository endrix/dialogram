/**
 * The chat's untangle, below its tools: what a try says of each definition
 * (its order as drawn and as declared, each instance's own after Free Ports),
 * the full order written for a definition (inputs and outputs keeping their
 * places among each other), and Apply: the layout saved and every order
 * written as one undo, nothing left half done when a write is refused.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GGraph, GNode, GPort, type GModelElement } from '@eclipse-glsp/server';
import { WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { DECLARED_ROW_ARG, recordProbe } from '@dialogram/diagram-server/model/definition-port-order';
import { layoutGeometryOf } from '@dialogram/diagram-server/server/layout-snapshot';
import { ApplyPortOrdersOperationHandler, APPLY_PORT_ORDERS_OPERATION_KIND } from '../src/server/untangle/apply-port-orders-handler.js';
import { beginUntangle, drawnDefinitions, orderToWrite, untangleOf } from '../src/server/untangle/untangle-session.js';
import { commandStack, onDiskEveryFile as onDisk, saying } from './edits-on-disk';

function el<T extends GModelElement>(cls: new () => T, props: Record<string, unknown>, children: GModelElement[] = []): T {
    const element = Object.assign(new cls(), props, { children });
    for (const child of children) {
        (child as { parent?: GModelElement }).parent = element;
    }
    return element;
}

/** A port named `name`, an input or an output, at row `y`; declared at `declared` when Free Ports moved it. */
function port(node: string, name: string, direction: 'input' | 'output', y: number, declared?: number): GPort {
    return el(GPort, {
        id: `${node}.${direction}.${name}`,
        type: direction === 'input' ? WorkflowDiagramTypes.PORT_INPUT : WorkflowDiagramTypes.PORT_OUTPUT,
        position: { x: direction === 'input' ? 0 : 90, y },
        size: { width: 10, height: 10 },
        args: {
            [WorkflowDiagramMetadata.PORT_NAME]: name,
            [WorkflowDiagramMetadata.PORT_DIRECTION]: direction,
            ...(declared !== undefined ? { [DECLARED_ROW_ARG]: declared } : {})
        }
    });
}

/** An instance `name` of `type`, its ports as given (in the order the source declares them). */
function instance(name: string, type: string, ports: GPort[], file?: string): GNode {
    return el(GNode, {
        id: name,
        type: WorkflowDiagramTypes.NODE_ACTOR,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: name,
            [WorkflowDiagramMetadata.ENTITY_TYPE]: type,
            ...(file ? { [WorkflowDiagramMetadata.REFERENCED_URI]: pathToFileURL(file).href, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true } : {})
        }
    }, ports);
}

describe('the order written for a definition', () => {
    it('puts each side in its new order where that side\'s ports were declared', () => {
        // Declared: A (in), X (out), B (in), Y (out).
        const node = instance('t', 'T', [port('t', 'A', 'input', 10), port('t', 'X', 'output', 10), port('t', 'B', 'input', 30), port('t', 'Y', 'output', 30)]);
        expect(orderToWrite(node, { west: ['B', 'A'], east: ['Y', 'X'] })).toEqual(['B', 'Y', 'A', 'X']);
    });

    it('tells an input from an output of one name by its side', () => {
        const node = instance('t', 'T', [port('t', 'Main', 'input', 10), port('t', 'Start', 'input', 30), port('t', 'Main', 'output', 10)]);
        expect(orderToWrite(node, { west: ['Start', 'Main'], east: ['Main'] })).toEqual(['Start', 'Main', 'Main']);
    });
});

describe('what a try says of each definition', () => {
    it('gives its order as drawn and as declared, and each instance\'s own after Free Ports', () => {
        // Free Ports drew both instances B over A; they were declared A over B.
        const s1 = instance('s1', 'Stage', [port('s1', 'A', 'input', 30, 10), port('s1', 'B', 'input', 10, 30), port('s1', 'Out', 'output', 10)]);
        const s2 = instance('s2', 'Stage', [port('s2', 'A', 'input', 30, 10), port('s2', 'B', 'input', 10, 30), port('s2', 'Out', 'output', 10)]);
        const lone = instance('m', 'Merge', [port('m', 'P', 'input', 10), port('m', 'Q', 'input', 30), port('m', 'Out', 'output', 10)]);
        const root = el(GGraph, { id: 'g' }, [s1, s2, lone]);
        recordProbe(root, [
            { node: s1, order: [s1.children[1].id, s1.children[0].id, s1.children[2].id], edges: 3 },
            { node: s2, order: [s2.children[0].id, s2.children[1].id, s2.children[2].id], edges: 3 },
            { node: lone, order: lone.children.map(child => child.id), edges: 3 }
        ]);
        const [stage, merge] = drawnDefinitions(root);
        expect(stage).toMatchObject({
            name: 'Stage',
            instances: ['s1', 's2'],
            drawn: { west: ['B', 'A'], east: ['Out'] },
            declared: { west: ['A', 'B'], east: ['Out'] },
            alone: { s1: { west: ['B', 'A'], east: ['Out'] }, s2: { west: ['A', 'B'], east: ['Out'] } }
        });
        expect(stage.disagree).toBeUndefined();
        expect(merge).toMatchObject({ name: 'Merge', instances: ['m'], drawn: { west: ['P', 'Q'] }, declared: { west: ['P', 'Q'] } });
        expect(merge.alone).toBeUndefined();
    });
});

/** A diagram `net` with two instances of `Stage` (stages.py) and one of `Merge` (merges.py), as a try drew them. */
function design() {
    const dir = mkdtempSync(path.join(tmpdir(), 'untangle-'));
    const files = { net: path.join(dir, 'net.py'), stages: path.join(dir, 'stages.py'), merges: path.join(dir, 'merges.py') };
    for (const file of Object.values(files)) {
        writeFileSync(file, `# ${path.basename(file)}\n`);
    }
    const s1 = instance('s1', 'Stage', [port('s1', 'A', 'input', 30, 10), port('s1', 'B', 'input', 10, 30)], files.stages);
    const m = instance('m', 'Merge', [port('m', 'P', 'input', 30, 10), port('m', 'Q', 'input', 10, 30)], files.merges);
    const root = el(GGraph, { id: 'g', type: 'graph' }, [s1, m]);
    const elements = new Map<string, GModelElement>();
    const index = (element: GModelElement): void => {
        elements.set(element.id, element);
        element.children.forEach(index);
    };
    index(root);
    const modelState = {
        root,
        sourceUri: pathToFileURL(files.net).href,
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: pathToFileURL(files.net).href, workflowName: 'net' } : undefined)
    } as any;
    return { files, modelState, root, s1, m };
}

type Sent = { file: string; args: Record<string, unknown> };

/** The producer: each order written as a line of the file it is sent for; refused for `refuse`'s entity. */
function producer(sent: Sent[], refuse?: string) {
    return {
        sidecarOp: (op: string) => `wfpy.${op}`,
        sendSidecarOpDetailed: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            const file = vscode.Uri.parse(uri).fsPath;
            sent.push({ file: path.basename(file), args: payload.args });
            if (payload.args['entity'] === refuse) {
                return { ok: false, failure: 'rejected', message: 'the port order of it leaves out a port' };
            }
            writeFileSync(file, readFileSync(file, 'utf8') + `${String(payload.args['entity'])}: ${(payload.args['order'] as string[]).join(', ')}\n`);
            return { ok: true };
        }
    };
}

/** The layout file: each save, by the first node's x. */
function layouts(saved: number[]) {
    return {
        saveLayoutImmediate: async (_file: string, _network: string, positions: Map<string, { x: number; y: number }>) => {
            saved.push(positions.get('s1')?.x ?? NaN);
        }
    };
}

function applyCommand(state: any, sidecar: any, layoutPersistence: any) {
    const handler = new ApplyPortOrdersOperationHandler() as any;
    handler.modelState = state;
    handler.sidecar = sidecar;
    handler.layoutPersistence = layoutPersistence;
    return handler.createCommand({
        kind: APPLY_PORT_ORDERS_OPERATION_KIND,
        isOperation: true,
        writes: [
            { entity: 'Stage', elementId: 's1', order: ['B', 'A'] },
            { entity: 'Merge', elementId: 'm', order: ['Q', 'P'] }
        ]
    });
}

describe('applying an untangle', () => {
    it('saves the layout, writes each definition\'s order in its own file, and undoes both', async () => {
        const { files, modelState, root, s1 } = design();
        const original = layoutGeometryOf(root);
        beginUntangle(modelState, { root, original, baseline: { crossings: 3, definitions: [] }, tries: [] });
        s1.position = { x: 200, y: 0 }; // the try, drawn
        const sent: Sent[] = [];
        const saved: number[] = [];
        const stack = commandStack();
        await onDisk(() => stack.execute(applyCommand(modelState, producer(sent), layouts(saved))));
        expect(sent).toEqual([
            { file: 'stages.py', args: { entity: 'Stage', order: ['B', 'A'] } },
            { file: 'merges.py', args: { entity: 'Merge', order: ['Q', 'P'] } }
        ]);
        expect(readFileSync(files.stages, 'utf8')).toBe('# stages.py\nStage: B, A\n');
        expect(readFileSync(files.merges, 'utf8')).toBe('# merges.py\nMerge: Q, P\n');
        expect(saved).toEqual([200]);
        expect(untangleOf(modelState)?.applied).toEqual({ ok: true, files: [files.stages, files.merges] });
        expect(stack.canUndo()).toBe(true);

        await onDisk(() => stack.undo());
        expect(readFileSync(files.stages, 'utf8')).toBe('# stages.py\n');
        expect(readFileSync(files.merges, 'utf8')).toBe('# merges.py\n');
        expect(saved).toEqual([200, 0]);
        await onDisk(() => stack.redo());
        expect(readFileSync(files.stages, 'utf8')).toBe('# stages.py\nStage: B, A\n');
        expect(saved).toEqual([200, 0, 200]);
    });

    it('refused for one definition, puts back the files written and the layout, and leaves nothing to undo', async () => {
        const { files, modelState, root, s1 } = design();
        beginUntangle(modelState, { root, original: layoutGeometryOf(root), baseline: { crossings: 3, definitions: [] }, tries: [] });
        s1.position = { x: 200, y: 0 };
        const sent: Sent[] = [];
        const saved: number[] = [];
        const stack = commandStack();
        await saying(() => onDisk(() => stack.execute(applyCommand(modelState, producer(sent, 'Merge'), layouts(saved)))));
        expect(sent.map(each => each.file)).toEqual(['stages.py', 'merges.py']);
        expect(readFileSync(files.stages, 'utf8')).toBe('# stages.py\n');
        expect(readFileSync(files.merges, 'utf8')).toBe('# merges.py\n');
        expect(saved).toEqual([200, 0]);
        const applied = untangleOf(modelState)?.applied;
        expect(applied?.ok).toBe(false);
        expect(applied?.message).toBe("The port order of 'Merge' in merges.py was not written: the port order of it leaves out a port. Nothing was changed.");
        expect(stack.canUndo()).toBe(false);
    });
});
