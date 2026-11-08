/**
 * A variant whose node is picked from what the sidecar finds.
 *
 * Some nodes stand for a thing that already exists in the project — a run a
 * product recorded, say — and that thing decides the node's type. The type
 * list is the wrong question there, so the wizard asks the sidecar for the
 * candidates instead, and the one chosen fills in the type, the node's
 * parameter and whatever else `createNode` needs for it.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import type {
    CreateNodeBehavior,
    CreateNodeStrings,
    CreateNodeVariant,
    CreateNodeVariantCandidate
} from '../src/server/sidecar-runtime-config.js';
import { WorkflowDiagramTypes } from '@dialogram/shared';

const STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: kind => (kind === 'workflow' ? 'workflow' : 'task'),
    classNamePlaceholder: () => 'MyTask',
    sidecarDisplayName: 'sidecar',
    invalidCapabilitiesResponse: 'invalid capabilities',
    missingCapabilities: ops => `missing: ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `invalid ${action} ${field}`
};

const VARIANTS: CreateNodeVariant[] = [
    {
        paletteArg: 'recordedNode',
        kind: 'workflow',
        decorator: 'workflow',
        prompt: 'unused',
        choices: [],
        pick: {
            op: 'listRecorded',
            argName: 'instance',
            prompt: 'Which recording?',
            emptyMessage: 'Nothing recorded yet.'
        }
    }
];

const BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

const CANDIDATES: CreateNodeVariantCandidate[] = [
    { label: 'child', description: 'r2', type: 'child', value: 'wf-out/r2', nodeArgs: { importFrom: 'flows.child' } },
    { label: 'other', description: 'r1', type: 'other', value: 'wf-out/r1' }
];

async function runCreate(options: {
    args: Record<string, unknown>;
    candidates?: unknown[];
    choose?: string;
}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picked-wizard-'));
    const file = path.join(dir, 'flow.py');
    await fs.writeFile(file, 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n');

    const handler = new CreateNodeOperationHandler();
    const workspaceAny = vscode.workspace as any;
    const windowAny = vscode.window as any;
    const original = {
        openTextDocument: workspaceAny.openTextDocument,
        applyEdit: workspaceAny.applyEdit,
        showQuickPick: windowAny.showQuickPick,
        showInputBox: windowAny.showInputBox,
        showInformationMessage: windowAny.showInformationMessage,
        showErrorMessage: windowAny.showErrorMessage
    };
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const listed: string[] = [];
    const pickers: string[] = [];
    const shownLabels: string[] = [];
    const messages: string[] = [];

    workspaceAny.openTextDocument = async () => ({
        uri: { fsPath: file, toString: () => `file://${file}` },
        getText: () => 'from wfpy import workflow\n\n@workflow\ndef Main():\n    pass\n'
    });
    workspaceAny.applyEdit = async () => false;
    windowAny.showQuickPick = async (items: Array<{ label: string }>, opts: any) => {
        pickers.push(String(opts?.placeHolder ?? ''));
        shownLabels.push(...items.map(i => i.label));
        return items.find(i => i.label === options.choose);
    };
    // Accept the default instance name.
    windowAny.showInputBox = async (opts: any) => opts?.value;
    windowAny.showInformationMessage = async (message: string) => { messages.push(message); };
    windowAny.showErrorMessage = async (message: string) => { messages.push(message); };

    try {
        (handler as any).modelState = {
            root: { args: { sourceUri: `file://${file}`, 'wf:workflowName': 'Main' } }
        };
        (handler as any).sidecar = {
            settingsNamespace: () => 'wfLang',
            sidecarOp: (op: string) => `wfpy.${op}`,
            undoLabelSuffix: () => ' (wf)',
            createNodeStrings: () => STRINGS,
            createNodeBehavior: () => BEHAVIOR,
            createNodeVariants: () => VARIANTS
        };
        (handler as any).sendSidecarListDetailed = async (_uri: unknown, request: any) => {
            listed.push(request.op);
            return {
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: { types: [], names: [], candidates: options.candidates ?? CANDIDATES }
                }
            };
        };
        (handler as any).sendSidecarOpDetailed = async (_uri: unknown, request: any) => {
            sent.push({ op: request.op, args: request.args });
            return { ok: true, response: { status: 'ok' } };
        };

        const command = handler.createCommand({
            kind: 'createNode',
            elementTypeId: WorkflowDiagramTypes.NODE_WORKFLOW,
            args: options.args
        } as any);
        expect(command).toBeTruthy();
        await (command as any).execute();
    } finally {
        workspaceAny.openTextDocument = original.openTextDocument;
        workspaceAny.applyEdit = original.applyEdit;
        windowAny.showQuickPick = original.showQuickPick;
        windowAny.showInputBox = original.showInputBox;
        windowAny.showInformationMessage = original.showInformationMessage;
        windowAny.showErrorMessage = original.showErrorMessage;
        await fs.rm(dir, { recursive: true, force: true });
    }

    return { sent, listed, pickers, shownLabels, messages };
}

describe('a picked variant entry', () => {
    it('offers what the sidecar found, not the type list', async () => {
        const { listed, pickers, shownLabels } = await runCreate({ args: { recordedNode: true } });

        expect(listed).toContain('wfpy.listRecorded');
        expect(pickers).toEqual(['Which recording?']);
        expect(shownLabels).toEqual(['child', 'other']);
        expect(shownLabels.join('\n')).not.toContain('Create new');
    });

    it('creates the node from the chosen candidate', async () => {
        const { sent } = await runCreate({ args: { recordedNode: true }, choose: 'child' });

        const created = sent.find(r => r.op === 'wfpy.createNode');
        expect(created, 'no node was created').toBeDefined();
        expect(created!.args).toMatchObject({
            workflow: 'Main',
            type: 'child',
            name: 'child',
            params: { instance: 'wf-out/r2' },
            importFrom: 'flows.child'
        });
        // No type is written: the candidate names one that exists.
        expect(sent.some(r => r.op === 'wfpy.createWorkflowType')).toBe(false);
    });

    it('creates nothing when the choice is dismissed', async () => {
        const { sent } = await runCreate({ args: { recordedNode: true } });

        expect(sent).toEqual([]);
    });

    it('says so when there is nothing to pick, instead of an empty list', async () => {
        const { sent, pickers, messages } = await runCreate({ args: { recordedNode: true }, candidates: [] });

        expect(messages).toEqual(['Nothing recorded yet.']);
        expect(pickers).toEqual([]);
        expect(sent).toEqual([]);
    });

    it('ignores a malformed candidate rather than offering it', async () => {
        const { shownLabels } = await runCreate({
            args: { recordedNode: true },
            candidates: [{ label: 'broken' }, CANDIDATES[1]]
        });

        expect(shownLabels).toEqual(['other']);
    });
});

describe('a picked variant entry, created by an agent', () => {
    it('takes the type and value it is given, with the candidate’s extra arguments', async () => {
        const { sent, pickers } = await runCreate({
            args: { recordedNode: true, headless: true, type: 'child', instance: 'wf-out/r2', name: 'c' }
        });

        expect(pickers).toEqual([]);
        const created = sent.find(r => r.op === 'wfpy.createNode');
        expect(created!.args).toMatchObject({
            type: 'child',
            name: 'c',
            params: { instance: 'wf-out/r2' },
            importFrom: 'flows.child'
        });
    });

    it('is told the candidates when it names none', async () => {
        const { sent, messages } = await runCreate({ args: { recordedNode: true, headless: true } });

        expect(sent).toEqual([]);
        expect(messages.join('\n')).toContain('child (instance=wf-out/r2)');
    });
});
