/**
 * Paste re-creates the clipboard's elements under free names and wires the
 * pasted connections to the pasted copies, not to the entities they were
 * copied from.
 */
import 'reflect-metadata';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PasteOperation } from '@eclipse-glsp/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { clipboardDataFromPayload, WorkflowDiagramTypes, WORKFLOW_NETWORK_MODEL_KEY, type DiagramClipboardPayload } from '@dialogram/shared';
import { PasteOperationHandler } from '../src/server/operations/paste-handler.js';

let dir: string;
let sourcePath: string;
let sourceUri: string;
const originalOpenTextDocument = (vscode.workspace as any).openTextDocument;
const originalShowWarningMessage = (vscode.window as any).showWarningMessage;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogram-paste-'));
    sourcePath = path.join(dir, 'top.sv');
    await fs.writeFile(sourcePath, 'module top; endmodule\n');
    sourceUri = vscode.Uri.file(sourcePath).toString();
    (vscode.workspace as any).openTextDocument = async () => ({ getText: () => 'module top; endmodule\n' });
});

afterEach(async () => {
    (vscode.workspace as any).openTextDocument = originalOpenTextDocument;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    await fs.rm(dir, { recursive: true, force: true });
});

function handlerWith(taken: string[], sent: Array<{ op: string; args: Record<string, unknown> }>): PasteOperationHandler {
    const handler = new PasteOperationHandler();
    (handler as any).modelState = {
        sourceUri,
        root: { args: { 'wf:workflowName': 'top' } },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: sourceUri } : undefined)
    };
    (handler as any).sidecar = {
        sidecarOp: (name: string) => `hdl.${name}`,
        sendSidecarOp: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            return true;
        },
        sendSidecarList: async () => ({ diagnostic: { names: taken } })
    };
    return handler;
}

async function paste(handler: PasteOperationHandler, payload: DiagramClipboardPayload) {
    const operation = PasteOperation.create({ clipboardData: clipboardDataFromPayload(payload), editorContext: { selectedElementIds: [] } });
    const command = handler.createCommand(operation) as any;
    expect(command).toBeDefined();
    return (await command.computeEdits?.()) ?? (await command.options?.computeEdits?.());
}

describe('PasteOperationHandler', () => {
    it('names the pasted entity by the shared rule and wires the pasted connection to it', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const handler = handlerWith(['src', 'add'], sent);

        await paste(handler, {
            version: 1,
            sourceUri,
            items: [
                { kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name: 'add', typeName: 'Adder' },
                { kind: 'connection', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, from: 'src', to: 'add', outPort: 'out', inPort: 'a' }
            ]
        });

        expect(sent).toEqual([
            { op: 'hdl.createNode', args: { workflow: 'top', type: 'Adder', name: 'add2' } },
            {
                op: 'hdl.connect',
                args: {
                    workflow: 'top',
                    from_port: { type: 'actor', actor: 'src', port: 'out' },
                    to_port: { type: 'actor', actor: 'add2', port: 'a' }
                }
            }
        ]);
    });

    it('keeps the copied name when the target diagram does not use it', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        await paste(handlerWith(['other'], sent), {
            version: 1,
            sourceUri,
            items: [{ kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name: 'add', typeName: 'Adder' }]
        });
        expect(sent).toEqual([{ op: 'hdl.createNode', args: { workflow: 'top', type: 'Adder', name: 'add' } }]);
    });

    it('says so, and sends nothing, when the clipboard holds no element to paste', async () => {
        const warnings: string[] = [];
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
        };
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const handler = handlerWith([], sent);

        const edits = await paste(handler, { version: 1, sourceUri, items: [] });

        expect(edits).toBeUndefined();
        expect(sent).toEqual([]);
        expect(warnings).toHaveLength(1);
    });
});
