/**
 * A palette entry that asks for a node VARIANT must reach the create wizard.
 *
 * Most palette entries are identified by their element type. A variant node is
 * not: one entry stands for several shapes of the same kind, and which one is
 * chosen in the wizard — so the entry carries an arg instead, and the element
 * type it borrows is shared with an unrelated kind.
 *
 * The gate that opens the wizard tested only the element-type flags. A variant
 * entry set none of them (its arg deliberately excludes it from the plain
 * external-task flag), so it fell through to the bare "enter a type name" box:
 * no variant prompt, no type ever created, and the wizard's variant code
 * unreachable. Nothing errored — the node was simply created as an instance of
 * a type that does not exist.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import type { CreateNodeStrings, CreateNodeBehavior } from '../src/server/sidecar-runtime-config.js';
import { WorkflowDiagramTypes } from '@dialogram/shared';

const STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: kind => {
        switch (kind) {
            case 'workflow': return 'workflow';
            case 'agent': return 'agent task';
            case 'viewer': return 'viewer task';
            case 'tool': return 'tool task';
            case 'streamblocks': return 'StreamBlocks node';
            case 'source': return 'source';
            default: return 'task';
        }
    },
    classNamePlaceholder: kind => (kind === 'streamblocks' ? 'MyDesign' : 'MyTask'),
    sidecarDisplayName: 'sidecar',
    invalidCapabilitiesResponse: 'invalid capabilities',
    missingCapabilities: ops => `missing: ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `invalid ${action} ${field}`
};

const BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

/** Runs one create-node command, recording every prompt it opens. */
async function runCreate(args: Record<string, unknown>) {
    const handler = new CreateNodeOperationHandler();
    const workspaceAny = vscode.workspace as any;
    const windowAny = vscode.window as any;

    const original = {
        openTextDocument: workspaceAny.openTextDocument,
        applyEdit: workspaceAny.applyEdit,
        showQuickPick: windowAny.showQuickPick,
        showInputBox: windowAny.showInputBox
    };

    const quickPickTitles: string[] = [];
    const quickPickLabels: string[] = [];
    const inputPrompts: string[] = [];

    workspaceAny.openTextDocument = async () => ({
        uri: { fsPath: '/tmp/flow.py', toString: () => 'file:///tmp/flow.py' },
        getText: () => 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n'
    });
    workspaceAny.applyEdit = async () => false;
    windowAny.showQuickPick = async (items: Array<{ label: string }>, options: any) => {
        if (options?.title) { quickPickTitles.push(String(options.title)); }
        if (options?.placeHolder) { quickPickTitles.push(String(options.placeHolder)); }
        quickPickLabels.push(...items.map(item => item.label));
        return undefined;
    };
    windowAny.showInputBox = async (options: any) => {
        inputPrompts.push(String(options?.prompt ?? ''));
        return undefined;
    };

    try {
        (handler as any).modelState = {
            root: { args: { sourceUri: 'file:///tmp/flow.py', 'wf:workflowName': 'Main' } }
        };
        (handler as any).sidecar = {
            settingsNamespace: () => 'wfLang',
            sidecarOp: (op: string) => `wfpy.${op}`,
            undoLabelSuffix: () => ' (wf)',
            createNodeStrings: () => STRINGS,
            createNodeBehavior: () => BEHAVIOR
        };
        (handler as any).sendSidecarListDetailed = async () => ({
            ok: true,
            response: { status: 'ok', diagnostic: { types: [] } }
        });

        const command = handler.createCommand({
            kind: 'createNode',
            elementTypeId: WorkflowDiagramTypes.NODE_EXTERNAL_TASK,
            args
        } as any);
        expect(command).toBeTruthy();
        await (command as any).execute();
    } finally {
        workspaceAny.openTextDocument = original.openTextDocument;
        workspaceAny.applyEdit = original.applyEdit;
        windowAny.showQuickPick = original.showQuickPick;
        windowAny.showInputBox = original.showInputBox;
    }

    return { quickPickTitles, quickPickLabels, inputPrompts };
}

describe('a variant palette entry', () => {
    it('opens the type picker instead of a bare name box', async () => {
        const { quickPickLabels, inputPrompts } = await runCreate({ streamblocksNode: true });

        expect(quickPickLabels).toContain('$(add) Create new StreamBlocks node...');
        expect(inputPrompts).not.toContain('Enter task type name');
    });

    it('labels the picker with the variant vocabulary, not the generic one', async () => {
        const { quickPickTitles, quickPickLabels } = await runCreate({ streamblocksNode: true });

        const shown = [...quickPickTitles, ...quickPickLabels].join('\n');
        expect(shown).toContain('StreamBlocks node');
        // 'task' is the fallback label; seeing it means the kind resolved wrong.
        expect(shown).not.toMatch(/\btask\b/);
    });
});

/**
 * Widening the gate must not change where the entries already going through it
 * land. The same element type with no variant arg is a plain external task, and
 * it must still be labelled one.
 */
describe('the entries that already reached the wizard', () => {
    it('still routes a plain external entry to its own vocabulary', async () => {
        const { quickPickLabels } = await runCreate({});

        expect(quickPickLabels).toContain('$(add) Create new tool task...');
        expect(quickPickLabels).not.toContain('$(add) Create new StreamBlocks node...');
    });

    it('still routes an agent entry to its own vocabulary', async () => {
        const { quickPickLabels } = await runCreate({ agentTask: true });

        expect(quickPickLabels).toContain('$(add) Create new agent task...');
    });
});

/**
 * Opening the picker is only the first step. The point of a variant entry is
 * the follow-up question and the request it finally produces, so this answers
 * every prompt and inspects what actually reached the sidecar.
 */
describe('a variant entry, driven to the end', () => {
    it('creates the type with the variant and path that were chosen', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-wizard-'));
        const file = path.join(dir, 'flow.py');
        await fs.writeFile(file, 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n');

        const handler = new CreateNodeOperationHandler();
        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const original = {
            openTextDocument: workspaceAny.openTextDocument,
            applyEdit: workspaceAny.applyEdit,
            showQuickPick: windowAny.showQuickPick,
            showInputBox: windowAny.showInputBox
        };
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];

        workspaceAny.openTextDocument = async () => ({
            uri: { fsPath: file, toString: () => `file://${file}` },
            getText: () => 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n'
        });
        workspaceAny.applyEdit = async () => false;

        // Answer by matching the prompt, not by counting calls: a sequence
        // would still "pass" if the wizard asked its questions in a different
        // order, or skipped one.
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            const labels = items.map(i => i.label);
            const pick = (needle: string) => items.find(i => i.label.includes(needle));
            return pick('Create new') ?? pick('Instance') ?? pick('Type a path')
                ?? (() => { throw new Error(`unanswered quick pick: ${labels.join(', ')}`); })();
        };
        windowAny.showInputBox = async (options: any) => {
            const prompt = String(options?.prompt ?? '');
            if (prompt.includes('class name')) { return 'Adder'; }
            if (prompt.includes('network file')) { return 'designs/adder.py'; }
            return 'adder';
        };

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: `file://${file}`, 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = {
                settingsNamespace: () => 'wfLang',
                sidecarOp: (op: string) => `wfpy.${op}`,
                undoLabelSuffix: () => ' (wf)',
                createNodeStrings: () => STRINGS,
                createNodeBehavior: () => BEHAVIOR
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { types: [], names: [] } }
            });
            (handler as any).sendSidecarOpDetailed = async (_uri: unknown, request: any) => {
                sent.push({ op: request.op, args: request.args });
                return { ok: true, response: { status: 'ok' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_EXTERNAL_TASK,
                args: { streamblocksNode: true }
            } as any);
            expect(command).toBeTruthy();
            await (command as any).execute();
        } finally {
            workspaceAny.openTextDocument = original.openTextDocument;
            workspaceAny.applyEdit = original.applyEdit;
            windowAny.showQuickPick = original.showQuickPick;
            windowAny.showInputBox = original.showInputBox;
            await fs.rm(dir, { recursive: true, force: true });
        }

        const created = sent.find(r => r.op === 'wfpy.createTaskType');
        expect(created, 'no type was created — the wizard was never reached').toBeDefined();
        expect(created!.args.kind).toBe('streamblocks');
        expect(created!.args.facade).toBe('instance');
        expect(created!.args.network).toBe('designs/adder.py');
    });
});

/**
 * A source node asks a different question: not which variant, but what shape of
 * resource — and the answer decides how the resource is asked for. A file and a
 * folder each have a picker; a web resource has neither.
 */
describe('a source palette entry', () => {
    async function createSource(answers: {
        shape: string;
        picked?: string;
        typed?: string;
        viewType?: string;
    }) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-wizard-'));
        const file = path.join(dir, 'flow.py');
        await fs.writeFile(file, 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n');

        const handler = new CreateNodeOperationHandler();
        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;
        const original = {
            openTextDocument: workspaceAny.openTextDocument,
            applyEdit: workspaceAny.applyEdit,
            asRelativePath: workspaceAny.asRelativePath,
            showQuickPick: windowAny.showQuickPick,
            showInputBox: windowAny.showInputBox,
            showOpenDialog: windowAny.showOpenDialog
        };
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const dialogs: Array<Record<string, unknown>> = [];

        workspaceAny.openTextDocument = async () => ({
            uri: { fsPath: file, toString: () => `file://${file}` },
            getText: () => 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n'
        });
        workspaceAny.applyEdit = async () => false;
        workspaceAny.asRelativePath = (target: any) => String(target?.fsPath ?? target);
        windowAny.showQuickPick = async (items: Array<{ label: string }>) => {
            const pick = (needle: string) => items.find(i => i.label.includes(needle));
            return pick('Create new') ?? pick(answers.shape)
                ?? (() => { throw new Error(`unanswered: ${items.map(i => i.label).join(', ')}`); })();
        };
        windowAny.showInputBox = async (options: any) => {
            const prompt = String(options?.prompt ?? '');
            if (prompt.includes('class name')) { return 'Frames'; }
            if (prompt.includes('address')) { return answers.typed ?? ''; }
            if (prompt.includes('Open with')) { return answers.viewType ?? ''; }
            return 'frames';
        };
        windowAny.showOpenDialog = async (options: any) => {
            dialogs.push(options);
            return answers.picked ? [{ fsPath: answers.picked }] : undefined;
        };

        try {
            (handler as any).modelState = {
                root: { args: { sourceUri: `file://${file}`, 'wf:workflowName': 'Main' } }
            };
            (handler as any).sidecar = {
                settingsNamespace: () => 'wfLang',
                sidecarOp: (op: string) => `wfpy.${op}`,
                undoLabelSuffix: () => ' (wf)',
                createNodeStrings: () => STRINGS,
                createNodeBehavior: () => BEHAVIOR
            };
            (handler as any).sendSidecarListDetailed = async () => ({
                ok: true,
                response: { status: 'ok', diagnostic: { types: [], names: [] } }
            });
            (handler as any).sendSidecarOpDetailed = async (_uri: unknown, request: any) => {
                sent.push({ op: request.op, args: request.args });
                return { ok: true, response: { status: 'ok' } };
            };

            const command = handler.createCommand({
                kind: 'createNode',
                elementTypeId: WorkflowDiagramTypes.NODE_EXTERNAL_TASK,
                args: { sourceNode: true }
            } as any);
            expect(command).toBeTruthy();
            await (command as any).execute();
        } finally {
            Object.assign(workspaceAny, {
                openTextDocument: original.openTextDocument,
                applyEdit: original.applyEdit,
                asRelativePath: original.asRelativePath
            });
            Object.assign(windowAny, {
                showQuickPick: original.showQuickPick,
                showInputBox: original.showInputBox,
                showOpenDialog: original.showOpenDialog
            });
            await fs.rm(dir, { recursive: true, force: true });
        }

        return {
            created: sent.find(r => r.op === 'wfpy.createTaskType'),
            dialogs
        };
    }

    /**
     * The kind sent to the sidecar and the kind the picker is labelled with are
     * resolved separately, so one can be right while the other silently reads
     * "task" — and the user is asked to name a task while a source is built.
     */
    it('labels the picker as a source, not a task', async () => {
        const { quickPickLabels } = await runCreate({ sourceNode: true });

        expect(quickPickLabels).toContain('$(add) Create new source...');
        expect(quickPickLabels).not.toContain('$(add) Create new task...');
    });

    it('creates a source type, not a task', async () => {
        const { created } = await createSource({ shape: 'File', picked: '/w/in/frames.yuv' });

        expect(created, 'no type was created').toBeDefined();
        expect(created!.args.kind).toBe('source');
    });

    it('offers a file picker for a file', async () => {
        const { dialogs } = await createSource({ shape: 'File', picked: '/w/in/frames.yuv' });

        expect(dialogs).toHaveLength(1);
        expect(dialogs[0].canSelectFiles).toBe(true);
        expect(dialogs[0].canSelectFolders).toBe(false);
    });

    it('offers a folder picker for a folder', async () => {
        const { dialogs } = await createSource({ shape: 'Folder', picked: '/w/designs' });

        expect(dialogs).toHaveLength(1);
        expect(dialogs[0].canSelectFolders).toBe(true);
        expect(dialogs[0].canSelectFiles).toBe(false);
    });

    /** There is nothing on disk to browse to, so a dialog would be a dead end. */
    it('asks for an address for a web resource, with no picker', async () => {
        const { dialogs } = await createSource({
            shape: 'Web resource',
            typed: 'https://example.com/data.json'
        });

        expect(dialogs).toHaveLength(0);
    });

    it('carries the editor when one is named', async () => {
        const { created } = await createSource({
            shape: 'File',
            picked: '/w/in/adder.py',
            viewType: 'product.diagram'
        });

        expect(created!.args.viewType).toBe('product.diagram');
    });

    /**
     * Skipping the question is the common case, and an empty string written
     * out would name an editor called "" — which matches nothing.
     */
    it('sends no editor when the question is skipped', async () => {
        const { created } = await createSource({ shape: 'File', picked: '/w/in/frames.yuv' });

        expect(created!.args.viewType).toBeUndefined();
    });

    it('stops without creating anything when the picker is dismissed', async () => {
        const { created } = await createSource({ shape: 'File' });

        expect(created).toBeUndefined();
    });
});
