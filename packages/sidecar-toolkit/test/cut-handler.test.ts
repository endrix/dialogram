/**
 * Cut: what is selected goes on the clipboard and is taken out by the
 * producer, as a delete of it would take it out, and the file can be
 * undone. What a delete keeps, a cut keeps: a read-only element, and all of
 * a read-only view (its transitions, which a delete may take out there, are
 * not cut: the clipboard carries none). A cut that takes out nothing makes
 * no command.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CutOperation } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, parseClipboardPayload } from '@dialogram/shared';
import { CutOperationHandler } from '../src/server/operations/cut-handler.js';
import { commandStack, onDisk } from './edits-on-disk';

const NET = 'net = ...\n';

/** The directories the files are made in, removed after each test: a scan of the temporary directory elsewhere reads them. */
const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A view of `net`, in a file of its own: `a`, an edge from it, a port of the view, a read-only node, a transition. */
function view(rootArgs: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'cut-handler-'));
    made.push(dir);
    const file = path.join(dir, 'net.py');
    writeFileSync(file, NET);
    const elements = new Map<string, any>([
        ['a', { id: 'a', type: WorkflowDiagramTypes.NODE_ACTOR, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'a', [WorkflowDiagramMetadata.ENTITY_TYPE]: 'A' } }],
        ['e', { id: 'e', type: WorkflowDiagramTypes.EDGE_CONNECTION, args: { 'wf:from': 'a', 'wf:to': 'b', 'wf:outPort': 'out', 'wf:inPort': 'in' } }],
        ['x', { id: 'x', type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'x' } }],
        ['read-only', {
            id: 'read-only', type: WorkflowDiagramTypes.NODE_ACTOR,
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'ro', [WorkflowDiagramMetadata.ENTITY_TYPE]: 'R', [WorkflowDiagramMetadata.IS_READ_ONLY]: true }
        }],
        ['t:idle:go->run', { id: 't:idle:go->run', type: WorkflowDiagramTypes.EDGE_TRANSITION, args: {} }]
    ]);
    const state = {
        root: { args: { sourceUri: pathToFileURL(file).href, 'wf:workflowName': 'net', ...rootArgs } },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) }
    };
    return { file, state };
}

/** Cut `ids` of `state`'s view, on the platform's stack, the producer writing each op it is sent into the file. */
async function cut(file: string, state: any, ids: string[]) {
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const handler = new CutOperationHandler() as any;
    handler.modelState = state;
    handler.sidecar = {
        sidecarOp: (op: string) => `calpy.${op}`,
        hasFeature: async () => false,
        undoLabelSuffix: () => '',
        async sendSidecarOpDetailed(uri: string, payload: any) { return { ok: await (this as any).sendSidecarOp(uri, payload) }; },
        sendSidecarOp: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            writeFileSync(file, readFileSync(file, 'utf8') + `# ${payload.op}\n`);
            return true;
        }
    };
    (vscode as any).env.clipboard.text = '';
    const stack = commandStack();
    const command = handler.createCommand(CutOperation.create({ selectedElementIds: ids }));
    if (command) {
        await onDisk(file, () => stack.execute(command));
    }
    const clipboard = (vscode as any).env.clipboard.text as string;
    return {
        command, sent, stack,
        cut: clipboard ? parseClipboardPayload(JSON.parse(clipboard))?.items.map(item => item.kind) : undefined
    };
}

describe('cut', () => {
    it('in a network view, puts the selection on the clipboard, has the producer take it out, its connections first, and can be undone', async () => {
        const { file, state } = view();
        const { sent, stack, cut: items } = await cut(file, state, ['a', 'e', 'x', 'read-only']);
        expect(items).toEqual(['entity', 'connection', 'boundaryPort']);
        expect(sent).toEqual([
            { op: 'calpy.deleteEdge', args: { workflow: 'net', from_expr: 'a.out', to_expr: 'b.in' } },
            { op: 'calpy.deleteNode', args: { workflow: 'net', name: 'a' } },
            { op: 'calpy.deletePort', args: { workflow: 'net', direction: 'input', portName: 'x' } }
        ]);
        expect(stack.canUndo()).toBe(true);
        await onDisk(file, () => stack.undo());
        expect(readFileSync(file, 'utf8')).toBe(NET);
    });

    it('in a read-only view, takes out nothing and makes no command, whether or not it allows editing its transitions', async () => {
        for (const rootArgs of [
            { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true },
            { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true, [WorkflowDiagramMetadata.VIEW_EDITS]: ['transition'] }
        ]) {
            const { file, state } = view(rootArgs);
            const { command, sent, cut: items } = await cut(file, state, ['a', 'e', 'x', 't:idle:go->run']);
            expect(command).toBeUndefined();
            expect(sent).toEqual([]);
            expect(items).toBeUndefined();
            expect(readFileSync(file, 'utf8')).toBe(NET);
        }
    });

    it('of only what is read-only, makes no command', async () => {
        const { file, state } = view();
        const { command, sent } = await cut(file, state, ['read-only']);
        expect(command).toBeUndefined();
        expect(sent).toEqual([]);
    });
});
