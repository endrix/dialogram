/**
 * The transitions of an automaton, drawn and deleted in a view that allows
 * it (`VIEW_EDITS`: `transition`).
 *
 * Drawing one from a state to a state asks what takes it, of what the view
 * offers (`TRANSITION_LABELS`), and has the producer write it
 * (`addTransition`); deleting one has it taken out (`removeTransition`).
 * Both name the view as it was asked for (`VIEW_REQUEST`), of the file it
 * was asked of, with the diagram's document. A state with no name in what
 * the automaton is written in, a view that allows no such edit, and a
 * refusal from the producer write nothing; a read-only view deletes nothing
 * else.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, type ViewRequest } from '@dialogram/shared';
import { CreateTransitionOperationHandler } from '../src/server/operations/transition-edits';
import { DeleteElementOperationHandler } from '../src/server/operations/delete-handler.js';
import { commandStack, onDisk } from './edits-on-disk';

type Sent = { uri: string; op: string; args: Record<string, unknown> };

const LABELS = [
    { id: 'step', label: 'step', description: 'In → Out' },
    { id: 'stop', label: 'stop' }
];

const COUNTER = 'class Counter: ...\n';

function sourceFile(): string {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'transition-edits-')), 'counter.py');
    writeFileSync(file, COUNTER);
    return pathToFileURL(file).href;
}

/** A view of `Counter`'s automaton: `idle`, `run`, and `any state`, which has no name. */
function modelState(options: { sourceUri: string; edits?: string[]; request?: ViewRequest; readOnly?: boolean; labels?: typeof LABELS }) {
    const state = (id: string, name?: string) => ({
        id,
        type: WorkflowDiagramTypes.NODE_STATE,
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: id, ...(name !== undefined ? { [WorkflowDiagramMetadata.STATE_NAME]: name } : {}) }
    });
    const elements = new Map<string, any>([
        ['idle', state('idle', 'idle')],
        ['run', state('run', 'run')],
        ['any state', state('any state')],
        ['t:run:step->idle', { id: 't:run:step->idle', type: WorkflowDiagramTypes.EDGE_TRANSITION, args: {} }],
        ['t:*:reset->*', { id: 't:*:reset->*', type: WorkflowDiagramTypes.EDGE_TRANSITION, args: {} }]
    ]);
    return {
        root: {
            args: {
                sourceUri: options.sourceUri,
                'wf:workflowName': 'Counter',
                [WorkflowDiagramMetadata.READ_ONLY_VIEW]: options.readOnly ?? true,
                ...(options.edits ? { [WorkflowDiagramMetadata.VIEW_EDITS]: options.edits } : {}),
                [WorkflowDiagramMetadata.TRANSITION_LABELS]: options.labels ?? LABELS,
                [WorkflowDiagramMetadata.VIEW_REQUEST]: options.request ?? { networkName: 'Counter', view: 'actor' }
            }
        },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) }
    };
}

function invoker(sent: Sent[], answer: { ok: boolean; message?: string } = { ok: true }): any {
    return {
        sidecarOp: (op: string) => `calpy.${op}`,
        undoLabelSuffix: () => '',
        sendSidecarOpDetailed: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push({ uri, ...payload });
            return answer;
        },
        sendSidecarOp: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push({ uri, ...payload });
            return true;
        }
    };
}

/** Run `body` with the window's prompts answered by `pick`, and what it was told kept. */
async function withWindow<T>(pick: (items: any[], options: any) => any, body: (said: string[], asked: any[]) => Promise<T>): Promise<T> {
    const window = vscode.window as any;
    const saved = { pick: window.showQuickPick, info: window.showInformationMessage, warn: window.showWarningMessage };
    const said: string[] = [];
    const asked: any[] = [];
    window.showQuickPick = async (items: any[], options: any) => {
        asked.push({ items, options });
        return pick(items, options);
    };
    window.showInformationMessage = async (message: string) => { said.push(message); };
    window.showWarningMessage = async (message: string) => { said.push(message); };
    try {
        return await body(said, asked);
    } finally {
        window.showQuickPick = saved.pick;
        window.showInformationMessage = saved.info;
        window.showWarningMessage = saved.warn;
    }
}

async function draw(state: any, sent: Sent[], from: string, to: string, args?: Record<string, unknown>, answer?: { ok: boolean; message?: string }) {
    const handler = new CreateTransitionOperationHandler() as any;
    handler.modelState = state;
    handler.sidecar = invoker(sent, answer);
    const command = handler.createCommand({
        kind: 'createEdge', elementTypeId: WorkflowDiagramTypes.EDGE_TRANSITION, sourceElementId: from, targetElementId: to, ...(args ? { args } : {})
    });
    if (!command) {
        return { command };
    }
    return { command, edits: await command.options.computeEdits() };
}

describe('a transition drawn from a state to a state', () => {
    it('asks what takes it, of what the view offers, and has the producer write it, naming the view as it was asked for', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        const { edits } = await withWindow(items => items.find((item: any) => item.id === 'step'), async (_said, asked) => {
            const drawn = await draw(modelState({ sourceUri, edits: ['transition'] }), sent, 'run', 'idle');
            expect(asked[0].items.map((item: any) => [item.label, item.description])).toEqual([['step', 'In → Out'], ['stop', undefined]]);
            expect(asked[0].options.placeHolder).toBe('What takes the transition from run to idle?');
            return drawn;
        });
        expect(edits).toHaveLength(1);
        expect(sent).toEqual([{
            uri: sourceUri,
            op: 'calpy.addTransition',
            args: { network: 'Counter', view: 'actor', document: vscode.Uri.parse(sourceUri).fsPath, from: 'run', to: 'idle', label: 'step' }
        }]);
    });

    it('of an instance, names the root and the path of instances, and asks the file the view was asked of', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        const request: ViewRequest = { networkName: 'Gate', view: 'actor-instance', rootWorkflow: 'top', instancePath: ['gate'], graphSourceUri: 'file:///w/top.py' };
        await withWindow(() => undefined, () => draw(modelState({ sourceUri, edits: ['transition'], request }), sent, 'idle', 'idle', { label: 'stop' }));
        expect(sent).toHaveLength(1);
        expect(sent[0].uri).toBe('file:///w/top.py');
        expect(sent[0].args).toMatchObject({ network: 'Gate', view: 'actor-instance', rootNetwork: 'top', instancePath: ['gate'], label: 'stop' });
    });

    it('takes the label the operation names without asking, and asks nothing of an agent that names none', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        await withWindow(() => { throw new Error('asked'); }, async () => {
            await draw(modelState({ sourceUri, edits: ['transition'] }), sent, 'idle', 'run', { label: 'stop' });
            const { edits } = await draw(modelState({ sourceUri, edits: ['transition'] }), sent, 'idle', 'run', { headless: true });
            expect(edits).toBeUndefined();
        });
        expect(sent.map(each => each.args.label)).toEqual(['stop']);
    });

    it('takes the only label the view offers, for an agent that names none too', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        await withWindow(() => { throw new Error('asked'); }, async () => {
            const state = modelState({ sourceUri, edits: ['transition'], labels: [LABELS[0]] });
            const { edits } = await draw(state, sent, 'idle', 'run', { headless: true });
            expect(edits).toHaveLength(1);
        });
        expect(sent.map(each => each.args.label)).toEqual(['step']);
    });

    it('writes nothing from a state with no name, in a view that allows no such edit, or when the producer refuses', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        await withWindow(items => items[0], async said => {
            expect((await draw(modelState({ sourceUri, edits: ['transition'] }), sent, 'any state', 'idle')).edits).toBeUndefined();
            expect(said[0]).toMatch(/from a state of the automaton to a state of it/);
            expect((await draw(modelState({ sourceUri }), sent, 'idle', 'run')).command).toBeUndefined();
            expect(sent).toEqual([]);
            const refused = await draw(modelState({ sourceUri, edits: ['transition'] }), sent, 'idle', 'run', { label: 'stop' },
                { ok: false, message: 'stop already leads from idle to run' });
            expect(refused.edits).toBeUndefined();
            expect(said).toContain('stop already leads from idle to run');
        });
    });
});

describe('a transition deleted', () => {
    async function remove(state: any, ids: string[]): Promise<Sent[]> {
        const sent: Sent[] = [];
        const handler = new DeleteElementOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = invoker(sent);
        const workspace = vscode.workspace as any;
        const original = workspace.openTextDocument;
        workspace.openTextDocument = async () => ({ getText: () => 'class Counter: ...\n' });
        try {
            const command = handler.createCommand({ kind: 'deleteElement', elementIds: ids });
            await command?.options.computeEdits();
        } finally {
            workspace.openTextDocument = original;
        }
        return sent;
    }

    it('is taken out by the producer, by its id, in a view that allows it', async () => {
        const sourceUri = sourceFile();
        const sent = await remove(modelState({ sourceUri, edits: ['transition'] }), ['t:run:step->idle']);
        expect(sent).toEqual([{
            uri: sourceUri,
            op: 'calpy.removeTransition',
            args: { network: 'Counter', view: 'actor', document: vscode.Uri.parse(sourceUri).fsPath, transition: 't:run:step->idle' }
        }]);
    });

    /**
     * Delete `ids` as the editor does, on the platform's command stack (`stack`,
     * a new one if none), the document what is on disk and an edit applied
     * written to it; the command, and what the producer was sent.
     */
    async function execute(state: any, ids: string[], answer: (transition: string) => boolean, stack = commandStack()) {
        const file = vscode.Uri.parse(state.root.args.sourceUri).fsPath;
        const sent: Sent[] = [];
        const handler = new DeleteElementOperationHandler() as any;
        handler.modelState = state;
        handler.sidecar = {
            ...invoker(sent),
            sendSidecarOpDetailed: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
                sent.push({ uri, ...payload });
                const transition = String(payload.args.transition);
                if (!answer(transition)) {
                    return { ok: false, message: `${transition} is not taken out` };
                }
                writeFileSync(file, readFileSync(file, 'utf8') + `# without ${transition}\n`);
                return { ok: true };
            }
        };
        const command = handler.createCommand({ kind: 'deleteElement', elementIds: ids });
        if (command) {
            // As GLSP's operation handler does with what it is given.
            await onDisk(file, () => withWindow(() => undefined, () => stack.execute(command)));
        }
        return { command, sent, text: readFileSync(file, 'utf8'), undo: () => onDisk(file, () => stack.undo()), stack };
    }

    it('selected with one the producer refuses, goes all the same, whichever comes first, and can be undone', async () => {
        for (const ids of [['t:run:step->idle', 't:*:reset->*'], ['t:*:reset->*', 't:run:step->idle']]) {
            const { command, sent, text } = await execute(modelState({ sourceUri: sourceFile(), edits: ['transition'] }), ids, id => id !== 't:*:reset->*');
            expect(sent.map(each => each.args.transition)).toEqual(ids);
            expect(text).toBe(COUNTER + '# without t:run:step->idle\n');
            expect(command.canUndo()).toBe(true);
        }
    });

    it('refused alone, writes nothing and cannot be undone, and leaves Undo to the delete before it', async () => {
        const state = modelState({ sourceUri: sourceFile(), edits: ['transition'] });
        const first = await execute(state, ['t:run:step->idle'], () => true);
        const refused = await execute(state, ['t:*:reset->*'], () => false, first.stack);
        expect(refused.text).toBe(first.text);
        expect(refused.command!.canUndo()).toBe(false);
        expect(first.stack.canUndo()).toBe(true);
        await first.undo();
        expect(readFileSync(vscode.Uri.parse(state.root.args.sourceUri).fsPath, 'utf8')).toBe(COUNTER);
    });

    it('is kept in a view that does not, and a read-only view deletes nothing else, not a state: no command, the undo below untouched', async () => {
        const sourceUri = sourceFile();
        const editable = modelState({ sourceUri, edits: ['transition'] });
        const first = await execute(editable, ['t:run:step->idle'], () => true);
        expect(first.text).not.toBe(COUNTER);
        for (const [state, ids] of [[modelState({ sourceUri }), ['t:run:step->idle', 'idle']], [editable, ['idle']]] as const) {
            const kept = await execute(state, [...ids], () => true, first.stack);
            expect(kept.command).toBeUndefined();
            expect(kept.sent).toEqual([]);
        }
        expect(first.stack.canUndo()).toBe(true);
        await first.undo();
        expect(readFileSync(vscode.Uri.parse(sourceUri).fsPath, 'utf8')).toBe(COUNTER);
    });
});
