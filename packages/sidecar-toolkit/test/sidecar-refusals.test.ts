/**
 * What the producer refuses is said, in its words, and leaves nothing half
 * done; what a copy is made with is what the original is made with; an edit
 * of a class's definition is written where the class is declared.
 *
 *   - a refused edit of a node's parameter says the producer's reason and
 *     leaves nothing on the undo stack;
 *   - a cut whose second step is refused puts the file back as it was, and
 *     says so: no half of it is left with nothing to undo it;
 *   - a duplicate is made with the original's arguments as written in its
 *     source, when the producer takes them (`createNodeExpressions`), and
 *     with none otherwise (a producer that does not know the argument);
 *   - a definition's parameter, of a class imported from another file, is
 *     sent for that file, and undone there.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CutOperation } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import { CutOperationHandler } from '../src/server/operations/cut-handler.js';
import { DuplicateOperationHandler } from '../src/server/operations/duplicate-handler.js';
import { UpdateEntityParameterOperationHandler } from '../src/server/operations/update-entity-parameter-handler.js';
import { UpdateDefinitionParameterOperationHandler } from '../src/server/operations/update-definition-parameter-handler.js';
import { commandStack, onDisk, saying } from './edits-on-disk';

const FLOW = 'flow = ...\n';

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function dir(): string {
    const at = mkdtempSync(path.join(tmpdir(), 'sidecar-refusals-'));
    made.push(at);
    return at;
}

/** A view of `flow` in its own file: `t`, a `Text` made with `text=OPTIONS`, and an edge out of it. */
function view() {
    const file = path.join(dir(), 'flow.py');
    writeFileSync(file, FLOW);
    const uri = pathToFileURL(file).href;
    const elements = new Map<string, any>([
        ['t', {
            id: 't', type: WorkflowDiagramTypes.NODE_ACTOR,
            args: {
                [WorkflowDiagramMetadata.ENTITY_NAME]: 't',
                [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Text',
                [WorkflowDiagramMetadata.ENTITY_PARAMETERS]: [
                    { name: 'text', kind: 'param', type: 'str', value: '--fast', expression: 'OPTIONS' },
                    { name: 'path', kind: 'param', type: 'File', value: "File(path='/abs/x')" }
                ]
            }
        }],
        ['e', { id: 'e', type: WorkflowDiagramTypes.EDGE_CONNECTION, args: { 'wf:from': 't', 'wf:to': 'u', 'wf:outPort': 'Out', 'wf:inPort': 'In' } }]
    ]);
    const state = {
        sourceUri: uri,
        root: { args: { sourceUri: uri, 'wf:workflowName': 'flow' } },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: uri } : undefined)
    };
    return { file, uri, state };
}

/** A producer that writes each op it is sent into `file`, refusing `refuse` with `reason`. */
function producer(file: string, options: { refuse?: string; reason?: string; features?: string[] } = {}) {
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    return {
        sent,
        sidecar: {
            sidecarOp: (op: string) => `wfpy.${op}`,
            hasFeature: async (_uri: string, feature: string) => (options.features ?? []).includes(feature),
            undoLabelSuffix: () => '',
            sendSidecarList: async () => ({ diagnostic: { names: ['t', 'u'] } }),
            sendSidecarOpDetailed: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
                sent.push(payload);
                if (payload.op === options.refuse) {
                    return { ok: false, message: options.reason };
                }
                writeFileSync(file, readFileSync(file, 'utf8') + `# ${payload.op}\n`);
                return { ok: true };
            }
        }
    };
}

describe('a refusal', () => {
    it('of a node parameter is said in the producer’s words, and leaves no undo entry', async () => {
        const { file, state } = view();
        const { sidecar } = producer(file, { refuse: 'wfpy.updateNodeParameter', reason: "'td=on'' is not an expression: unterminated string" });
        const handler = new UpdateEntityParameterOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = sidecar;
        const stack = commandStack();

        const said = await saying(async said => {
            await onDisk(file, () => stack.execute(handler.createCommand({
                kind: 'dialogram.updateEntityParameter', elementId: 't', parameterName: 'text', newValue: "td=on'"
            })));
            return said;
        });

        expect(said).toEqual(["'td=on'' is not an expression: unterminated string"]);
        expect(stack.canUndo()).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe(FLOW);
    });

    it('of a cut’s second step puts back what the first wrote, and says nothing was changed', async () => {
        const { file, state } = view();
        const { sidecar, sent } = producer(file, { refuse: 'wfpy.deleteNode', reason: "'t' is made in a loop: it cannot be taken out here." });
        const handler = new CutOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = sidecar;
        const stack = commandStack();

        const said = await saying(async said => {
            await onDisk(file, () => stack.execute(handler.createCommand(CutOperation.create({ selectedElementIds: ['t', 'e'] }))));
            return said;
        });

        expect(sent.map(each => each.op)).toEqual(['wfpy.deleteEdge', 'wfpy.deleteNode']);
        expect(readFileSync(file, 'utf8')).toBe(FLOW);
        expect(said).toEqual(["'t' is made in a loop: it cannot be taken out here. Nothing was changed."]);
        expect(stack.canUndo()).toBe(false);
    });
});

describe('a refusal’s reason', () => {
    it('is one sentence with what was done after it, whether or not the producer ends it', async () => {
        const { file, state } = view();
        const { sidecar } = producer(file, { refuse: 'wfpy.deleteNode', reason: "'t' is made in a loop: take it out there first" });
        const handler = new CutOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = sidecar;
        const said = await saying(async said => {
            await onDisk(file, () => commandStack().execute(handler.createCommand(CutOperation.create({ selectedElementIds: ['t', 'e'] }))));
            return said;
        });
        expect(said).toEqual(["'t' is made in a loop: take it out there first. Nothing was changed."]);
    });
});

describe('a duplicate', () => {
    async function duplicate(features: string[]) {
        const { file, state } = view();
        const { sidecar, sent } = producer(file, { features });
        const handler = new DuplicateOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = sidecar;
        await onDisk(file, () => commandStack().execute(handler.createCommand({ kind: 'dialogram.duplicate', elementIds: ['t'] })));
        return sent.filter(each => each.op === 'wfpy.createNode').map(each => each.args);
    }

    it('is made with the original’s arguments as written, not their values', async () => {
        expect(await duplicate(['createNodeExpressions'])).toEqual([
            { workflow: 'flow', type: 'Text', name: 't2', expressions: { text: 'OPTIONS' } }
        ]);
    });

    it('is made with none for a producer that does not take them', async () => {
        expect(await duplicate([])).toEqual([{ workflow: 'flow', type: 'Text', name: 't2' }]);
    });
});

describe('a definition parameter', () => {
    it('of a class declared in another file is sent for that file, and undone there', async () => {
        const at = dir();
        const flow = path.join(at, 'flow.py');
        const text = path.join(at, 'text.py');
        writeFileSync(flow, FLOW);
        const CLASS = 'class Text:\n    text: str\n';
        writeFileSync(text, CLASS);
        const element = {
            id: 't', type: WorkflowDiagramTypes.NODE_ACTOR,
            args: {
                [WorkflowDiagramMetadata.ENTITY_NAME]: 't',
                [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Text',
                [WorkflowDiagramMetadata.REFERENCED_URI]: pathToFileURL(text).href,
                [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true
            }
        };
        const files: string[] = [];
        const handler = new UpdateDefinitionParameterOperationHandler() as any;
        handler.modelState = { sourceUri: pathToFileURL(flow).href, index: { find: () => element, get: () => element }, root: {} };
        handler.sidecar = {
            sidecarOp: (op: string) => `wfpy.${op}`,
            sendSidecarOpDetailed: async (uri: string) => {
                files.push(uri);
                writeFileSync(text, CLASS + '    prefix: str\n');
                return { ok: true };
            }
        };
        const stack = commandStack();

        await onDisk(text, () => stack.execute(handler.createCommand({
            kind: 'dialogram.updateDefinitionParameter', elementId: 't', action: 'upsert', parameterName: 'prefix', parameterText: 'prefix: str'
        })));

        expect(files).toEqual([pathToFileURL(text).href]);
        expect(readFileSync(flow, 'utf8')).toBe(FLOW);
        await onDisk(text, () => stack.undo());
        expect(readFileSync(text, 'utf8')).toBe(CLASS);
    });
});
