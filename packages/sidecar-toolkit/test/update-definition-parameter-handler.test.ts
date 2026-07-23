import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

import { UpdateDefinitionParameterOperationHandler } from '../src/server/operations/update-definition-parameter-handler';

describe('workflow update definition parameter handler', () => {
    it('routes root parameter updates through the factory definition', async () => {
        const handler = new UpdateDefinitionParameterOperationHandler();

        let pyText = 'def make_decoder(scale: int = 3):\n    return scale\n';
        let payload: { op: string; args: Record<string, unknown> } | undefined;

        const workspaceAny = vscode.workspace as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;

        workspaceAny.openTextDocument = async (_uri: unknown) => ({
            uri: {
                fsPath: '/tmp/decoder.py',
                toString: () => 'file:///tmp/decoder.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => true;

        try {
            (handler as any).modelState = {
                sourceUri: 'file:///tmp/decoder.py',
                index: {
                    find: (id: string) => id === 'root'
                        ? {
                            args: {
                                [WorkflowDiagramMetadata.NETWORK_FACTORY_NAME]: 'pkg.mod.make_decoder'
                            }
                        }
                        : undefined
                }
            };
            (handler as any).sidecar = {
                sidecarOp: (opName: string) => `wfpy.${opName}`,
                sendSidecarOp: async (_sourceUri: string, nextPayload: { op: string; args: Record<string, unknown> }) => {
                    payload = nextPayload;
                    pyText = 'def make_decoder(scale: int = 7):\n    return scale\n';
                    return true;
                }
            };

            const command = handler.createCommand({
                kind: 'dialogram.updateDefinitionParameter',
                elementId: 'root',
                action: 'upsert',
                parameterName: 'scale',
                parameterText: 'scale: int = 7'
            } as any);

            expect(command).toBeTruthy();
            await command?.execute();

            expect(payload).toEqual({
                op: 'wfpy.updateDefinitionParameter',
                args: {
                    entityType: 'make_decoder',
                    parameterName: 'scale',
                    parameterText: 'scale: int = 7'
                }
            });
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
        }
    });
});