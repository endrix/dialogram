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

    // Derived getters (added for diagram-openability.test.ts, whose
    // shouldOpenDiagram reads `.scheme` / `.fsPath`). Only invoked when
    // accessed, so `.parse()` / `.file()` / `.toString()` consumers are unaffected.
    get scheme(): string {
        const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(this.value);
        return match?.[1] ?? '';
    }

    get fsPath(): string {
        if (this.scheme !== 'file') {
            return this.value;
        }

        const withoutScheme = this.value.replace(/^file:\/\//, '');
        return decodeURI(withoutScheme);
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

// Added for cli-run-driver.test.ts: the run machinery wraps the CLI spawn in
// `vscode.window.withProgress(options, task)` and reads `vscode.ProgressLocation`.
// The mock simply invokes the task with inert progress/token args and forwards
// its result, so the driver's run path can be exercised end-to-end.
export const ProgressLocation = {
    SourceControl: 1,
    Window: 10,
    Notification: 15
} as const;

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
    showInformationMessage: async (_message: string, ..._items: string[]): Promise<any> => {
        // no-op for tests
        return undefined;
    },
    withProgress: async <T>(
        _options: unknown,
        task: (progress: { report(value: unknown): void }, token: { isCancellationRequested: boolean }) => Promise<T>
    ): Promise<T> => task({ report: () => {} }, { isCancellationRequested: false })
};

export const workspace = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    openTextDocument: async (_uri: Uri): Promise<any> => {
        throw new Error('vscode.workspace.openTextDocument is not available in tests');
    },
    // Added for the re-homed model-source suites: SidecarModelSource/CliGraphModelSource resolve
    // the sidecar/CLI command through `getSidecarCommand(cfg, vscode)` / `getCliInvocation(cfg,
    // vscode)`, which read `workspace.getConfiguration(ns).get(key, default)`. The tests inject the
    // fake CLI/sidecar via the cfg *defaults*, so this mock simply returns the supplied default.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getConfiguration: (_section?: string, _scope?: unknown) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getWorkspaceFolder: (_uri: Uri): undefined => undefined
};

// Added for cli-run-driver.test.ts: the driver registers its run/stop and
// agent-tool config commands through `vscode.commands.registerCommand`, and the
// tests drive them via `executeCommand`. The registry mirrors the real dispatch:
// `registerCommand` stores the handler (returning a disposable that unregisters),
// and `executeCommand` invokes the stored handler (or resolves to `undefined`
// when nothing is registered, matching the previous no-op behavior for callers
// like the `vscode.open` built-in that tests never register).
const registeredCommands = new Map<string, (...args: any[]) => any>();

export const commands = {
    registerCommand: (command: string, callback: (...args: any[]) => any): { dispose(): void } => {
        registeredCommands.set(command, callback);
        return {
            dispose: () => {
                if (registeredCommands.get(command) === callback) {
                    registeredCommands.delete(command);
                }
            }
        };
    },
    executeCommand: async (command: string, ...args: any[]): Promise<any> => {
        const handler = registeredCommands.get(command);
        return handler ? await handler(...args) : undefined;
    }
};

// The command registry is module-level, so handlers registered by one test
// persist into later tests in the same file. Suites that register commands
// should call this from `beforeEach` to isolate each test.
export const resetRegisteredCommands = (): void => {
    registeredCommands.clear();
};
