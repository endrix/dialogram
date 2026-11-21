/**
 * The command stack tells the host which files an edit's producer wrote.
 *
 * Many edits are written by the product's producer, on disk; the editor applies
 * nothing, and the host reloaded the diagram only when its file watcher
 * reported the write. A watcher can report nothing (a machine out of inotify
 * instances), and the edit was then written and not drawn. So the stack,
 * once an edit is executed, hands the host each file the producer wrote and
 * what it holds now; an edit applied in the editor, refused, or that wrote
 * nothing is not told.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { Container, ContainerModule } from 'inversify';
import { initializeContainer } from '@eclipse-glsp/protocol/lib/di/container-configuration';
import { ClientActionKinds, ClientId, CommandStack, CompoundCommand, GLSPClientProxy } from '@eclipse-glsp/server';
import type { DiagramModelSource } from '@dialogram/shared';
import { WorkflowCommandStack, outOfBandWrites } from '../src/server/command-stack';
import { createWorkflowServerModules } from '../src/server/server-module';
import { OUT_OF_BAND_WRITE_SINK, type OutOfBandWrite } from '../src/server/out-of-band-writes';
import { ReversibleWorkspaceEditCommand } from '../src/operations/reversible-workspace-edit-command';
import { ReversibleMultiWorkspaceEditCommand } from '../src/operations/reversible-multi-workspace-edit-command';

const uri = vscode.Uri.parse('file:///w/net.src');
const other = vscode.Uri.parse('file:///w/lib.src');

/** The documents, held here; an empty insertion at the start is what a command applies after a producer wrote. */
const texts = new Map<string, string>();
const saved = {
    open: (vscode.workspace as any).openTextDocument,
    apply: (vscode.workspace as any).applyEdit,
    set: (vscode.WorkspaceEdit as any).prototype.set
};

beforeEach(() => {
    texts.clear();
    texts.set(uri.toString(), 'A');
    texts.set(other.toString(), 'L');
    const pending: Array<{ key: string; edits: vscode.TextEdit[] }> = [];
    (vscode.WorkspaceEdit as any).prototype.set = (at: vscode.Uri, edits: vscode.TextEdit[]) => { pending.push({ key: at.toString(), edits }); };
    (vscode.workspace as any).openTextDocument = async (at: vscode.Uri) => {
        const text = texts.get(at.toString()) ?? '';
        return { getText: () => texts.get(at.toString()) ?? '', isDirty: false, lineCount: 1, lineAt: () => ({ text }), save: async () => true };
    };
    (vscode.workspace as any).applyEdit = async () => {
        for (const { key, edits } of pending.splice(0)) {
            for (const edit of edits) {
                const insertion = edit.range.start.line === 0 && edit.range.start.character === 0
                    && edit.range.end.line === 0 && edit.range.end.character === 0;
                texts.set(key, insertion ? edit.newText + (texts.get(key) ?? '') : edit.newText);
            }
        }
        return true;
    };
});

afterEach(() => {
    (vscode.workspace as any).openTextDocument = saved.open;
    (vscode.workspace as any).applyEdit = saved.apply;
    (vscode.WorkspaceEdit as any).prototype.set = saved.set;
});

/** The platform's stack, telling `told` what it is told to tell the host. */
function commandStack(told: OutOfBandWrite[][]): WorkflowCommandStack {
    const stack = new WorkflowCommandStack();
    (stack as any).logger = { error: (...args: unknown[]) => { throw new Error(args.map(String).join(' ')); } };
    (stack as any).outOfBandWriteSink = (writes: readonly OutOfBandWrite[]) => { told.push([...writes]); };
    return stack;
}

/** An edit applied in the editor: it writes `to`. */
function edit(to: string): ReversibleWorkspaceEditCommand {
    return new ReversibleWorkspaceEditCommand({
        label: 'Edit',
        uri,
        computeEdits: async () => [new vscode.TextEdit(new vscode.Range(0, 0, 0, 1), to)]
    });
}

/** An edit the producer writes itself: `to`, or nothing; the handler reads the file back. */
function outOfBand(to?: string): ReversibleWorkspaceEditCommand {
    const command: ReversibleWorkspaceEditCommand = new ReversibleWorkspaceEditCommand({
        label: 'Out of band',
        uri,
        computeEdits: async () => {
            const before = texts.get(uri.toString())!;
            if (to !== undefined) {
                texts.set(uri.toString(), to);
            }
            (command as any)._sourceBeforeText = before;
            (command as any)._sourceAfterText = texts.get(uri.toString());
            return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
        }
    });
    return command;
}

/** An edit the producer writes itself into several files, `writes` naming what each becomes. */
function outOfBandInFiles(writes: Array<[vscode.Uri, string]>): ReversibleMultiWorkspaceEditCommand {
    let snapshots: Array<{ uri: vscode.Uri; beforeText: string; afterText: string }> = [];
    return new ReversibleMultiWorkspaceEditCommand({
        label: 'Out of band, several files',
        outOfBandSnapshots: () => snapshots,
        computeEdits: async () => {
            snapshots = writes.map(([at, to]) => {
                const beforeText = texts.get(at.toString())!;
                texts.set(at.toString(), to);
                return { uri: at, beforeText, afterText: to };
            });
            return writes.map(([at]) => ({ uri: at, edits: [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')] }));
        }
    });
}

describe('what an edit\'s producer wrote, told to the host', () => {
    it('is the file and what it holds now, once the edit has run', async () => {
        const told: OutOfBandWrite[][] = [];
        await commandStack(told).execute(outOfBand('B'));
        expect(told).toEqual([[{ uri: uri.toString(), text: 'B' }]]);
    });

    it('is nothing for an edit applied in the editor, one refused, or one that wrote nothing', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await stack.execute(edit('B'));
        await stack.execute(new ReversibleWorkspaceEditCommand({ label: 'Refused', uri, computeEdits: async () => undefined }));
        await stack.execute(outOfBand());
        expect(told).toEqual([]);
    });

    it('is each file of several the producer changed, and not one it left as it was', async () => {
        const told: OutOfBandWrite[][] = [];
        await commandStack(told).execute(outOfBandInFiles([[uri, 'B'], [other, 'L']]));
        expect(told).toEqual([[{ uri: uri.toString(), text: 'B' }]]);
    });

    it('is, for a compound, every part\'s at once, a file two parts wrote as the last left it', async () => {
        const told: OutOfBandWrite[][] = [];
        await commandStack(told).execute(new CompoundCommand([outOfBand('B'), outOfBandInFiles([[other, 'M']]), outOfBand('C')]));
        expect(told).toHaveLength(1);
        expect(told[0]).toEqual([{ uri: other.toString(), text: 'M' }, { uri: uri.toString(), text: 'C' }]);
        expect(outOfBandWrites({ execute: () => {}, undo: () => {}, redo: () => {} })).toEqual([]);
    });

    it('is told again by an edit run again, and not by its undo, which saves the file', async () => {
        const told: OutOfBandWrite[][] = [];
        const stack = commandStack(told);
        await stack.execute(outOfBand('B'));
        await stack.undo();
        expect(texts.get(uri.toString())).toBe('A');
        expect(told).toHaveLength(1);
    });

    it('does not undo the edit when the host fails to hear it', async () => {
        const stack = commandStack([]);
        (stack as any).outOfBandWriteSink = () => { throw new Error('host gone'); };
        await stack.execute(outOfBand('B'));
        expect(stack.canUndo()).toBe(true);
        expect(texts.get(uri.toString())).toBe('B');
    });
});

const SOURCE: DiagramModelSource = { getGraph: async () => undefined };

/** A diagram session's container as GLSP makes it (see server-module-load-seams.test.ts). */
function session(serverModules: unknown[]): Container {
    const server = new Container();
    const proxyModule = new ContainerModule((bind) =>
        bind(GLSPClientProxy).toConstantValue({ process: () => undefined } as any)
    );
    initializeContainer(server, ...(serverModules as unknown as ContainerModule[]), proxyModule);
    const serverModule = serverModules[1] as unknown as { diagramModules: Map<string, ContainerModule[]> };
    const modules = [...serverModule.diagramModules.values()][0];
    const container = server.createChild();
    container.load(...(modules as ContainerModule[]));
    for (const [token, value] of [[ClientId, 'client-1'], [ClientActionKinds, []]] as const) {
        if (container.isBound(token)) {
            container.rebind(token).toConstantValue(value);
        } else {
            container.bind(token).toConstantValue(value);
        }
    }
    return container;
}

describe('the host\'s ear for them', () => {
    it('is the session\'s command stack\'s, where the host gives one', () => {
        const sink = (): void => undefined;
        const container = session(createWorkflowServerModules({ modelSourceFactory: () => SOURCE, outOfBandWrites: sink }));
        expect(container.get(OUT_OF_BAND_WRITE_SINK)).toBe(sink);
        expect((container.get<any>(CommandStack)).outOfBandWriteSink).toBe(sink);
    });

    it('is absent where the host gives none, and the stack tells nobody', () => {
        const container = session(createWorkflowServerModules({ modelSourceFactory: () => SOURCE }));
        expect(container.isBound(OUT_OF_BAND_WRITE_SINK)).toBe(false);
        expect((container.get<any>(CommandStack)).outOfBandWriteSink).toBeUndefined();
    });
});
