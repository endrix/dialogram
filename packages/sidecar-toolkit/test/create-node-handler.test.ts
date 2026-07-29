import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config.js';
import { WorkflowDiagramTypes } from '@dialogram/shared';

/**
 * The create-node vocabulary/behavior is product-supplied config (SP2c-3). These mocks stand in
 * for the calpy/wfpy `SidecarInvoker`, providing the exact byte-identical strings the shipping
 * products supply — proving the handler now reads them from config, not from a hardcoded profile.
 */
const CALPY_CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: kind => (kind === 'workflow' ? 'New network name' : 'New class name'),
    typeLabel: kind => (kind === 'workflow' ? 'network' : 'actor'),
    classNamePlaceholder: kind => (kind === 'workflow' ? 'MyNetwork' : 'MyActor'),
    sidecarDisplayName: 'CalPy sidecar',
    invalidCapabilitiesResponse: 'CalPy sidecar returned an invalid capabilities response while preparing node creation.',
    missingCapabilities: ops => `CalPy node creation is not available yet. Missing sidecar operations: ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `CalPy sidecar returned an invalid response while trying to ${action}. Missing diagnostic.${field}.`
};

const CALPY_CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: true,
    mergeProjectDiscoveredTypes: false,
    surfaceSidecarListErrors: true
};

const WFPY_CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: kind => {
        switch (kind) {
            case 'workflow': return 'workflow';
            case 'agent': return 'agent task';
            case 'viewer': return 'viewer task';
            case 'tool': return 'tool task';
            default: return 'task';
        }
    },
    classNamePlaceholder: kind => {
        switch (kind) {
            case 'workflow': return 'MyWorkflow';
            case 'agent': return 'MyAgent';
            case 'viewer': return 'MyViewer';
            case 'tool': return 'MyTool';
            default: return 'MyTask';
        }
    },
    sidecarDisplayName: 'Workflow sidecar',
    invalidCapabilitiesResponse: 'Workflow sidecar returned an invalid capabilities response while preparing node creation.',
    missingCapabilities: ops => `Workflow node creation is not available yet. Missing sidecar operations: ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `Workflow sidecar returned an invalid response while trying to ${action}. Missing diagnostic.${field}.`
};

const WFPY_CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

function calpySidecar() {
    return {
        settingsNamespace: () => 'calLang',
        sidecarOp: (opName: string) => `calpy.${opName}`,
        undoLabelSuffix: () => ' (wfpy)',
        createNodeStrings: () => CALPY_CREATE_NODE_STRINGS,
        createNodeBehavior: () => CALPY_CREATE_NODE_BEHAVIOR
    };
}

function wfpySidecar() {
    return {
        settingsNamespace: () => 'wfLang',
        sidecarOp: (opName: string) => `wfpy.${opName}`,
        undoLabelSuffix: () => ' (wfpy)',
        createNodeStrings: () => WFPY_CREATE_NODE_STRINGS,
        createNodeBehavior: () => WFPY_CREATE_NODE_BEHAVIOR
    };
}

describe('workflow create node handler', () => {
    it('shows a CalPy-specific error when the sidecar rejects task type listing', async () => {
        const handler = new CreateNodeOperationHandler();

        let pyText = [
            'from calpy import network',
            '',
            '@network',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        const errors: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/calpy.py',
                toString: () => 'file:///tmp/calpy.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showErrorMessage = async (message: string) => {
            errors.push(message);
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/calpy.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = calpySidecar();
            (handler as any).sendSidecarCapabilitiesDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        capabilities: {
                            supportedOps: ['calpy.listTaskTypes', 'calpy.createTaskType', 'calpy.listInstanceNames', 'calpy.createNode']
                        }
                    }
                }
            });
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: false,
                message: 'unsupported operation calpy.listTaskTypes',
                code: 'unknown_operation'
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(errors).toEqual([
                'CalPy sidecar failed to list available actor types (unknown_operation): unsupported operation calpy.listTaskTypes'
            ]);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('blocks CalPy create-node when required sidecar capabilities are missing', async () => {
        const handler = new CreateNodeOperationHandler();

        let pyText = [
            'from calpy import network',
            '',
            '@network',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        const errors: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/calpy.py',
                toString: () => 'file:///tmp/calpy.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showErrorMessage = async (message: string) => {
            errors.push(message);
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/calpy.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = calpySidecar();
            (handler as any).sendSidecarCapabilitiesDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        capabilities: {
                            supportedOps: ['calpy.listTaskTypes']
                        }
                    }
                }
            });
            let listCalls = 0;
            (handler as any).sendSidecarListDetailed = async () => {
                listCalls += 1;
                return {
                    ok: true,
                    response: {
                        status: 'ok',
                        diagnostic: {
                            types: ['ActorA']
                        }
                    }
                };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(errors).toEqual([
                'CalPy node creation is not available yet. Missing sidecar operations: calpy.listInstanceNames, calpy.createNode'
            ]);
            expect(listCalls).toBe(0);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('rejects malformed CalPy list responses before opening creation prompts', async () => {
        const handler = new CreateNodeOperationHandler();

        let pyText = [
            'from calpy import network',
            '',
            '@network',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        const errors: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/calpy.py',
                toString: () => 'file:///tmp/calpy.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showErrorMessage = async (message: string) => {
            errors.push(message);
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/calpy.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = calpySidecar();
            (handler as any).sendSidecarCapabilitiesDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        capabilities: {
                            supportedOps: ['calpy.listTaskTypes', 'calpy.createTaskType', 'calpy.listInstanceNames', 'calpy.createNode']
                        }
                    }
                }
            });
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {}
                }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(errors).toEqual([
                'CalPy sidecar returned an invalid response while trying to list available actor types. Missing diagnostic.types.'
            ]);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('groups existing CalPy actor types behind a separator in the picker', async () => {
        const handler = new CreateNodeOperationHandler();

        const pyText = [
            'from calpy import network',
            '',
            '@network',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowQuickPick = windowAny.showQuickPick;

        const pickedLabels: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/calpy-actor-picker.py',
                toString: () => 'file:///tmp/calpy-actor-picker.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            pickedLabels.push(...items.map(item => item.label));
            return undefined;
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/calpy-actor-picker.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = calpySidecar();
            (handler as any).sendSidecarCapabilitiesDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        capabilities: {
                            supportedOps: ['calpy.listTaskTypes', 'calpy.createTaskType', 'calpy.listInstanceNames', 'calpy.createNode']
                        }
                    }
                }
            });
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        types: ['ActorA', 'ActorB']
                    }
                }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(pickedLabels).toContain('$(add) Create new actor...');
            expect(pickedLabels).toContain('Existing actors');
            expect(pickedLabels).toContain('ActorA');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showQuickPick = originalShowQuickPick;
        }
    });

    it('reuses cached CalPy network type lists on repeated picker opens', async () => {
        const handler = new CreateNodeOperationHandler();

        const pyText = [
            'from calpy import network',
            '',
            '@network',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowQuickPick = windowAny.showQuickPick;

        const pickedLabels: string[] = [];
        let listCalls = 0;

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/calpy-network-picker.py',
                toString: () => 'file:///tmp/calpy-network-picker.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            pickedLabels.push(...items.map(item => item.label));
            return undefined;
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/calpy-network-picker.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = calpySidecar();
            (handler as any).sendSidecarCapabilitiesDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        capabilities: {
                            supportedOps: ['calpy.listWorkflowTypes', 'calpy.createWorkflowType', 'calpy.listInstanceNames', 'calpy.createNode']
                        }
                    }
                }
            });
            (handler as any).sendSidecarListDetailed = async () => {
                listCalls += 1;
                return {
                    ok: true,
                    response: {
                        status: 'ok',
                        diagnostic: {
                            types: ['NetA']
                        }
                    }
                };
            };

            const firstCommand = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_WORKFLOW,
                args: {}
            } as any);
            const secondCommand = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_WORKFLOW,
                args: {}
            } as any);

            expect(firstCommand).toBeTruthy();
            expect(secondCommand).toBeTruthy();
            await (firstCommand as any).execute();
            await (secondCommand as any).execute();

            expect(listCalls).toBe(1);
            expect(pickedLabels).toContain('$(add) Create new network...');
            expect(pickedLabels).toContain('Existing network');
            expect(pickedLabels).toContain('NetA');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showQuickPick = originalShowQuickPick;
        }
    });

    it('includes project workflow types in wfpy quick pick when sidecar returns an empty list', async () => {
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfpy-create-node-'));
        const mainPath = path.join(tempRoot, 'main.py');
        const siblingPath = path.join(tempRoot, 'shared_workflows.py');

        await fs.writeFile(mainPath, [
            'from wfpy.core import workflow',
            '',
            '@workflow()',
            'def Main():',
            '    pass',
            ''
        ].join('\n'));
        await fs.writeFile(siblingPath, [
            'from wfpy.core import workflow',
            '',
            '@workflow()',
            'def SharedWorkflow():',
            '    pass',
            ''
        ].join('\n'));

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalGetWorkspaceFolder = workspaceAny.getWorkspaceFolder;
        const originalShowQuickPick = windowAny.showQuickPick;

        const pickedLabels: string[] = [];

        workspaceAny.openTextDocument = async (uri: any) => {
            const fsPath = uri?.fsPath ?? mainPath;
            const text = await fs.readFile(fsPath, 'utf-8');
            return {
                uri: {
                    fsPath,
                    toString: () => `file://${fsPath}`
                },
                getText: () => text
            };
        };
        workspaceAny.applyEdit = async () => false;
        workspaceAny.getWorkspaceFolder = () => ({
            uri: {
                fsPath: tempRoot
            }
        });
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            pickedLabels.push(...items.map(item => item.label));
            return undefined;
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: `file://${mainPath}`,
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        types: []
                    }
                }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_WORKFLOW,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(pickedLabels).toContain('Existing workflows');
            expect(pickedLabels).toContain('SharedWorkflow');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            workspaceAny.getWorkspaceFolder = originalGetWorkspaceFolder;
            windowAny.showQuickPick = originalShowQuickPick;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('filters project wfpy task types by palette kind when sidecar returns an empty list', async () => {
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfpy-create-node-'));
        const mainPath = path.join(tempRoot, 'main.py');
        const siblingPath = path.join(tempRoot, 'shared_tasks.py');

        await fs.writeFile(mainPath, [
            'from wfpy.core import workflow',
            '',
            '@workflow()',
            'def Main():',
            '    pass',
            ''
        ].join('\n'));
        await fs.writeFile(siblingPath, [
            'from wfpy import Port, agent, viewer, tool',
            '',
            'class SharedTask:',
            '    class Ports:',
            '        In = Port[str](direction="in")',
            '',
            '    def run(self, value: str) -> str:',
            '        return value',
            '',
            '@agent(',
            '    prompt="Analyze (files) and summarize"',
            ')',
            'class AnalyzeAgent:',
            '    class Ports:',
            '        In = Port[str](direction="in")',
            '',
            '    def action(self, value: str) -> str:',
            '        return value',
            '',
            '@viewer(action="open")',
            'class RenderViewer:',
            '    pass',
            '',
            '@tool(cmd="bash")',
            'class ShellTool:',
            '    pass',
            ''
        ].join('\n'));

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalGetWorkspaceFolder = workspaceAny.getWorkspaceFolder;
        const originalShowQuickPick = windowAny.showQuickPick;

        const pickedLabels: string[] = [];

        workspaceAny.openTextDocument = async (uri: any) => {
            const fsPath = uri?.fsPath ?? mainPath;
            const text = await fs.readFile(fsPath, 'utf-8');
            return {
                uri: {
                    fsPath,
                    toString: () => `file://${fsPath}`
                },
                getText: () => text
            };
        };
        workspaceAny.applyEdit = async () => false;
        workspaceAny.getWorkspaceFolder = () => ({
            uri: {
                fsPath: tempRoot
            }
        });
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            pickedLabels.push(...items.map(item => item.label));
            return undefined;
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: `file://${mainPath}`,
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        types: []
                    }
                }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_EXTERNAL_TASK,
                args: { agentTask: true }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(pickedLabels).toContain('Existing agent task');
            expect(pickedLabels).toContain('AnalyzeAgent');
            expect(pickedLabels).not.toContain('SharedTask');
            expect(pickedLabels).not.toContain('RenderViewer');
            expect(pickedLabels).not.toContain('ShellTool');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            workspaceAny.getWorkspaceFolder = originalGetWorkspaceFolder;
            windowAny.showQuickPick = originalShowQuickPick;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('snapshots afterText from authoritative disk content, not the stale document cache', async () => {
        // The sidecar rewrites the .py out-of-band; immediately afterwards the VS Code
        // text-document layer can still return the pre-write buffer (async reconcile). The
        // reversible command must snapshot what the sidecar actually wrote so the later undo
        // guard compares the reconciled live document against a value it truly held.
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfpy-authoritative-'));
        const mainPath = path.join(tempRoot, 'main.py');

        const staleText = [
            'from wfpy.core import workflow',
            '',
            '@workflow()',
            'def Main():',
            '    pass',
            ''
        ].join('\n');
        // What the sidecar actually left on disk (the authoritative post-write content).
        const authoritativeText = staleText.replace(
            '    pass\n',
            '    In = Port[int]()\n    pass\n'
        );
        await fs.writeFile(mainPath, authoritativeText);

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowInputBox = windowAny.showInputBox;
        const originalShowWarningMessage = windowAny.showWarningMessage;

        const warnings: string[] = [];
        let liveText = staleText; // the document cache: stale right after the out-of-band write

        workspaceAny.openTextDocument = async (uri: any) => {
            const lines = () => liveText.split('\n');
            return {
                uri: {
                    fsPath: uri?.fsPath ?? mainPath,
                    toString: () => `file://${mainPath}`
                },
                getText: () => liveText,
                get lineCount() {
                    return lines().length;
                },
                lineAt: (line: number) => ({ text: lines()[line] ?? '' })
            };
        };
        workspaceAny.applyEdit = async () => true;
        const inputs = ['In', 'int(size=32)'];
        windowAny.showInputBox = async () => inputs.shift();
        windowAny.showWarningMessage = async (message: string) => {
            warnings.push(message);
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: `file://${mainPath}`,
                        'wf:workflowName': 'Main'
                    }
                }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarOpDetailed = async () => ({
                ok: true,
                response: { status: 'ok', revision: 'abc' }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            // The snapshot must equal what the sidecar wrote to disk, not the stale cache.
            expect((command as any)._sourceAfterText).toBe(authoritativeText);
            expect((command as any)._sourceAfterText).not.toBe(staleText);

            // Once the document reconciles to disk, the undo guard must accept (no warning).
            liveText = authoritativeText;
            await (command as any).undo();
            expect(warnings).toEqual([]);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showInputBox = originalShowInputBox;
            windowAny.showWarningMessage = originalShowWarningMessage;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('sources the create-node picker vocabulary from config (not a hardcoded profile)', async () => {
        const handler = new CreateNodeOperationHandler();

        const pyText = [
            'from anywhere import thing',
            '',
            '@thing',
            'def Main():',
            '    pass',
            ''
        ].join('\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowQuickPick = windowAny.showQuickPick;

        const pickedLabels: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: {
                fsPath: '/tmp/sentinel.py',
                toString: () => 'file:///tmp/sentinel.py'
            },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            pickedLabels.push(...items.map(item => item.label));
            return undefined;
        };

        try {
            (handler as any).modelState = {
                root: {
                    args: {
                        sourceUri: 'file:///tmp/sentinel.py',
                        'wf:workflowName': 'Main'
                    }
                }
            };
            // A neutral sidecar whose vocabulary is a distinct sentinel — a regression to
            // hardcoded product text would surface 'task'/'actor' instead of 'gizmo'.
            (handler as any).sidecar = {
                settingsNamespace: () => 'anyLang',
                sidecarOp: (opName: string) => `any.${opName}`,
                undoLabelSuffix: () => ' (any)',
                createNodeStrings: () => ({
                    newTypeNamePrompt: () => 'New gizmo name',
                    typeLabel: () => 'gizmo',
                    classNamePlaceholder: () => 'MyGizmo',
                    sidecarDisplayName: 'Gizmo sidecar',
                    invalidCapabilitiesResponse: 'nope',
                    missingCapabilities: (ops: string[]) => `missing ${ops.join(', ')}`,
                    invalidListResponse: (action: string, field: string) => `bad ${action} ${field}`
                }),
                createNodeBehavior: () => ({
                    capabilityProbeBeforeCreate: false,
                    mergeProjectDiscoveredTypes: false,
                    surfaceSidecarListErrors: false
                })
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        types: ['ExistingGizmo']
                    }
                }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: {}
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(pickedLabels).toContain('$(add) Create new gizmo...');
            expect(pickedLabels).toContain('Existing gizmo');
            expect(pickedLabels).toContain('ExistingGizmo');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showQuickPick = originalShowQuickPick;
        }
    });

    it('agent-dispatched create-node is non-interactive and derives the instance name', async () => {
        // Regression: an MCP/agent-originated CreateNodeOperation (args.headless) must NEVER open
        // the interactive VS Code quick-input the palette drop uses — it runs with no user present.
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-create-node-'));
        const mainPath = path.join(tempRoot, 'main.py');
        await fs.writeFile(mainPath, [
            'from wfpy.core import workflow',
            '',
            '@workflow()',
            'def Main():',
            '    pass',
            ''
        ].join('\n'));

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowInputBox = windowAny.showInputBox;
        const originalShowQuickPick = windowAny.showQuickPick;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        let inputBoxCalls = 0;
        let quickPickCalls = 0;
        const errors: string[] = [];
        let createNodeArgs: any;

        workspaceAny.openTextDocument = async (uri: any) => {
            const fsPath = uri?.fsPath ?? mainPath;
            const text = await fs.readFile(fsPath, 'utf-8');
            return { uri: { fsPath, toString: () => `file://${fsPath}` }, getText: () => text };
        };
        workspaceAny.applyEdit = async () => true;
        windowAny.showInputBox = async () => { inputBoxCalls += 1; return undefined; };
        windowAny.showQuickPick = async () => { quickPickCalls += 1; return undefined; };
        windowAny.showErrorMessage = async (message: string) => { errors.push(message); };

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: `file://${mainPath}`, 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { names: [] } }
            });
            (handler as any).sendSidecarOpDetailed = async (_uri: string, payload: any) => {
                createNodeArgs = payload.args;
                return { ok: true, response: { status: 'ok', revision: 'r1' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true, type: 'MyTask' }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(inputBoxCalls).toBe(0);
            expect(quickPickCalls).toBe(0);
            expect(errors).toEqual([]);
            expect(createNodeArgs?.type).toBe('MyTask');
            // Derived like the palette default (unique, lower-cased type name), no user typing.
            expect(createNodeArgs?.name).toBe('mytask');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showInputBox = originalShowInputBox;
            windowAny.showQuickPick = originalShowQuickPick;
            windowAny.showErrorMessage = originalShowErrorMessage;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('agent-dispatched create-node honors an explicit args.name', async () => {
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-create-node-'));
        const mainPath = path.join(tempRoot, 'main.py');
        await fs.writeFile(mainPath, '@workflow()\ndef Main():\n    pass\n');

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowInputBox = windowAny.showInputBox;

        let inputBoxCalls = 0;
        let createNodeArgs: any;

        workspaceAny.openTextDocument = async (uri: any) => {
            const fsPath = uri?.fsPath ?? mainPath;
            const text = await fs.readFile(fsPath, 'utf-8');
            return { uri: { fsPath, toString: () => `file://${fsPath}` }, getText: () => text };
        };
        workspaceAny.applyEdit = async () => true;
        windowAny.showInputBox = async () => { inputBoxCalls += 1; return undefined; };

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: `file://${mainPath}`, 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { names: [] } }
            });
            (handler as any).sendSidecarOpDetailed = async (_uri: string, payload: any) => {
                createNodeArgs = payload.args;
                return { ok: true, response: { status: 'ok', revision: 'r1' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true, type: 'MyTask', name: 'customInstance' }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(inputBoxCalls).toBe(0);
            expect(createNodeArgs?.name).toBe('customInstance');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showInputBox = originalShowInputBox;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('agent-dispatched create-node with no type fails with an actionable error, never prompting', async () => {
        const handler = new CreateNodeOperationHandler();

        const pyText = '@workflow()\ndef Main():\n    pass\n';

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowInputBox = windowAny.showInputBox;
        const originalShowQuickPick = windowAny.showQuickPick;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        let inputBoxCalls = 0;
        let quickPickCalls = 0;
        let createNodeCalls = 0;
        const errors: string[] = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: { fsPath: '/tmp/agent-ambiguous.py', toString: () => 'file:///tmp/agent-ambiguous.py' },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showInputBox = async () => { inputBoxCalls += 1; return undefined; };
        windowAny.showQuickPick = async () => { quickPickCalls += 1; return undefined; };
        windowAny.showErrorMessage = async (message: string) => { errors.push(message); };

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: 'file:///tmp/agent-ambiguous.py', 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).sendSidecarOpDetailed = async () => {
                createNodeCalls += 1;
                return { ok: true, response: { status: 'ok' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(inputBoxCalls).toBe(0);
            expect(quickPickCalls).toBe(0);
            expect(createNodeCalls).toBe(0);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('args.type');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showInputBox = originalShowInputBox;
            windowAny.showQuickPick = originalShowQuickPick;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('records an actionable rejection (with available type names) on the outcome sink for a headless missing-type create', async () => {
        // The agent never sees the toast — the sink is the contract. A headless create with no
        // args.type must record a rejection naming exactly what to pass AND the creatable types.
        const handler = new CreateNodeOperationHandler();
        const pyText = '@workflow()\ndef Main():\n    pass\n';

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        const rejected: string[] = [];
        const created: Array<{ name: string; type: string }> = [];

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: { fsPath: '/tmp/agent-missing-type.py', toString: () => 'file:///tmp/agent-missing-type.py' },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showErrorMessage = async () => {};

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: 'file:///tmp/agent-missing-type.py', 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).createNodeOutcomeSink = {
                recordRejected: (message: string) => { rejected.push(message); },
                recordCreated: (name: string, type: string) => { created.push({ name, type }); }
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { types: ['Foo', 'Bar'] } }
            });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(created).toEqual([]);
            expect(rejected).toHaveLength(1);
            expect(rejected[0]).toContain('args.type');
            expect(rejected[0]).toContain('Foo');
            expect(rejected[0]).toContain('Bar');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });

    it('records a created confirmation (name + type) on the outcome sink for a successful headless create', async () => {
        const handler = new CreateNodeOperationHandler();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-create-node-sink-'));
        const mainPath = path.join(tempRoot, 'main.py');
        await fs.writeFile(mainPath, '@workflow()\ndef Main():\n    pass\n');

        const workspaceAny = vscode.workspace as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;

        const rejected: string[] = [];
        const created: Array<{ name: string; type: string }> = [];

        workspaceAny.openTextDocument = async (uri: any) => {
            const fsPath = uri?.fsPath ?? mainPath;
            const text = await fs.readFile(fsPath, 'utf-8');
            return { uri: { fsPath, toString: () => `file://${fsPath}` }, getText: () => text };
        };
        workspaceAny.applyEdit = async () => true;

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: `file://${mainPath}`, 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).createNodeOutcomeSink = {
                recordRejected: (message: string) => { rejected.push(message); },
                recordCreated: (name: string, type: string) => { created.push({ name, type }); }
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { names: [] } }
            });
            (handler as any).sendSidecarOpDetailed = async () => ({ ok: true, response: { status: 'ok', revision: 'r1' } });

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true, type: 'BottlenecksReport', name: 'bottlenecks_report' }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(rejected).toEqual([]);
            expect(created).toEqual([{ name: 'bottlenecks_report', type: 'BottlenecksReport' }]);
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('records an actionable rejection on the outcome sink for a headless instance-name collision', async () => {
        // The 4-identical-retries scenario: the derived/explicit name already exists. The agent must
        // learn to pass a unique args.name, not silently receive a success-shaped "0 created".
        const handler = new CreateNodeOperationHandler();
        const pyText = '@workflow()\ndef Main():\n    pass\n';

        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const originalOpenTextDocument = workspaceAny.openTextDocument;
        const originalApplyEdit = workspaceAny.applyEdit;
        const originalShowErrorMessage = windowAny.showErrorMessage;

        const rejected: string[] = [];
        let createNodeCalls = 0;

        workspaceAny.openTextDocument = async (_uri: any) => ({
            uri: { fsPath: '/tmp/agent-collision.py', toString: () => 'file:///tmp/agent-collision.py' },
            getText: () => pyText
        });
        workspaceAny.applyEdit = async () => false;
        windowAny.showErrorMessage = async () => {};

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: 'file:///tmp/agent-collision.py', 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = wfpySidecar();
            (handler as any).createNodeOutcomeSink = {
                recordRejected: (message: string) => { rejected.push(message); },
                recordCreated: () => {}
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { names: ['bottlenecks_report'] } }
            });
            (handler as any).sendSidecarOpDetailed = async () => {
                createNodeCalls += 1;
                return { ok: true, response: { status: 'ok', revision: 'r1' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_TASK,
                args: { headless: true, type: 'BottlenecksReport', name: 'bottlenecks_report' }
            } as any);

            expect(command).toBeTruthy();
            await (command as any).execute();

            expect(createNodeCalls).toBe(0);
            expect(rejected).toHaveLength(1);
            expect(rejected[0]).toContain('already exists');
            expect(rejected[0]).toContain('args.name');
        } finally {
            workspaceAny.openTextDocument = originalOpenTextDocument;
            workspaceAny.applyEdit = originalApplyEdit;
            windowAny.showErrorMessage = originalShowErrorMessage;
        }
    });
});