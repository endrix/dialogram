import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createPythonNavigationProvider } from '../src/python-navigation';

// Drilling on an actor of a CalPy network: the graph locates the node at its
// instantiation, `load, store = Load(), Store()`, and the host asks for the
// definition of `Load` from there. When Pylance cannot follow the import it
// returns no definition at all, and the drill-down has to find the class itself.

const NETWORK_LINES = [
    'from load.load import Load',
    'from store.store import Store',
    '',
    'def Net():',
    '    load, store = Load(), Store()'
];
const INSTANCE_LINE = 4;

const ACTOR_LINES = [
    'from mlir_cal.calpy import actor',
    '',
    '@actor',
    'class Load:',
    '    pass'
];
const CLASS_LINE = 3;

function fakeDocument(lines: readonly string[]): unknown {
    return {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] ?? '' }),
        getText: () => lines.join('\n')
    };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const workspace = vscode.workspace as unknown as Mutable<typeof vscode.workspace> & Record<string, unknown>;
const originalWorkspace = { ...workspace };

function installWorkspace(root: string): { networkUri: string; actorUri: string } {
    const networkPath = `${root}/gen/network/net.py`;
    const actorPath = `${root}/gen/load/load.py`;
    const files = new Map<string, readonly string[]>([
        [networkPath, NETWORK_LINES],
        [actorPath, ACTOR_LINES]
    ]);
    workspace.openTextDocument = (async (uri: vscode.Uri) => {
        const lines = files.get(uri.fsPath);
        if (!lines) {
            throw new Error(`no such file: ${uri.fsPath}`);
        }
        return fakeDocument(lines);
    }) as typeof workspace.openTextDocument;
    workspace.getWorkspaceFolder = ((uri: vscode.Uri) => uri.fsPath.startsWith(`${root}/`)
        ? { uri: vscode.Uri.file(root), name: root, index: 0 }
        : undefined) as typeof workspace.getWorkspaceFolder;
    workspace.findFiles = (async () => [...files.keys()].map(p => vscode.Uri.file(p))) as typeof workspace.findFiles;
    return { networkUri: vscode.Uri.file(networkPath).toString(), actorUri: vscode.Uri.file(actorPath).toString() };
}

function drillRequest(networkUri: string): Record<string, unknown> {
    return {
        kind: 'definition',
        sourceUri: networkUri,
        sourceSelection: { start: { line: INSTANCE_LINE, character: 0 }, end: { line: INSTANCE_LINE, character: 0 } },
        symbolHint: 'Load'
    };
}

describe('python drill-down from an actor instance', () => {
    beforeEach(() => {
        (vscode as unknown as { resetRegisteredCommands(): void }).resetRegisteredCommands();
        vscode.commands.registerCommand('vscode.executeDefinitionProvider', () => []);
    });

    afterEach(() => {
        Object.assign(workspace, originalWorkspace);
    });

    it('falls back to the workspace symbols when Pylance finds no definition', async () => {
        const { networkUri, actorUri } = installWorkspace('/ws-symbols');
        vscode.commands.registerCommand('vscode.executeWorkspaceSymbolProvider', () => [{
            name: 'Load',
            kind: vscode.SymbolKind.Class,
            location: { uri: vscode.Uri.parse(actorUri), range: new vscode.Range(CLASS_LINE, 6, CLASS_LINE, 10) }
        }]);

        const target = await createPythonNavigationProvider().resolveTarget(drillRequest(networkUri));

        expect(target?.uri).toBe(actorUri);
        expect(target?.range?.startLine).toBe(CLASS_LINE);
    });

    it('does not take the instance variable for the class, and finds the class in the files', async () => {
        const { networkUri, actorUri } = installWorkspace('/ws-files');
        // An include list that leaves the actor's file out: the search sees only the open network.
        vscode.commands.registerCommand('vscode.executeWorkspaceSymbolProvider', () => [{
            name: 'load',
            kind: vscode.SymbolKind.Variable,
            location: { uri: vscode.Uri.parse(networkUri), range: new vscode.Range(INSTANCE_LINE, 4, INSTANCE_LINE, 8) }
        }]);

        const target = await createPythonNavigationProvider().resolveTarget(drillRequest(networkUri));

        expect(target?.uri).toBe(actorUri);
        expect(target?.range?.startLine).toBe(CLASS_LINE);
    });
});
