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
    installFiles(root, new Map([
        [networkPath, NETWORK_LINES],
        [actorPath, ACTOR_LINES]
    ]));
    return { networkUri: vscode.Uri.file(networkPath).toString(), actorUri: vscode.Uri.file(actorPath).toString() };
}

function installFiles(root: string, files: ReadonlyMap<string, readonly string[]>): void {
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
}

function drillRequest(networkUri: string, symbolHint = 'Load', line = INSTANCE_LINE): Record<string, unknown> {
    return {
        kind: 'definition',
        sourceUri: networkUri,
        sourceSelection: { start: { line, character: 0 }, end: { line, character: 0 } },
        symbolHint
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

    it('follows the import to the class rather than take a same-named symbol of another project', async () => {
        // picorv32's network imports `Div` from its own gen root; the symbol
        // search only indexes boomv4, where `Div` is a Variant member and, as a
        // decoy, a class of another module.
        const root = '/ws-imports';
        const networkPath = `${root}/picorv32/gen/network/picorv32.py`;
        const actorPath = `${root}/picorv32/gen/pcpi/div.py`;
        const memberPath = `${root}/boomv4/gen/isa/alu.py`;
        const decoyPath = `${root}/boomv4/gen/isa/div.py`;
        installFiles(root, new Map([
            [networkPath, ['from pcpi.div import Div', '', 'def Net():', '    div = Div() if ENABLE_DIV else Absent()']],
            [actorPath, ['@actor', 'class Div:', '    pass']],
            [memberPath, ['class AluOp(Variant):', '    Div = ()']],
            [decoyPath, ['class Div:', '    pass']]
        ]));
        vscode.commands.registerCommand('vscode.executeWorkspaceSymbolProvider', () => [
            { name: 'Div', kind: vscode.SymbolKind.Variable, location: { uri: vscode.Uri.file(memberPath), range: new vscode.Range(1, 4, 1, 7) } },
            { name: 'Div', kind: vscode.SymbolKind.Class, location: { uri: vscode.Uri.file(decoyPath), range: new vscode.Range(0, 6, 0, 9) } }
        ]);

        const target = await createPythonNavigationProvider().resolveTarget(drillRequest(vscode.Uri.file(networkPath).toString(), 'Div', 3));

        expect(target?.uri).toBe(vscode.Uri.file(actorPath).toString());
        expect(target?.range?.startLine).toBe(1);
    });
});
