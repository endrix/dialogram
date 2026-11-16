/**
 * An instance's ports are its class's, edited where the class is declared:
 * in its own file, which is often not the diagram's. A rename or a delete
 * there is told where this diagram uses the class (`usedIn`), when the
 * sidecar follows it (`features.portUsesAcrossFiles`), and its undo puts
 * back every file the producer wrote; a sidecar that does not follow it is
 * not sent such an edit. A refusal says why and leaves nothing to undo.
 * A network's own port is wired from the node it is drawn as.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { UpdateEntityPortOperationHandler } from '../src/server/operations/update-entity-port-handler.js';
import { createEntityPortCrudHandlers } from '../src/server/operations/entity-port-crud-handler.js';
import { RenameEntityOperationHandler } from '../src/server/operations/rename-entity-handler.js';
import { CreateEdgeOperationHandler } from '../src/server/operations/create-edge-handler.js';
import { commandStack, saying } from './edits-on-disk';

const NET = 'net = ...\n';
const ACTORS = 'class Pass: ...\n';

/** A network `net` with an instance `a` of `Pass`, declared in a file of its own, and a network input `x`. */
function design() {
    const dir = mkdtempSync(path.join(tmpdir(), 'entity-port-edits-'));
    const net = path.join(dir, 'net.py');
    const actors = path.join(dir, 'actors.py');
    writeFileSync(net, NET);
    writeFileSync(actors, ACTORS);
    const port = { id: 'a_in', type: WorkflowDiagramTypes.PORT_INPUT, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'In' } } as any;
    const a = {
        id: 'a', type: WorkflowDiagramTypes.NODE_ACTOR, children: [port],
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: 'a', [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Pass',
            [WorkflowDiagramMetadata.REFERENCED_URI]: pathToFileURL(actors).href, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true
        }
    } as any;
    port.parent = a;
    const xPort = { id: 'x_p', type: WorkflowDiagramTypes.PORT_OUTPUT, args: { [WorkflowDiagramMetadata.PORT_NAME]: 'x' } } as any;
    const x = { id: 'x', type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, children: [xPort], args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'x', [WorkflowDiagramMetadata.PORT_NAME]: 'x' } } as any;
    xPort.parent = x;
    const root = { args: { sourceUri: pathToFileURL(net).href, [WorkflowDiagramMetadata.WORKFLOW_NAME]: 'net' }, children: [a, x] } as any;
    a.parent = root;
    x.parent = root;
    const elements = new Map<string, any>([['a', a], ['a_in', port], ['x', x], ['x_p', xPort]]);
    const modelState = {
        root, sourceUri: root.args.sourceUri,
        index: { get: (id: string) => elements.get(id), find: (id: string) => elements.get(id) }
    };
    return { net, actors, modelState };
}

type Sent = { file: string; op: string; args: Record<string, unknown> };

/**
 * The producer: each op written into the file it is sent for, and into the
 * diagram's file too when it is told the class is used there; refused when
 * `refuse` says why. It follows `usedIn` when `follows`.
 */
function producer(net: string, sent: Sent[], follows: boolean, refuse?: string) {
    return {
        sidecarOp: (op: string) => `calpy.${op}`,
        undoLabelSuffix: () => '',
        hasFeature: async (_uri: string, feature: string) => follows && feature === 'portUsesAcrossFiles',
        operationKindCreateEntityPort: () => 'createEntityPort',
        operationKindDeleteEntityPort: () => 'deleteEntityPort',
        sendSidecarOpDetailed: async (uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            const file = vscode.Uri.parse(uri).fsPath;
            sent.push({ file: path.basename(file), ...payload });
            if (refuse) {
                return { ok: false, failure: 'rejected', message: refuse };
            }
            writeFileSync(file, readFileSync(file, 'utf8') + `# ${payload.op}\n`);
            if (Array.isArray(payload.args['usedIn']) && payload.args['usedIn'].length > 0 && file !== net) {
                writeFileSync(net, readFileSync(net, 'utf8') + `# ${payload.op} followed\n`);
            }
            return { ok: true };
        }
    };
}

/** Run `body` with each file's document what is on disk, and the edits applied to them written there. */
async function onDisk<T>(body: () => Promise<T>): Promise<T> {
    const workspace = vscode.workspace as any;
    const proto = (vscode.WorkspaceEdit as any).prototype;
    const saved = { open: workspace.openTextDocument, apply: workspace.applyEdit, set: proto.set };
    const pending: Array<{ file: string; text: string }> = [];
    proto.set = function (uri: vscode.Uri, edits: Array<{ newText: string }>) {
        pending.push(...edits.map(edit => ({ file: uri.fsPath, text: edit.newText })));
    };
    workspace.openTextDocument = async (uri: vscode.Uri) => ({
        getText: () => readFileSync(uri.fsPath, 'utf8'), isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true
    });
    workspace.applyEdit = async () => {
        for (const { file, text } of pending.splice(0)) {
            if (text) {
                writeFileSync(file, text);
            }
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

function updatePort(state: any, sidecar: any, field: 'name' | 'type', newValue: string) {
    const handler = new UpdateEntityPortOperationHandler() as any;
    handler.modelState = state;
    handler.sidecar = sidecar;
    return handler.createCommand({
        kind: 'dialogram.updateEntityPort', entityType: 'Pass', portDirection: 'input', portName: 'In', portElementId: 'a_in', field, newValue
    });
}

describe('an edit of an instance\'s port', () => {
    it('renames it in its class\'s file, the connections here following, and undoes both files', async () => {
        const { net, actors, modelState } = design();
        const sent: Sent[] = [];
        const stack = commandStack();
        await onDisk(() => stack.execute(updatePort(modelState, producer(net, sent, true), 'name', 'Feed')));
        expect(sent).toEqual([{
            file: 'actors.py', op: 'calpy.renamePort',
            args: { entity: 'Pass', portDirection: 'input', portName: 'In', newValue: 'Feed', usedIn: [{ file: net, workflow: 'net', instances: ['a'] }] }
        }]);
        expect(readFileSync(actors, 'utf8')).toBe(ACTORS + '# calpy.renamePort\n');
        expect(readFileSync(net, 'utf8')).toBe(NET + '# calpy.renamePort followed\n');
        expect(stack.canUndo()).toBe(true);
        await onDisk(() => stack.undo());
        expect(readFileSync(actors, 'utf8')).toBe(ACTORS);
        expect(readFileSync(net, 'utf8')).toBe(NET);
    });

    it('is not renamed in another file by a sidecar that does not follow it, which is said', async () => {
        const { net, actors, modelState } = design();
        const sent: Sent[] = [];
        const stack = commandStack();
        const said = await saying(async said => {
            await onDisk(() => stack.execute(updatePort(modelState, producer(net, sent, false), 'name', 'Feed')));
            return said;
        });
        expect(sent).toEqual([]);
        expect(said).toEqual(["Port 'In' of 'Pass' is declared in actors.py, and its connections here would not follow it: edit it there."]);
        expect(readFileSync(actors, 'utf8')).toBe(ACTORS);
        expect(stack.canUndo()).toBe(false);
    });

    it('is retyped in its class\'s file by any sidecar: the connections here do not name its type', async () => {
        const { net, modelState } = design();
        const sent: Sent[] = [];
        await onDisk(() => commandStack().execute(updatePort(modelState, producer(net, sent, false), 'type', 'Int(16)')));
        expect(sent).toEqual([{
            file: 'actors.py', op: 'calpy.updatePortType',
            args: { entity: 'Pass', portDirection: 'input', portName: 'In', newValue: 'Int(16)' }
        }]);
    });

    it('refused, says why, writes nothing and leaves nothing to undo', async () => {
        const { net, actors, modelState } = design();
        const stack = commandStack();
        const said = await saying(async said => {
            await onDisk(() => stack.execute(updatePort(modelState, producer(net, [], true, "'Pass' has a port 'Feed' already"), 'name', 'Feed')));
            return said;
        });
        expect(said).toEqual(["'Pass' has a port 'Feed' already"]);
        expect(readFileSync(actors, 'utf8')).toBe(ACTORS);
        expect(readFileSync(net, 'utf8')).toBe(NET);
        expect(stack.canUndo()).toBe(false);
    });

    it('is added in its class\'s file, and deleted there told where it is used', async () => {
        const { net, modelState } = design();
        const [Create, Delete] = createEntityPortCrudHandlers({ createEntityPort: 'createEntityPort', deleteEntityPort: 'deleteEntityPort' });
        const sent: Sent[] = [];
        for (const [Handler, action] of [
            [Create, { kind: 'createEntityPort', elementId: 'a', entityType: 'Pass', portDirection: 'output', portName: 'Dbg', portType: 'Int(1)' }],
            [Delete, { kind: 'deleteEntityPort', elementId: 'a', entityType: 'Pass', portDirection: 'input', portName: 'In' }]
        ] as const) {
            const handler = new (Handler as any)();
            handler.modelState = modelState;
            handler.sidecar = producer(net, sent, true);
            await onDisk(() => commandStack().execute(handler.createCommand(action)));
        }
        expect(sent.map(each => [each.file, each.op, each.args['usedIn']])).toEqual([
            ['actors.py', 'calpy.createEntityPort', undefined],
            ['actors.py', 'calpy.deleteEntityPort', [{ file: net, workflow: 'net', instances: ['a'] }]]
        ]);
    });
});

describe('a rename', () => {
    it('refused, says why and leaves nothing to undo; written, is undone', async () => {
        const { net, modelState } = design();
        for (const refuse of ["network 'net' has a 'b' already", undefined]) {
            const handler = new RenameEntityOperationHandler() as any;
            handler.modelState = modelState;
            handler.sidecar = producer(net, [], true, refuse);
            handler.layoutPersistence = { renameNode: async () => undefined };
            const stack = commandStack();
            const said = await saying(async said => {
                await onDisk(() => stack.execute(handler.createCommand({ kind: 'dialogram.renameEntity', elementId: 'a', newName: 'b' })));
                return said;
            });
            expect(said).toEqual(refuse ? [refuse] : []);
            expect(stack.canUndo()).toBe(!refuse);
            await onDisk(() => stack.undo());
            expect(readFileSync(net, 'utf8')).toBe(NET);
        }
    });
});

describe('a rename\'s layout', () => {
    it('follows the name forward, back on undo, forward again on redo, each command its own', async () => {
        const { net, modelState } = design();
        const moved: string[] = [];
        const handler = new RenameEntityOperationHandler() as any;
        handler.modelState = modelState;
        handler.sidecar = producer(net, [], true);
        handler.layoutPersistence = { renameNode: async (_file: string, _net: string, from: string, to: string) => { moved.push(`${from}>${to}`); } };
        const stack = commandStack();
        await onDisk(() => stack.execute(handler.createCommand({ kind: 'dialogram.renameEntity', elementId: 'a', newName: 'b' })));
        await onDisk(() => stack.execute(handler.createCommand({ kind: 'dialogram.renameEntity', elementId: 'x', newName: 'y' })));
        await onDisk(() => stack.undo());
        await onDisk(() => stack.undo());
        await onDisk(() => stack.redo());
        expect(moved).toEqual(['a>b', 'x>y', 'y>x', 'b>a', 'a>b']);
    });
});

describe('a file that cannot be read', () => {
    it('is not asked to be written: it could not be put back', async () => {
        const { net, actors, modelState } = design();
        rmSync(actors);
        mkdirSync(actors); // read as a file, it fails
        const sent: Sent[] = [];
        const stack = commandStack();
        const said = await saying(async said => {
            await onDisk(() => stack.execute(updatePort(modelState, producer(net, sent, true), 'type', 'Int(16)')));
            return said;
        });
        expect(sent).toEqual([]);
        expect(said).toEqual([`${actors} cannot be read: nothing was changed.`]);
        expect(stack.canUndo()).toBe(false);
    });
});

describe('a network\'s own port', () => {
    it('is wired from the node it is drawn as', async () => {
        const { modelState } = design();
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const handler = new CreateEdgeOperationHandler() as any;
        handler.modelState = modelState;
        handler.sidecar = { sidecarOp: (op: string) => `calpy.${op}`, undoLabelSuffix: () => '', edgeRoles: async () => undefined };
        handler.sendSidecarOp = async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            return true;
        };
        await onDisk(async () => handler.createCommand({
            kind: 'createEdge', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, sourceElementId: 'x', targetElementId: 'a_in'
        })?.execute());
        expect(sent).toEqual([{
            op: 'calpy.connect',
            args: { workflow: 'net', from_port: { type: 'workflow', name: 'x' }, to_port: { type: 'actor', actor: 'a', port: 'In' } }
        }]);
    });
});

describe('what an edit reads and where', () => {
    it('reads each file as it is on disk: undo of a second edit made before the editor caught up keeps the first', async () => {
        const { net, actors, modelState } = design();
        const stack = commandStack();
        await onDisk(() => stack.execute(updatePort(modelState, producer(net, [], true), 'name', 'Feed')));
        const first = readFileSync(actors, 'utf8');
        // The editor's buffer still holds the file as it was before the first.
        const workspace = vscode.workspace as any;
        await onDisk(async () => {
            workspace.openTextDocument = async () => ({ getText: () => ACTORS, isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true });
            await stack.execute(updatePort(modelState, producer(net, [], true), 'type', 'Int(16)'));
        });
        expect(readFileSync(actors, 'utf8')).toBe(first + '# calpy.updatePortType\n');
        await onDisk(() => stack.undo());
        expect(readFileSync(actors, 'utf8')).toBe(first);
    });

    it('goes to the file the element\'s definition is in, not one the panel read off a node that is only written there', async () => {
        const { net, modelState } = design();
        const [, Delete] = createEntityPortCrudHandlers({ createEntityPort: 'createEntityPort', deleteEntityPort: 'deleteEntityPort' });
        const sent: Sent[] = [];
        const handler = new (Delete as any)();
        handler.modelState = modelState;
        handler.sidecar = producer(net, sent, true);
        await onDisk(() => commandStack().execute(handler.createCommand({
            kind: 'deleteEntityPort', elementId: 'a', entityType: 'Pass', portDirection: 'input', portName: 'In',
            entityDocumentUri: pathToFileURL(net).href
        })));
        expect(sent.map(each => each.file)).toEqual(['actors.py']);
    });
});

describe('the instances an edit of a class\'s port is told of', () => {
    it('are this network\'s: not those inside a subnetwork shown in place, nor a class of the name from another file', async () => {
        const { instancesOf } = await import('../src/server/operations/entity-port-write.js');
        const node = (name: string, extra: Record<string, unknown> = {}, children: any[] = []) => ({
            id: name, type: WorkflowDiagramTypes.NODE_ACTOR, children,
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: name, [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Pass', ...extra }
        });
        const definedIn = (file: string) => ({ [WorkflowDiagramMetadata.REFERENCED_URI]: file, [WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION]: true });
        const root = {
            id: 'root', children: [
                node('a', definedIn('file:///d/actors.py')),
                node('other', definedIn('file:///d/elsewhere.py')),
                { ...node('sub', { [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Sub', [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true }), children: [node('inner', definedIn('file:///d/actors.py'))] },
                node('b')
            ]
        };
        expect(instancesOf(root as any, 'Pass', 'file:///d/actors.py')).toEqual(['a', 'b']);
    });
});

describe('a connection made', () => {
    it('is undone though the editor had not caught up with the producer\'s write', async () => {
        const { net, modelState } = design();
        const handler = new CreateEdgeOperationHandler() as any;
        handler.modelState = modelState;
        handler.sidecar = { sidecarOp: (op: string) => `calpy.${op}`, undoLabelSuffix: () => '', edgeRoles: async () => undefined };
        handler.sendSidecarOp = async () => {
            writeFileSync(net, NET + 'connect("x", a.Ports.In)\n');
            return true;
        };
        const stack = commandStack();
        const workspace = vscode.workspace as any;
        await onDisk(async () => {
            // Asked right after the write, the buffer still holds the text before.
            workspace.openTextDocument = async () => ({ getText: () => NET, isDirty: false, lineCount: 1, lineAt: () => ({ text: '' }), save: async () => true });
            await stack.execute(handler.createCommand({
                kind: 'createEdge', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, sourceElementId: 'x', targetElementId: 'a_in'
            }));
        });
        expect(readFileSync(net, 'utf8')).toBe(NET + 'connect("x", a.Ports.In)\n');
        expect(stack.canUndo()).toBe(true);
        const said = await saying(async said => {
            await onDisk(() => stack.undo());
            return said;
        });
        expect(said).toEqual([]);
        expect(readFileSync(net, 'utf8')).toBe(NET);
    });
});

describe('a connection moved', () => {
    it('to a network\'s own port drawn as a node is moved to the port hidden in it', async () => {
        const { portAt } = await import('../src/server/operations/edge-end.js');
        const { modelState } = design();
        expect((portAt(modelState.index, 'x') as any)?.id).toBe('x_p');
        expect((portAt(modelState.index, 'a_in') as any)?.id).toBe('a_in');
    });
});
