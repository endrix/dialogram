import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
    UpdateDefinitionAnnotationOperation,
    UpdateDefinitionAnnotationOperationHandler
} from '../src/server/operations/update-definition-annotation-handler.js';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

describe('python agent annotation roundtrip', () => {
    it('preserves prompt, skill, claudeAgent, and use* toggles on save', async () => {
        const handler = new UpdateDefinitionAnnotationOperationHandler();

        // The reversible command snapshots afterText from the authoritative on-disk content, so
        // this drives a real file the sidecar mock rewrites in place.
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfpy-agent-annotation-'));
        const workflowPath = path.join(tempRoot, 'workflow.py');
        const sourceUri = `file://${workflowPath}`;
        let pyText = [
            'from wfpy import agent, Port',
            '',
            '@agent(prompt="OLD")',
            'class AnalyzeAgent:',
            '    class Ports:',
            '        In = Port[str](direction="in")',
            '        Out = Port[str](direction="out")',
            '',
            '    def action(self, x: str) -> str:',
            '        return x',
            ''
        ].join('\n');
        await fs.writeFile(workflowPath, pyText);

        const expectedAnnotation = [
            '@agent(',
            '    prompt="Transform inputs to outputs",',
            '    claudeAgent="code-reviewer",',
            '    skill="writer",',
            '    useClaudeAgent=True,',
            '    useSkill=True,',
            '    usePrompt=True,',
            '    useSkillHooks=False',
            ')'
        ].join('\n');

        const sidecarCalls: Array<{ sourceUri: string; payload: any }> = [];

        const workspaceAny = vscode.workspace as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: workflowPath,
                toString: () => sourceUri
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;

        try {
            (handler as any).modelState = {
                sourceUri,
                index: {
                    find: (_id: string) => ({
                        args: {
                            [WorkflowDiagramMetadata.ENTITY_TYPE]: 'AnalyzeAgent'
                        }
                    })
                }
            };
            (handler as any).sidecar = {
                sidecarOp: (name: string) => `wfpy.${name}`,
                undoLabelSuffix: () => ' (wfpy)'
            };
            (handler as any).sendSidecarOp = async (sourceUri: string, payload: any) => {
                sidecarCalls.push({ sourceUri, payload });
                const nextAnnotation = String(payload?.args?.annotationText ?? '');
                pyText = pyText.replace('@agent(prompt="OLD")', nextAnnotation);
                await fs.writeFile(workflowPath, pyText);
                return true;
            };

            const operation: UpdateDefinitionAnnotationOperation.Operation = {
                kind: UpdateDefinitionAnnotationOperation.KIND,
                elementId: 'analyze',
                action: 'upsert',
                annotationName: 'agent',
                annotationText: expectedAnnotation
            };

            const command = handler.createCommand(operation as any);
            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(sidecarCalls).toHaveLength(1);
            expect(sidecarCalls[0]?.sourceUri).toBe(sourceUri);
            expect(sidecarCalls[0]?.payload?.op).toBe('wfpy.updateDefinitionAnnotation');
            expect(sidecarCalls[0]?.payload?.args?.entityType).toBe('AnalyzeAgent');
            expect(sidecarCalls[0]?.payload?.args?.annotationName).toBe('agent');
            expect(sidecarCalls[0]?.payload?.args?.annotationText).toBe(expectedAnnotation);

            expect(pyText).toContain('prompt="Transform inputs to outputs"');
            expect(pyText).toContain('skill="writer"');
            expect(pyText).toContain('claudeAgent="code-reviewer"');
            expect(pyText).toContain('useClaudeAgent=True');
            expect(pyText).toContain('useSkill=True');
            expect(pyText).toContain('usePrompt=True');
            expect(pyText).toContain('useSkillHooks=False');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('normalizes js-style literals before sidecar update', async () => {
        const handler = new UpdateDefinitionAnnotationOperationHandler();

        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfpy-agent-annotation-'));
        const workflowPath = path.join(tempRoot, 'workflow.py');
        const sourceUri = `file://${workflowPath}`;
        let pyText = [
            'from wfpy import agent, Port',
            '',
            '@agent(prompt="OLD")',
            'class AnalyzeAgent:',
            '    class Ports:',
            '        In = Port[str](direction="in")',
            '        Out = Port[str](direction="out")',
            ''
        ].join('\n');
        await fs.writeFile(workflowPath, pyText);

        const sidecarCalls: Array<{ sourceUri: string; payload: any }> = [];

        const workspaceAny = vscode.workspace as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: workflowPath,
                toString: () => sourceUri
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;

        try {
            (handler as any).modelState = {
                sourceUri,
                index: {
                    find: (_id: string) => ({
                        args: {
                            [WorkflowDiagramMetadata.ENTITY_TYPE]: 'AnalyzeAgent'
                        }
                    })
                }
            };
            (handler as any).sidecar = {
                sidecarOp: (name: string) => `wfpy.${name}`,
                undoLabelSuffix: () => ' (wfpy)'
            };
            (handler as any).sendSidecarOp = async (sourceUri: string, payload: any) => {
                sidecarCalls.push({ sourceUri, payload });
                return true;
            };

            const operation: UpdateDefinitionAnnotationOperation.Operation = {
                kind: UpdateDefinitionAnnotationOperation.KIND,
                elementId: 'analyze',
                action: 'upsert',
                annotationName: 'agent',
                annotationText: '@agent(useSkill=true, usePrompt=false, useClaudeAgent=false, custom="true false null")'
            };

            const command = handler.createCommand(operation as any);
            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(sidecarCalls).toHaveLength(1);
            const sent = String(sidecarCalls[0]?.payload?.args?.annotationText ?? '');
            expect(sent).toContain('useSkill=True');
            expect(sent).toContain('usePrompt=False');
            expect(sent).toContain('useClaudeAgent=False');
            expect(sent).toContain('custom="true false null"');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });
});
