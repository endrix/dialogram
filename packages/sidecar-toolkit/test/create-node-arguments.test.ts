/**
 * A node is made with what its type cannot be made without.
 *
 * `text = Text()` for a `Text` whose `text` has no default is written, and
 * the workflow then fails as it is planned, the node never drawn. A producer
 * that says what a type takes (`typeParameters`) is asked first:
 *
 *   - each parameter with no default is asked, in order, and sent as the
 *     source text typed (`expressions`); one with a default, or one already
 *     answered, is not asked;
 *   - Escape at one of them makes nothing;
 *   - an agent passes them (`args.expressions`), or is told which it left out;
 *   - a producer that cannot say is asked nothing more.
 *
 * And an instance is never named as the type it is made from: in a Python
 * workflow `av1_refdec = av1_refdec()` hides the workflow it makes.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import type { CreateNodeBehavior, CreateNodeStrings } from '../src/server/sidecar-runtime-config.js';
import { WorkflowDiagramTypes } from '@dialogram/shared';

const STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: kind => (kind === 'workflow' ? 'workflow' : 'task'),
    classNamePlaceholder: () => 'MyTask',
    sidecarDisplayName: 'Workflow sidecar',
    invalidCapabilitiesResponse: 'invalid capabilities',
    missingCapabilities: ops => `missing ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `invalid ${action} ${field}`
};

const BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: false,
    surfaceSidecarListErrors: false
};

const TEXT_PARAMETERS = [
    { name: 'text', type: 'str' },
    { name: 'prefix', type: 'str', defaultValue: "''" },
    { name: 'path', type: 'File' }
];

let dir: string;
let mainPath: string;
const workspaceAny = vscode.workspace as any;
const windowAny = vscode.window as any;
const saved = {
    open: workspaceAny.openTextDocument,
    apply: workspaceAny.applyEdit,
    input: windowAny.showInputBox,
    error: windowAny.showErrorMessage
};

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'create-node-arguments-'));
    mainPath = path.join(dir, 'main.py');
    await fs.writeFile(mainPath, '@workflow()\ndef Main():\n    pass\n');
    workspaceAny.openTextDocument = async () => ({
        uri: { fsPath: mainPath, toString: () => `file://${mainPath}` },
        getText: () => '@workflow()\ndef Main():\n    pass\n'
    });
    workspaceAny.applyEdit = async () => true;
});

afterEach(async () => {
    workspaceAny.openTextDocument = saved.open;
    workspaceAny.applyEdit = saved.apply;
    windowAny.showInputBox = saved.input;
    windowAny.showErrorMessage = saved.error;
    await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Create a `type` node, typing `typed(title, prompt, value)` into each input
 * box; what was asked, what was said, and the createNode sent (if any).
 */
async function create(options: {
    type: string;
    args?: Record<string, unknown>;
    features?: string[];
    parameters?: unknown;
    typed?: (box: { title?: string; prompt?: string; value?: string }) => string | undefined;
}) {
    const asked: Array<{ title?: string; prompt?: string }> = [];
    const said: string[] = [];
    let created: Record<string, unknown> | undefined;
    windowAny.showInputBox = async (box: any) => {
        asked.push({ title: box?.title, prompt: box?.prompt });
        return (options.typed ?? (b => b.value))(box ?? {});
    };
    windowAny.showErrorMessage = async (message: string) => { said.push(message); };

    const handler = new CreateNodeOperationHandler() as any;
    handler.modelState = { root: { args: { sourceUri: `file://${mainPath}`, 'wf:workflowName': 'Main' } } };
    handler.sidecar = {
        settingsNamespace: () => 'wfLang',
        sidecarOp: (op: string) => `wfpy.${op}`,
        hasFeature: async (_uri: string, feature: string) => (options.features ?? ['typeParameters', 'createNodeExpressions']).includes(feature),
        undoLabelSuffix: () => '',
        createNodeStrings: () => STRINGS,
        createNodeBehavior: () => BEHAVIOR,
        createNodeVariants: () => [],
        sendSidecarListDetailed: async (_uri: string, request: any) => request.op === 'wfpy.typeParameters'
            ? { ok: true, response: { status: 'ok', diagnostic: { parameters: options.parameters ?? TEXT_PARAMETERS } } }
            : { ok: false, message: 'not asked here' }
    };
    handler.sendSidecarListDetailed = async () => ({ ok: true, response: { status: 'ok', diagnostic: { names: ['front_options'] } } });
    handler.sendSidecarOpDetailed = async (_uri: string, request: any) => {
        if (request.op === 'wfpy.createNode') {
            created = request.args;
        }
        return { ok: true, response: { status: 'ok' } };
    };

    const command = handler.createCommand({
        kind: 'createNode',
        elementTypeId: WorkflowDiagramTypes.NODE_TASK,
        args: { type: options.type, ...(options.args ?? {}) }
    });
    await command.execute();
    return { asked, said, created };
}

describe('a node of a type with parameters that have no default', () => {
    it('asks each, in order, and is made with what was typed, as written', async () => {
        const { asked, created } = await create({
            type: 'Text',
            typed: box => box.prompt === 'Instance name' ? box.value
                : box.prompt?.startsWith("'text'") ? 'FRONT_OPTIONS'
                    : box.prompt?.startsWith("'path'") ? 'File(path=TESTBENCH)' : undefined
        });

        expect(asked.map(box => box.prompt)).toEqual([
            'Instance name',
            "'text' (str) has no default: the expression to give it",
            "'path' (File) has no default: the expression to give it"
        ]);
        expect(asked[1].title).toBe('text = Text(…) (1/2)');
        expect(created).toMatchObject({
            workflow: 'Main', type: 'Text', name: 'text',
            expressions: { text: 'FRONT_OPTIONS', path: 'File(path=TESTBENCH)' }
        });
    });

    it('makes nothing when one of them is escaped', async () => {
        const { created } = await create({
            type: 'Text',
            typed: box => box.prompt === 'Instance name' ? box.value : undefined
        });
        expect(created).toBeUndefined();
    });

    it('takes them from an agent, or tells it which it left out', async () => {
        const given = await create({ type: 'Text', args: { headless: true, expressions: { text: '"x"', path: 'P' } } });
        expect(given.asked).toEqual([]);
        expect(given.created).toMatchObject({ name: 'text', expressions: { text: '"x"', path: 'P' } });

        // One with a default is passed on too.
        const more = await create({ type: 'Text', args: { headless: true, expressions: { text: '"x"', path: 'P', prefix: '">"' } } });
        expect(more.created).toMatchObject({ expressions: { text: '"x"', path: 'P', prefix: '">"' } });

        const short = await create({ type: 'Text', args: { headless: true, expressions: { text: '"x"' } } });
        expect(short.created).toBeUndefined();
        expect(short.said).toEqual([
            `Workflow sidecar: 'Text' has to be given 'path': pass args.expressions {"path": "<expression>"}.`
        ]);
    });

    it('asks nothing more of a producer that cannot say what a type takes', async () => {
        const { asked, created } = await create({ type: 'Text', features: [] });
        expect(asked.map(box => box.prompt)).toEqual(['Instance name']);
        expect(created).toMatchObject({ type: 'Text', name: 'text' });
        expect(created).not.toHaveProperty('expressions');
    });
});

describe('an instance', () => {
    it('is not named, by default, as the type it is made from', async () => {
        const { created } = await create({ type: 'av1_refdec', parameters: [] });
        expect(created).toMatchObject({ type: 'av1_refdec', name: 'av1_refdec2' });
    });

    it('named so is refused, and nothing is made', async () => {
        const { created, said } = await create({
            type: 'av1_refdec',
            parameters: [],
            typed: box => box.prompt === 'Instance name' ? 'av1_refdec' : undefined
        });
        expect(created).toBeUndefined();
        expect(said).toEqual(["An instance named 'av1_refdec' would hide the 'av1_refdec' it is made from: choose another name."]);
    });

    it('named so by an agent is refused with what to pass instead', async () => {
        const { created, said } = await create({ type: 'av1_refdec', parameters: [], args: { headless: true, name: 'av1_refdec' } });
        expect(created).toBeUndefined();
        expect(said).toEqual(["Workflow sidecar: an instance named 'av1_refdec' would hide the 'av1_refdec' it is made from — pass another args.name."]);
    });
});
