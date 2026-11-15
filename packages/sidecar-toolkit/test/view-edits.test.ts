/**
 * What a read-only view lets the reader make and delete besides drawing its
 * transitions (view-edits.ts).
 *
 * A state placed with the palette's State, in a view that allows it, is
 * held by the editor with the view's layout, where it was placed, until a
 * transition from or to it is written: drawing one names it to the
 * producer as new (`newStates`). Delete lets go of it. An entry the
 * producer declared (`VIEW_CREATES`) asks what it asks and has the producer
 * write it (`viewCreate`); an element the producer marked deletable is
 * taken out by it (`viewDelete`), and a state of that name the editor held
 * is let go with it. Each is undone on the platform's command stack, and
 * one that changed nothing leaves no entry on it.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowCommandStack } from '@dialogram/diagram-server/server/command-stack';
import { VIEW_CREATE_ELEMENT_TYPE, WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { CreateStateOperationHandler, ViewCreateOperationHandler, freshStateName } from '../src/server/operations/view-edits';
import { CreateTransitionOperationHandler } from '../src/server/operations/transition-edits';
import { DeleteElementOperationHandler } from '../src/server/operations/delete-handler.js';

type Sent = { uri: string; op: string; args: Record<string, unknown> };

const COUNTER = 'class Counter: ...\n';
const VIEW = 'Counter@actor';

const PORT_IN = {
    id: 'port.in',
    label: 'Input Port',
    group: 'Ports',
    asks: [{ key: 'name', prompt: 'Name of the input port' }, { key: 'type', prompt: 'Its tokens\' type', value: 'Int(32)' }]
};

function sourceFile(): string {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'view-edits-')), 'counter.py');
    writeFileSync(file, COUNTER);
    return pathToFileURL(file).href;
}

/**
 * A view of `Counter`'s automaton, `idle` and `run` written, `waiting` held
 * by the editor when `held`; `done` written and marked deletable, and the
 * input port `In` marked deletable.
 */
function modelState(options: { sourceUri: string; edits?: string[]; held?: boolean; creates?: unknown[] }) {
    const state = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
        id,
        type: WorkflowDiagramTypes.NODE_STATE,
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: id, [WorkflowDiagramMetadata.STATE_NAME]: name, ...extra }
    });
    const elements = new Map<string, any>([
        ['idle', state('idle', 'idle')],
        ['run', state('run', 'run')],
        ['done', state('done', 'done', { [WorkflowDiagramMetadata.VIEW_DELETABLE]: true, [WorkflowDiagramMetadata.GRAPH_NODE_ID]: 'state:done' })],
        ['in', {
            id: 'in',
            type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
            args: { [WorkflowDiagramMetadata.VIEW_DELETABLE]: true, [WorkflowDiagramMetadata.GRAPH_NODE_ID]: 'wf:in:In' }
        }]
    ]);
    if (options.held) {
        elements.set('unwritten-state:waiting', state('unwritten-state:waiting', 'waiting', { [WorkflowDiagramMetadata.STATE_UNWRITTEN]: true }));
    }
    const file = vscode.Uri.parse(options.sourceUri).fsPath;
    return {
        root: {
            args: {
                sourceUri: options.sourceUri,
                'wf:workflowName': 'Counter',
                [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true,
                [WorkflowDiagramMetadata.VIEW_EDITS]: options.edits ?? ['state', 'transition'],
                [WorkflowDiagramMetadata.TRANSITION_LABELS]: [{ id: 'step', label: 'step' }],
                [WorkflowDiagramMetadata.VIEW_REQUEST]: { networkName: 'Counter', view: 'actor' },
                ...(options.creates ? { [WorkflowDiagramMetadata.VIEW_CREATES]: options.creates } : {})
            },
            children: [...elements.values()]
        },
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) },
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: options.sourceUri, layoutTarget: { filePath: file, networkId: VIEW } } : undefined)
    };
}

function invoker(sent: Sent[], answer: { ok: boolean; message?: string } = { ok: true }, write?: () => void): any {
    return {
        sidecarOp: (op: string) => `calpy.${op}`,
        undoLabelSuffix: () => '',
        sendSidecarOpDetailed: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push({ uri, ...payload });
            if (answer.ok) {
                write?.();
            }
            return answer;
        }
    };
}

/** The platform's command stack, which logs what fails (it is injected a logger in the server). */
function commandStack(): WorkflowCommandStack {
    const stack = new WorkflowCommandStack();
    (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
    return stack;
}

/** Run `body` with the window's input boxes answered by `answers`, in turn, and what it was told and asked kept. */
async function withWindow<T>(answers: Array<string | undefined>, body: (said: string[], asked: any[]) => Promise<T>): Promise<T> {
    const window = vscode.window as any;
    const saved = { input: window.showInputBox, info: window.showInformationMessage, warn: window.showWarningMessage };
    const said: string[] = [];
    const asked: any[] = [];
    window.showInputBox = async (options: any) => {
        asked.push(options);
        const answer = answers.shift();
        return answer === '' ? options.value : answer;
    };
    window.showInformationMessage = async (message: string) => { said.push(message); };
    window.showWarningMessage = async (message: string) => { said.push(message); };
    try {
        return await body(said, asked);
    } finally {
        window.showInputBox = saved.input;
        window.showInformationMessage = saved.info;
        window.showWarningMessage = saved.warn;
    }
}

/** Run `body` with the editor's document of `file` what is on disk, and an edit applied to it written there. */
async function onDisk<T>(file: string, body: () => Promise<T>): Promise<T> {
    const workspace = vscode.workspace as any;
    const proto = (vscode.WorkspaceEdit as any).prototype;
    const saved = { open: workspace.openTextDocument, apply: workspace.applyEdit, set: proto.set };
    const pending: string[] = [];
    proto.set = function (_uri: unknown, edits: Array<{ newText: string }>) { pending.push(...edits.map(edit => edit.newText)); };
    workspace.openTextDocument = async () => ({
        getText: () => readFileSync(file, 'utf8'), isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true
    });
    workspace.applyEdit = async () => {
        const text = pending.pop();
        if (text) {
            writeFileSync(file, text);
        }
        return true;
    };
    try {
        return await body();
    } finally {
        proto.set = saved.set;
        workspace.openTextDocument = saved.open;
        workspace.applyEdit = saved.apply;
    }
}

/** The layout's store, saving at once, and a storage that counts how often the view is drawn again. */
function holding() {
    const layoutPersistence = new LayoutPersistenceService(0);
    const storage = { rebuilt: 0, rebuildFromLastDocument: async () => { storage.rebuilt++; return true; } };
    return { layoutPersistence, storage };
}

function wire(handler: any, state: any, sent: Sent[], kept: ReturnType<typeof holding>, answer?: { ok: boolean; message?: string }) {
    const file = vscode.Uri.parse(state.root.args.sourceUri).fsPath;
    handler.modelState = state;
    handler.sidecar = invoker(sent, answer, () => writeFileSync(file, readFileSync(file, 'utf8') + `# ${sent[sent.length - 1].op}\n`));
    handler.layoutPersistence = kept.layoutPersistence;
    handler.sourceModelStorage = kept.storage;
    return handler;
}

const heldIn = async (kept: ReturnType<typeof holding>, state: any) =>
    Object.fromEntries(await kept.layoutPersistence.loadUnwrittenStates(vscode.Uri.parse(state.root.args.sourceUri).fsPath, VIEW));

describe('a state placed with the palette\'s State', () => {
    it('is held by the editor with the view\'s layout, where it was placed, under the name given; undone and redone', async () => {
        const state = modelState({ sourceUri: sourceFile() });
        const kept = holding();
        const handler = wire(new CreateStateOperationHandler(), state, [], kept);
        const stack = commandStack();
        await withWindow(['waiting'], async (_said, asked) => {
            await stack.execute(handler.createCommand({ kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_STATE, location: { x: 120, y: 40 } }));
            expect(asked[0].value).toBe('state_1');
            expect(asked[0].validateInput('idle')).toBe('There is a state idle already.');
            expect(asked[0].validateInput(' ')).toBe('A state needs a name.');
            expect(asked[0].validateInput('waiting')).toBeUndefined();
        });
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 120, y: 40 } });
        expect(kept.storage.rebuilt).toBe(1);
        await stack.undo();
        expect(await heldIn(kept, state)).toEqual({});
        await stack.redo();
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 120, y: 40 } });
        expect(kept.storage.rebuilt).toBe(3);
    });

    it('named as a state already is, or with no name given, is not held', async () => {
        const state = modelState({ sourceUri: sourceFile() });
        const kept = holding();
        const handler = wire(new CreateStateOperationHandler(), state, [], kept);
        await withWindow([undefined], async said => {
            await commandStack().execute(handler.createCommand({ kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_STATE }));
            await commandStack().execute(handler.createCommand({ kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_STATE, args: { name: 'run', headless: true } }));
            expect(said).toEqual(['There is a state run already.']);
        });
        expect(await heldIn(kept, state)).toEqual({});
        expect(kept.storage.rebuilt).toBe(0);
    });

    it('is not placed in a view that allows no state to be', () => {
        const handler = wire(new CreateStateOperationHandler(), modelState({ sourceUri: sourceFile(), edits: ['transition'] }), [], holding());
        expect(handler.createCommand({ kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_STATE })).toBeUndefined();
    });

    it('takes the first name of its kind that no state has', () => {
        expect(freshStateName(new Set(['idle', 'state_1', 'state_3']))).toBe('state_2');
    });

    it('is named to the producer as new when a transition is drawn to it', async () => {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        const handler = wire(new CreateTransitionOperationHandler(), modelState({ sourceUri, held: true }), sent, holding());
        const command = handler.createCommand({
            kind: 'createEdge', elementTypeId: WorkflowDiagramTypes.EDGE_TRANSITION, sourceElementId: 'idle', targetElementId: 'unwritten-state:waiting'
        });
        await onDisk(vscode.Uri.parse(sourceUri).fsPath, () => command.options.computeEdits());
        expect(sent.map(each => each.args)).toEqual([{
            network: 'Counter', view: 'actor', document: vscode.Uri.parse(sourceUri).fsPath, from: 'idle', to: 'waiting', label: 'step', newStates: ['waiting']
        }]);
    });
});

describe('deleting in a read-only view', () => {
    async function remove(ids: string[], options: { held?: Record<string, { x: number; y: number }>; answer?: { ok: boolean; message?: string } } = {}) {
        const state = modelState({ sourceUri: sourceFile(), held: true });
        const file = vscode.Uri.parse(state.root.args.sourceUri).fsPath;
        const kept = holding();
        await kept.layoutPersistence.saveUnwrittenStates(file, VIEW, new Map(Object.entries(options.held ?? { waiting: { x: 5, y: 6 } })));
        const sent: Sent[] = [];
        const handler = wire(new DeleteElementOperationHandler(), state, sent, kept, options.answer);
        const command = handler.createCommand({ kind: 'deleteElement', elementIds: ids });
        const stack = commandStack();
        let said: string[] = [];
        if (command) {
            await onDisk(file, () => withWindow([], async told => {
                said = told;
                await stack.execute(command);
            }));
        }
        return {
            command, sent, kept, state, said, stack,
            text: () => readFileSync(file, 'utf8'),
            undo: () => onDisk(file, () => stack.undo())
        };
    }

    it('lets go of a state the editor holds, and the undo holds it again', async () => {
        const { command, sent, kept, state, undo } = await remove(['unwritten-state:waiting']);
        expect(command).toBeDefined();
        expect(sent).toEqual([]);
        expect(await heldIn(kept, state)).toEqual({});
        await undo();
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 5, y: 6 } });
    });

    it('has the producer take out what it marked deletable, by its id, and lets go of a state of that name the editor held', async () => {
        const { sent, kept, state, text, undo } = await remove(['done', 'in', 'idle'], { held: { waiting: { x: 5, y: 6 }, done: { x: 1, y: 2 } } });
        expect(sent.map(each => [each.op, each.args.element])).toEqual([['calpy.viewDelete', 'state:done'], ['calpy.viewDelete', 'wf:in:In']]);
        expect(sent[0].args).toMatchObject({ network: 'Counter', view: 'actor', document: vscode.Uri.parse(state.root.args.sourceUri).fsPath });
        expect(text()).toBe(COUNTER + '# calpy.viewDelete\n# calpy.viewDelete\n');
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 5, y: 6 } });
        await undo();
        expect(text()).toBe(COUNTER);
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 5, y: 6 }, done: { x: 1, y: 2 } });
    });

    it('keeps what the producer refuses to take out, and says why', async () => {
        const { text, said } = await remove(['in'], { answer: { ok: false, message: 'In is read by step' } });
        expect(text()).toBe(COUNTER);
        expect(said).toEqual(['In is read by step']);
    });

    it('keeps a state the producer refuses to take out, and what the editor held of it, and leaves Undo as it was', async () => {
        const { text, said, kept, state, stack } = await remove(['done'], {
            held: { waiting: { x: 5, y: 6 }, done: { x: 1, y: 2 } },
            answer: { ok: false, message: "'done' is the initial state" }
        });
        expect(text()).toBe(COUNTER);
        expect(said).toEqual(["'done' is the initial state"]);
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 5, y: 6 }, done: { x: 1, y: 2 } });
        expect(stack.canUndo()).toBe(false);
    });

    it('refused for a written state and not for a held one, lets the held one go, and the undo holds it again', async () => {
        const { text, kept, state, stack, undo } = await remove(['unwritten-state:waiting', 'done'], { answer: { ok: false, message: 'no' } });
        expect(text()).toBe(COUNTER);
        expect(await heldIn(kept, state)).toEqual({});
        expect(stack.canUndo()).toBe(true);
        await undo();
        expect(await heldIn(kept, state)).toEqual({ waiting: { x: 5, y: 6 } });
    });
});

describe('an entry the producer declared', () => {
    function create(answers: Array<string | undefined>, args: Record<string, unknown> = {}) {
        const sourceUri = sourceFile();
        const sent: Sent[] = [];
        const state = modelState({ sourceUri, creates: [PORT_IN] });
        const handler = wire(new ViewCreateOperationHandler(), state, sent, holding());
        return withWindow(answers, async (said, asked) => {
            const command = handler.createCommand({ kind: 'createNode', elementTypeId: VIEW_CREATE_ELEMENT_TYPE, args: { create: 'port.in', ...args } });
            const edits = command ? await onDisk(vscode.Uri.parse(sourceUri).fsPath, () => command.options.computeEdits()) : undefined;
            return { command, edits, sent, said, asked, sourceUri };
        });
    }

    it('asks what it asks, in order, and has the producer write it, naming the view', async () => {
        const { edits, sent, asked, sourceUri } = await create(['IN2', '']);
        expect(asked.map(each => [each.prompt, each.value])).toEqual([['Name of the input port', undefined], ['Its tokens\' type', 'Int(32)']]);
        expect(edits).toHaveLength(1);
        expect(sent).toEqual([{
            uri: sourceUri,
            op: 'calpy.viewCreate',
            args: { network: 'Counter', view: 'actor', document: vscode.Uri.parse(sourceUri).fsPath, create: 'port.in', name: 'IN2', type: 'Int(32)' }
        }]);
    });

    it('takes an agent\'s answers from the operation, and asks nothing', async () => {
        const { sent, asked } = await create([], { name: 'IN3', type: 'Int(8)', headless: true });
        expect(asked).toEqual([]);
        expect(sent[0].args).toMatchObject({ create: 'port.in', name: 'IN3', type: 'Int(8)' });
    });

    it('makes nothing when an answer is not given', async () => {
        const { edits, sent } = await create(['IN2', undefined]);
        expect(edits).toBeUndefined();
        expect(sent).toEqual([]);
    });

    it('is not made when the view did not declare it', () => {
        const handler = wire(new ViewCreateOperationHandler(), modelState({ sourceUri: sourceFile() }), [], holding());
        expect(handler.createCommand({ kind: 'createNode', elementTypeId: VIEW_CREATE_ELEMENT_TYPE, args: { create: 'port.in' } })).toBeUndefined();
    });
});
