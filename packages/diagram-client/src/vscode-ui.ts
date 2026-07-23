export type VscodeQuickPickItem = {
    id: string;
    label: string;
    description?: string;
    detail?: string;
};

export type ViewerEditorSetting = {
    label: string;
    viewType: string;
    description?: string;
};

type UiRequest = {
    type:
        | 'dialogram.ui.quickPick'
        | 'dialogram.ui.inputBox'
        | 'dialogram.ui.executeCommand'
        | 'dialogram.ui.infoMessage'
        | 'dialogram.ui.errorMessage'
        | 'dialogram.ui.getViewerEditors'
        | 'dialogram.ui.appendViewerEditor';
    requestId?: string;
    payload: any;
};

type UiResponse = {
    type: 'dialogram.ui.response';
    payload: {
        requestId: string;
        result: any;
    };
};

function getVsCodeApi(): { postMessage: (msg: any) => void } | undefined {
    const w: any = globalThis as any;
    if (w.__calVscodeApi?.postMessage) {
        return w.__calVscodeApi;
    }
    if (typeof w.acquireVsCodeApi === 'function') {
        try {
            const api = w.acquireVsCodeApi();
            if (api?.postMessage) {
                return api;
            }
        } catch {
            // ignore
        }
    }
    return undefined;
}

export class VscodeUi {
    private static _instance: VscodeUi | undefined;
    static get instance(): VscodeUi {
        if (!this._instance) {
            this._instance = new VscodeUi();
        }
        return this._instance;
    }

    private pending = new Map<string, (result: any) => void>();

    private constructor() {
        window.addEventListener('message', (event: MessageEvent) => {
            const data = event.data as UiResponse | any;
            if (!data || data.type !== 'dialogram.ui.response') {
                return;
            }
            const requestId = data.payload?.requestId;
            if (!requestId) {
                return;
            }
            const resolver = this.pending.get(requestId);
            if (!resolver) {
                return;
            }
            this.pending.delete(requestId);
            resolver(data.payload?.result);
        });
    }

    async quickPick(options: { items: VscodeQuickPickItem[]; placeHolder?: string }): Promise<string | undefined> {
        const requestId = this.newRequestId();
        const msg: UiRequest = {
            type: 'dialogram.ui.quickPick',
            requestId,
            payload: {
                items: options.items,
                placeHolder: options.placeHolder ?? ''
            }
        };
        return await this.request<string | undefined>(msg);
    }

    async inputBox(options: { prompt: string; value?: string; placeHolder?: string }): Promise<string | undefined> {
        const requestId = this.newRequestId();
        const msg: UiRequest = {
            type: 'dialogram.ui.inputBox',
            requestId,
            payload: {
                prompt: options.prompt,
                value: options.value ?? '',
                placeHolder: options.placeHolder ?? ''
            }
        };
        return await this.request<string | undefined>(msg);
    }

    async executeCommand<T = unknown>(command: string, args: unknown[] = []): Promise<T> {
        const requestId = this.newRequestId();
        const msg: UiRequest = {
            type: 'dialogram.ui.executeCommand',
            requestId,
            payload: {
                command,
                args
            }
        };
        return await this.request<T>(msg);
    }

    async getViewerEditors(): Promise<ViewerEditorSetting[]> {
        const requestId = this.newRequestId();
        const msg: UiRequest = {
            type: 'dialogram.ui.getViewerEditors',
            requestId,
            payload: {}
        };
        return await this.request<ViewerEditorSetting[]>(msg);
    }

    async appendViewerEditor(editor: ViewerEditorSetting): Promise<boolean> {
        const requestId = this.newRequestId();
        const msg: UiRequest = {
            type: 'dialogram.ui.appendViewerEditor',
            requestId,
            payload: { editor }
        };
        return await this.request<boolean>(msg);
    }

    /**
     * Fire-and-forget message to the extension host. Unlike {@link request},
     * this does not wait for a correlated `dialogram.ui.response`; the receiver
     * may reply asynchronously via its own message types (e.g. the chat panel
     * which streams `chat.*` updates back). Returns false if the VS Code API is
     * unavailable (e.g. running outside a webview).
     */
    post(message: any): boolean {
        const api = getVsCodeApi();
        if (!api) {
            return false;
        }
        api.postMessage(message);
        return true;
    }

    /**
     * Subscribe to raw messages posted from the extension host. Returns an
     * unsubscribe function. Used by features (like the chat panel) that receive
     * pushed updates rather than request/response results.
     */
    onMessage(handler: (message: any) => void): () => void {
        const listener = (event: MessageEvent) => handler(event.data);
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }

    infoMessage(message: string): void {
        const api = getVsCodeApi();
        api?.postMessage({ type: 'dialogram.ui.infoMessage', payload: { message } });
    }

    errorMessage(message: string): void {
        const api = getVsCodeApi();
        api?.postMessage({ type: 'dialogram.ui.errorMessage', payload: { message } });
    }

    private async request<T>(msg: UiRequest): Promise<T> {
        const api = getVsCodeApi();
        if (!api) {
            throw new Error('VS Code API not available in webview');
        }
        const requestId = msg.requestId;
        if (!requestId) {
            throw new Error('Missing requestId');
        }

        const result = await new Promise<T>((resolve) => {
            this.pending.set(requestId, resolve as any);
            api.postMessage({ type: msg.type, payload: { requestId, ...msg.payload } });
        });

        return result;
    }

    private newRequestId(): string {
        return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
}
