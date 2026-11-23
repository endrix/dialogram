import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import {
    MERGE_ARG_REMOVALS,
    UpdateDefinitionAnnotationOperation,
    UpdateDefinitionAnnotationOperationHandler
} from '../src/server/operations/update-definition-annotation-handler.js';

/**
 * The sidecar payload a merging Save sends, for an operation with these
 * updates and removals, to a producer that takes removals or not; and the
 * warnings said.
 */
async function mergeSave(
    extra: Partial<UpdateDefinitionAnnotationOperation.Operation>,
    takesRemovals = true,
    writes = true
): Promise<{ payload: any; warnings: string[] }> {
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
    const windowAny = vscode.window as any;
    const originalWarn = windowAny.showWarningMessage;
    const warnings: string[] = [];
    windowAny.showWarningMessage = async (message: string) => { warnings.push(message); };
    workspaceAny.openTextDocument = async () => ({ uri: { fsPath: file, toString: () => sourceUri }, getText: () => text });
    workspaceAny.applyEdit = async () => true;
    try {
        (handler as any).modelState = {
            sourceUri,
            index: { find: () => ({ args: { [WorkflowDiagramMetadata.ENTITY_TYPE]: 'A' } }) }
        };
        (handler as any).sidecar = {
            sidecarOp: (name: string) => `wfpy.${name}`,
            undoLabelSuffix: () => '',
            hasFeature: async (_uri: string, feature: string) => takesRemovals && feature === MERGE_ARG_REMOVALS,
            sendSidecarOpDetailed: async (_uri: string, payload: any) => {
                calls.push(payload);
                if (!writes) {
                    return { ok: false };
                }
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
        return { payload: calls[0], warnings };
    } finally {
        workspaceAny.openTextDocument = originalOpen;
        workspaceAny.applyEdit = originalApply;
        windowAny.showWarningMessage = originalWarn;
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

describe('a merging annotation Save', () => {
    it('sends the arguments to remove beside the updates, to a producer that takes them', async () => {
        expect((await mergeSave({ argRemovals: ['mode'] })).payload).toEqual({
            op: 'wfpy.mergeDefinitionAnnotationArgs',
            args: { entityType: 'A', annotationName: 'agent', argUpdates: { prompt: '"y"' }, argRemovals: ['mode'] }
        });
    });

    it('sends no removals when there are none', async () => {
        for (const extra of [{}, { argRemovals: [] }]) {
            expect((await mergeSave(extra)).payload.args).toEqual({ entityType: 'A', annotationName: 'agent', argUpdates: { prompt: '"y"' } });
        }
    });

    it('keeps the removals from a producer that has not said it takes them, sends the updates, and says so once written', async () => {
        const { payload, warnings } = await mergeSave({ argRemovals: ['mode'] }, false);
        expect(payload.args).toEqual({ entityType: 'A', annotationName: 'agent', argUpdates: { prompt: '"y"' } });
        expect(warnings).toEqual([`'mode' stays in @agent of 'A': its producer has not said it takes arguments out.`]);
    });

    it('says nothing of the removals when the producer refuses the rest', async () => {
        const { warnings } = await mergeSave({ argRemovals: ['mode'] }, false, false);
        expect(warnings).not.toContainEqual(expect.stringContaining('stays in'));
    });

    it('merges removals alone, and asks nothing of a producer that cannot take them', async () => {
        expect((await mergeSave({ argUpdates: undefined, argRemovals: ['mode'] })).payload).toEqual({
            op: 'wfpy.mergeDefinitionAnnotationArgs',
            args: { entityType: 'A', annotationName: 'agent', argUpdates: {}, argRemovals: ['mode'] }
        });
        const refused = await mergeSave({ argUpdates: undefined, argRemovals: ['mode'] }, false);
        expect(refused.payload).toBeUndefined();
        expect(refused.warnings).toEqual([`'mode' stays in @agent of 'A': its producer has not said it takes arguments out.`]);
    });

    it('sends the values as the editor wrote them: the producer spells its own literals', async () => {
        const values = { useSkill: 'false', prompt: '"""Reply "true" when done"""' };
        expect((await mergeSave({ argUpdates: values })).payload.args.argUpdates).toEqual(values);
    });
});
