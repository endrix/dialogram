/**
 * An edit the producer refuses leaves Undo to the edit before it.
 *
 * Every edit of the source is a command on the diagram's command stack, and
 * the producer's answer is only known once the command runs. A refused one
 * wrote nothing and cannot be undone; on top of the stack, it kept Undo from
 * reaching every edit before it, in every product. The platform's stack
 * (`WorkflowCommandStack`, the one a diagram is given) keeps no command that
 * changed nothing: after a refusal, of any of these edits, Undo undoes the
 * delete before it.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PasteOperation } from '@eclipse-glsp/protocol';
import { WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes, clipboardDataFromPayload } from '@dialogram/shared';
import { DeleteElementOperationHandler } from '../src/server/operations/delete-handler.js';
import { CreateEdgeOperationHandler } from '../src/server/operations/create-edge-handler.js';
import { RenameEntityOperation, RenameEntityOperationHandler } from '../src/server/operations/rename-entity-handler.js';
import { UpdateEntityParameterOperation, UpdateEntityParameterOperationHandler } from '../src/server/operations/update-entity-parameter-handler.js';
import { PasteOperationHandler } from '../src/server/operations/paste-handler.js';
import { commandStack, onDisk, saying } from './edits-on-disk';

const NET = 'net = ...\n';

/** The directories the files are made in, removed after each test: a scan of the temporary directory elsewhere reads them. */
const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A network `net` in a file of its own: `a`, `b`, and a port of each. */
function network() {
    const dir = mkdtempSync(path.join(tmpdir(), 'refused-edit-undo-'));
    made.push(dir);
    const file = path.join(dir, 'net.py');
    writeFileSync(file, NET);
    const sourceUri = pathToFileURL(file).href;
    const node = (name: string) => ({ id: name, type: WorkflowDiagramTypes.NODE_ACTOR, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: name } });
    const a = node('a');
    const b = node('b');
    const elements = new Map<string, any>([
        ['a', a],
        ['b', b],
        ['a.out', { id: 'a.out', type: 'port:output', parent: a, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'out' } }],
        ['b.in', { id: 'b.in', type: 'port:input', parent: b, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'in' } }]
    ]);
    const state = {
        sourceUri,
        root: { args: { sourceUri, 'wf:workflowName': 'net', [WorkflowDiagramMetadata.WORKFLOW_NAME]: 'net' } },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: sourceUri } : undefined)
    };
    return { file, sourceUri, state };
}

/** A producer that writes each op it is sent into `file`, until it `refuses` them; what it was sent. */
function producer(file: string, refuses: () => boolean, sent: string[]) {
    const answer = (op: string) => {
        sent.push(op);
        if (refuses()) {
            return { ok: false, failure: 'rejected', message: `${op} refused` };
        }
        writeFileSync(file, readFileSync(file, 'utf8') + `# ${op}\n`);
        return { ok: true };
    };
    return {
        sidecarOp: (op: string) => `calpy.${op}`,
        undoLabelSuffix: () => '',
        edgeRoles: async () => undefined,
        sendSidecarOp: async (_uri: string, payload: { op: string }) => answer(payload.op).ok,
        sendSidecarOpDetailed: async (_uri: string, payload: { op: string }) => answer(payload.op),
        sendSidecarList: async () => ({ diagnostic: { names: ['a', 'b'] } })
    };
}

/** Each edit, as its handler makes it: what it is, the op it asks the producer for, the handler, its operation. */
const EDITS: Array<[string, string, () => any, any]> = [
    ['a delete', 'calpy.deleteNode', () => new DeleteElementOperationHandler(), { kind: 'deleteElement', elementIds: ['b'] }],
    ['a connection', 'calpy.connect', () => new CreateEdgeOperationHandler(),
        { kind: 'createEdge', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, sourceElementId: 'a.out', targetElementId: 'b.in' }],
    ['a rename', 'calpy.renameNode', () => new RenameEntityOperationHandler(), { kind: RenameEntityOperation.KIND, elementId: 'b', newName: 'c' }],
    ['a parameter', 'calpy.updateNodeParameter', () => new UpdateEntityParameterOperationHandler(),
        { kind: UpdateEntityParameterOperation.KIND, elementId: 'b', parameterName: 'n', newValue: '2' }],
    ['a paste', 'calpy.createNode', () => new PasteOperationHandler(), PasteOperation.create({
        clipboardData: clipboardDataFromPayload({
            version: 1, sourceUri: '', items: [{ kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name: 'b', typeName: 'B' }]
        }),
        editorContext: { selectedElementIds: [] }
    })]
];

describe('an edit the producer refuses', () => {
    for (const [what, op, make, operation] of EDITS) {
        it(`(${what}) leaves no entry, and Undo undoes the edit before it`, async () => {
            const { file, state } = network();
            let refusing = false;
            const sent: string[] = [];
            const sidecar = producer(file, () => refusing, sent);
            const stack = commandStack();
            const run = async (handler: any, operation: any) => {
                handler.modelState = state;
                handler.sidecar = sidecar;
                const command = await handler.createCommand(operation);
                expect(command).toBeDefined();
                await saying(() => onDisk(file, () => stack.execute(command)));
            };

            await run(new DeleteElementOperationHandler(), { kind: 'deleteElement', elementIds: ['a'] });
            const deleted = readFileSync(file, 'utf8');
            expect(deleted).toBe(NET + '# calpy.deleteNode\n');

            refusing = true;
            await run(make(), operation);
            expect(sent).toContain(op);
            expect(readFileSync(file, 'utf8')).toBe(deleted);
            expect(stack.canUndo()).toBe(true);

            await onDisk(file, () => stack.undo());
            expect(readFileSync(file, 'utf8')).toBe(NET);
            expect(stack.canUndo()).toBe(false);
        });
    }
});
