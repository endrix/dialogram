/**
 * Delete in a network view: what is selected is taken out by the producer,
 * a node, an edge or a port each, and the file can be undone. What cannot
 * be deleted (a read-only element, an edge with no ports, a piece of line
 * several edges share inside a group) is kept, and a selection of nothing
 * else makes no command at all: nothing goes on the undo stack.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { DeleteElementOperationHandler } from '../src/server/operations/delete-handler.js';

const NET = 'net = ...\n';

/** A network `net` in a file of its own: `a`, an edge from it, a port, and three things not to delete. */
function network() {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'delete-handler-')), 'net.py');
    writeFileSync(file, NET);
    const elements = new Map<string, any>([
        ['a', { id: 'a', type: WorkflowDiagramTypes.NODE_ACTOR, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'a' } }],
        ['e', { id: 'e', type: WorkflowDiagramTypes.EDGE_CONNECTION, args: { 'wf:from': 'a', 'wf:to': 'b', 'wf:outPort': 'out', 'wf:inPort': 'in' } }],
        ['p', { id: 'p', type: 'port:input', args: { [WorkflowDiagramMetadata.PORT_NAME]: 'x', [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input' } }],
        ['read-only', { id: 'read-only', type: WorkflowDiagramTypes.NODE_ACTOR, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'ro', [WorkflowDiagramMetadata.IS_READ_ONLY]: true } }],
        ['portless', { id: 'portless', type: WorkflowDiagramTypes.EDGE_CONNECTION, args: { 'wf:from': 'a', 'wf:to': 'b' } }],
        ['shared', { id: 'shared', type: WorkflowDiagramTypes.EDGE_CONNECTION, args: { [WorkflowDiagramMetadata.EDGES_OF]: ['e1', 'e2'], 'wf:outPort': 'o', 'wf:inPort': 'i' } }]
    ]);
    const state = {
        root: { args: { sourceUri: pathToFileURL(file).href, 'wf:workflowName': 'net' } },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) }
    };
    return { file, state };
}

/** Delete `ids`, the producer writing each op it is sent into the file; the command, what was sent, the file after. */
async function remove(ids: string[]) {
    const { file, state } = network();
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const handler = new DeleteElementOperationHandler() as any;
    handler.modelState = state;
    handler.sidecar = {
        sidecarOp: (op: string) => `calpy.${op}`,
        undoLabelSuffix: () => '',
        edgeRoles: async () => undefined,
        sendSidecarOp: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            writeFileSync(file, readFileSync(file, 'utf8') + `# ${payload.op}\n`);
            return true;
        }
    };
    const workspace = vscode.workspace as any;
    const window = vscode.window as any;
    const saved = { open: workspace.openTextDocument, apply: workspace.applyEdit, info: window.showInformationMessage };
    const said: string[] = [];
    workspace.openTextDocument = async () => ({
        getText: () => readFileSync(file, 'utf8'), isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true
    });
    workspace.applyEdit = async () => true;
    window.showInformationMessage = async (message: string) => { said.push(message); };
    try {
        const command = handler.createCommand({ kind: 'deleteElement', elementIds: ids });
        await command?.execute();
        return { command, sent, said, text: readFileSync(file, 'utf8') };
    } finally {
        workspace.openTextDocument = saved.open;
        workspace.applyEdit = saved.apply;
        window.showInformationMessage = saved.info;
    }
}

describe('delete in a network view', () => {
    it('takes out a node, an edge or a port, and can be undone', async () => {
        for (const [id, op, args] of [
            ['a', 'calpy.deleteNode', { workflow: 'net', name: 'a' }],
            ['e', 'calpy.deleteEdge', { workflow: 'net', from_expr: 'a.out', to_expr: 'b.in' }],
            ['p', 'calpy.deletePort', { workflow: 'net', direction: 'input', portName: 'x' }]
        ] as const) {
            const { command, sent, text } = await remove([id]);
            expect(sent).toEqual([{ op, args }]);
            expect(text).not.toBe(NET);
            expect(command.canUndo()).toBe(true);
        }
    });

    it('keeps what cannot be deleted, and takes out the rest', async () => {
        const { command, sent } = await remove(['read-only', 'portless', 'shared', 'a']);
        expect(sent.map(each => each.op)).toEqual(['calpy.deleteNode']);
        expect(command.canUndo()).toBe(true);
    });

    it('makes no command of a selection with nothing to delete, saying why for a line several edges share', async () => {
        const { command, sent, said, text } = await remove(['read-only', 'portless', 'shared']);
        expect(command).toBeUndefined();
        expect(sent).toEqual([]);
        expect(text).toBe(NET);
        expect(said).toEqual(['That line inside the group stands for 2 edges. Select one of them where it runs between groups to delete it.']);
    });
});
