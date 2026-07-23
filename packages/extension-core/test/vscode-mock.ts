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

    static file(value: string): Uri {
        const normalized = value.startsWith('/') ? value : `/${value}`;
        return new Uri(`file://${encodeURI(normalized)}`);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
        const trimmedBase = base.value.replace(/\/+$/, '');
        const suffix = segments.map(s => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
        return new Uri(suffix ? `${trimmedBase}/${suffix}` : trimmedBase);
    }

    with(change: { scheme?: string; query?: string; fragment?: string }): Uri {
        const [beforeFragment, existingFragment = ''] = this.value.split('#');
        const [pathPart, existingQuery = ''] = beforeFragment.split('?');
        const query = change.query !== undefined ? change.query : existingQuery;
        const fragment = change.fragment !== undefined ? change.fragment : existingFragment;
        let next = pathPart;
        if (query) {
            next += `?${query}`;
        }
        if (fragment) {
            next += `#${fragment}`;
        }
        return new Uri(next);
    }

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

/**
 * Minimal synchronous EventEmitter mirroring vscode.EventEmitter: `event` is a
 * subscribe function returning a Disposable; `fire` invokes listeners in order.
 */
export class EventEmitter<T> {
    private readonly listeners = new Set<(e: T) => void>();

    readonly event = (listener: (e: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(data: T): void {
        for (const listener of [...this.listeners]) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

export const window = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showErrorMessage: async (_message: string): Promise<void> => {
        // no-op for tests
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInformationMessage: async (_message: string): Promise<void> => {
        // no-op for tests
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showWarningMessage: async (_message: string, ..._rest: any[]): Promise<any> => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInputBox: async (_options?: any): Promise<string | undefined> => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    createOutputChannel: (_name: string) => ({
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        appendLine: (_line: string): void => {
            // no-op for tests
        },
        dispose: (): void => {
            // no-op for tests
        }
    })
};

export const workspace = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    openTextDocument: async (_uri: Uri): Promise<any> => {
        throw new Error('vscode.workspace.openTextDocument is not available in tests');
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getConfiguration: (_section?: string, _scope?: unknown) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getWorkspaceFolder: (_uri: Uri): undefined => undefined,
    // Added for diagram-editor-provider construction: the provider subscribes to
    // in-editor change/save events and creates an on-disk .py watcher. Tests do
    // not drive these, so the shims just return inert disposables.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onDidChangeTextDocument: (_listener: (...args: any[]) => any): { dispose(): void } => ({ dispose: () => {} }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onDidSaveTextDocument: (_listener: (...args: any[]) => any): { dispose(): void } => ({ dispose: () => {} }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    createFileSystemWatcher: (_glob: string) => ({
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onDidChange: (_listener: (...args: any[]) => any): { dispose(): void } => ({ dispose: () => {} }),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onDidCreate: (_listener: (...args: any[]) => any): { dispose(): void } => ({ dispose: () => {} }),
        dispose: (): void => {}
    })
};

export const commands = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executeCommand: async (_command: string, ..._args: any[]): Promise<any> => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getCommands: async (_filterInternal?: boolean): Promise<string[]> => []
};
