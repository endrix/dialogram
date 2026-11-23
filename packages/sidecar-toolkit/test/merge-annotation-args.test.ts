import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import {
    UpdateDefinitionAnnotationOperation,
    UpdateDefinitionAnnotationOperationHandler
} from '../src/server/operations/update-definition-annotation-handler.js';

/** The sidecar payload a merging Save sends, for an operation with these updates and removals. */
async function mergePayload(extra: Partial<UpdateDefinitionAnnotationOperation.Operation>): Promise<any> {
    const handler = new UpdateDefinitionAnnotationOperationHandler();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogram-merge-args-'));
    const file = path.join(tempRoot, 'workflow.py');
    const sourceUri = `file://${file}`;
    let text = '@agent(prompt="x", mode="plan")\nclass A:\n    pass\n';
    await fs.writeFile(file, text);
    const calls: any[] = [];
    const workspaceAny = vscode.workspace as any;
    const originalOpen = workspaceAny.openTextDocument;
    const originalApply = workspaceAny.applyEdit;
    workspaceAny.openTextDocument = async () => ({ uri: { fsPath: file, toString: () => sourceUri }, getText: () => text });
    workspaceAny.applyEdit = async () => false;
    try {
        (handler as any).modelState = {
            sourceUri,
            index: { find: () => ({ args: { [WorkflowDiagramMetadata.ENTITY_TYPE]: 'A' } }) }
        };
        (handler as any).sidecar = {
            sidecarOp: (name: string) => `wfpy.${name}`,
            undoLabelSuffix: () => '',
            sendSidecarOpDetailed: async (_uri: string, payload: any) => {
                calls.push(payload);
                text = '@agent(prompt="y")\nclass A:\n    pass\n';
                await fs.writeFile(file, text);
                return { ok: true };
            }
        };
        const command = handler.createCommand({
            kind: UpdateDefinitionAnnotationOperation.KIND,
            elementId: 'a',
            action: 'upsert',
            annotationName: 'agent',
            annotationText: '@agent(prompt="y")',
            argUpdates: { prompt: '"y"' },
            ...extra
        } as any);
        await (command as any).execute();
        return calls[0];
    } finally {
        workspaceAny.openTextDocument = originalOpen;
        workspaceAny.applyEdit = originalApply;
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

describe('a merging annotation Save', () => {
    it('sends the arguments to remove beside the updates', async () => {
        expect(await mergePayload({ argRemovals: ['mode'] })).toEqual({
            op: 'wfpy.mergeDefinitionAnnotationArgs',
            args: { entityType: 'A', annotationName: 'agent', argUpdates: { prompt: '"y"' }, argRemovals: ['mode'] }
        });
    });

    it('sends no removals when there are none, as a producer that predates them expects', async () => {
        for (const extra of [{}, { argRemovals: [] }]) {
            expect((await mergePayload(extra)).args).toEqual({ entityType: 'A', annotationName: 'agent', argUpdates: { prompt: '"y"' } });
        }
    });
});
