// Minimal runtime shim for the `vscode` module used by extension/GLSP code.
// Vitest runs in plain Node.js where the real VS Code API is not available.

export type Thenable<T> = PromiseLike<T>;

export class Position {
    constructor(
        public readonly line: number,
        public readonly character: number
    ) {}
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

export class Uri {
    private constructor(private readonly value: string) {}

    static parse(value: string): Uri {
        return new Uri(value);
    }

    // Added for characterization-graph-load.test.ts: tryLoadGraphFromSidecar unconditionally
    // calls `vscode.Uri.file(filePath)` before dispatching to the (stubbed) runtime profile, so
    // the mock needs a working `.file()` to exercise that code path with a real spawned process
    // instead of monkey-patching tryLoadGraphFromSidecar itself. Deliberately mirrors `.parse()`
    // exactly (no `.fsPath` getter added) -- an earlier version added a `fsPath` getter here and
    // it broke workflow-create-node-handler.test.ts, which relies on `Uri.parse(...).fsPath`
    // being `undefined` to fall back to a mock-supplied path.
    static file(fsPath: string): Uri {
        return new Uri(`file://${fsPath}`);
    }

    toString(): string {
        return this.value;
    }
}

export class TextEdit {
    constructor(
        public readonly range: Range,
        public readonly newText: string
    ) {}
}

// Added for diagnostics-parity.test.ts: WorkflowSourceModelStorage#publishGraphDiagnostics
// degrades to a no-op unless `vscode.languages.createDiagnosticCollection` and `vscode.Diagnostic`
// exist (see the guard at the top of that method), so a regression test that wants to observe
// published diagnostics needs a minimal, real `DiagnosticCollection` here rather than a full
// mock of the VS Code Problems-panel API.
export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3
}

export class Diagnostic {
    source?: string;
    code?: string;
    constructor(
        public range: Range,
        public message: string,
        public severity: DiagnosticSeverity = DiagnosticSeverity.Error
    ) {}
}

export class DiagnosticCollection {
    private readonly store = new Map<string, Diagnostic[]>();
    constructor(public readonly name: string) {}

    set(uri: Uri, diagnostics: Diagnostic[]): void {
        this.store.set(uri.toString(), diagnostics);
    }

    get(uri: Uri): Diagnostic[] | undefined {
        return this.store.get(uri.toString());
    }

    delete(uri: Uri): void {
        this.store.delete(uri.toString());
    }

    clear(): void {
        this.store.clear();
    }
}

// The real Problems-panel collection is process-global by name (see graph-diagnostics.ts); mirror
// that here so repeated `createDiagnosticCollection` calls within a test file return the same
// instance the storage under test wrote to.
const diagnosticCollections = new Map<string, DiagnosticCollection>();

export const languages = {
    createDiagnosticCollection: (name: string): DiagnosticCollection => {
        let collection = diagnosticCollections.get(name);
        if (!collection) {
            collection = new DiagnosticCollection(name);
            diagnosticCollections.set(name, collection);
        }
        return collection;
    }
};

export const QuickPickItemKind = {
    Separator: -1
} as const;

export class WorkspaceEdit {
    readonly size: number = 0;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    set(_uri: Uri, _edits: TextEdit[]): void {
        // no-op for tests
    }

    entries(): [Uri, TextEdit[]][] {
        return [];
    }
}

export const window = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showErrorMessage: async (_message: string): Promise<void> => {
        // no-op for tests
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showWarningMessage: async (_message: string): Promise<void> => {
        // no-op for tests
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInformationMessage: async (_message: string): Promise<void> => {
        // no-op for tests
    }
};

// Minimal configuration shim: `.get(key)` / `.get(key, default)` returns the supplied default (or
// `undefined`). Enough for the run-output-dir + live-glow lookups the overlay-scan path performs
// (run-output-overlay-memoization.test.ts) without wiring a real settings store.
export const workspace = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    openTextDocument: async (_uri: Uri): Promise<any> => {
        throw new Error('vscode.workspace.openTextDocument is not available in tests');
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getConfiguration: (_namespace?: string, _scope?: unknown) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    findFiles: async (..._args: unknown[]): Promise<Uri[]> => [],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getWorkspaceFolder: (_uri: Uri): undefined => undefined
};

export const commands = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executeCommand: async (_command: string, ..._args: any[]): Promise<any> => undefined
};
