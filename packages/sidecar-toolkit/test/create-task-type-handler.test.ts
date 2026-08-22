import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CreateTaskTypeOperation } from '@dialogram/shared';

import { CreateTaskTypeOperationHandler } from '../src/server/operations/create-task-type-handler';

describe('create task type handler', () => {
    it('exposes its operation kind as a static literal readable without a resolved sidecar', () => {
        // GLSP's DefaultGlobalActionProvider reads `.operationType` off a `new constructor()`
        // built WITHOUT dependency injection, so the kind must be a plain literal — never derived
        // from the (unresolved) `sidecar`. Constructing the handler bare must not throw and the
        // kind must be readable immediately.
        const handler = new CreateTaskTypeOperationHandler();
        expect(handler.operationType).toBe('dialogram.createTaskType');
        expect(CreateTaskTypeOperation.KIND).toBe('dialogram.createTaskType');
    });

    it('scaffolds via the sidecar createTaskType op and records a reversible before/after snapshot', async () => {
        const handler = new CreateTaskTypeOperationHandler();

        // The reversible command snapshots afterText from the authoritative on-disk content the
        // sidecar wrote, so this exercises a real file the sidecar mock rewrites in place.
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'create-task-type-'));
        const workflowPath = path.join(tempRoot, 'net.py');
        let pyText = 'def make_net():\n    return None\n';
        await fs.writeFile(workflowPath, pyText);
        const sourceUri = `file://${workflowPath}`;
        let payload: { op: string; args: Record<string, unknown> } | undefined;

        const workspaceAny = vscode.workspace as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;

        workspaceAny.openTextDocument = async (_uri: unknown) => ({
            uri: {
                fsPath: workflowPath,
                toString: () => sourceUri
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => true;

        try {
            (handler as any).modelState = { sourceUri, index: { find: () => undefined } };
            (handler as any).sidecar = {
                sidecarOp: (opName: string) => `wfpy.${opName}`,
                undoLabelSuffix: () => ' (wfpy)',
                sendSidecarOpDetailed: async (
                    _sourceUri: string,
                    nextPayload: { op: string; args: Record<string, unknown> }
                ) => {
                    payload = nextPayload;
                    pyText = 'class Foo(Task):\n    pass\n\n\ndef make_net():\n    return None\n';
                    await fs.writeFile(workflowPath, pyText);
                    // No `changedFiles`: this workflow is not in a package, so
                    // the op wrote one file and the undo step covers one file.
                    return { ok: true, response: { status: 'ok' } };
                }
            };

            const command = handler.createCommand(CreateTaskTypeOperation.create({ name: 'Foo' }));
            expect(command).toBeTruthy();

            await command?.execute();

            // Only `kind` and `name` reach the sidecar — its `create_task_type(*, kind, name)`
            // signature accepts nothing else.
            // `kind` and `name` are what the runtime's create op takes;
            // `updatePackageExports` is the host SAYING it can snapshot a second
            // file for undo, so a created class may be exported from its
            // package. A host that could not do that must never ask.
            expect(payload).toEqual({
                op: 'wfpy.createTaskType',
                args: { kind: 'task', name: 'Foo', updatePackageExports: true }
            });

            // Reversible snapshot recorded → an undo entry exists.
            expect((command as any)?.canUndo()).toBe(true);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });
});
