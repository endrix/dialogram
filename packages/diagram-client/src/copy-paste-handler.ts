import { inject, injectable } from 'inversify';
import { RequestClipboardDataAction, CutOperation, PasteOperation } from '@eclipse-glsp/protocol';
import { EditorContextService, TYPES, type IActionDispatcher, type ViewerOptions } from '@eclipse-glsp/client';
import { type ClipboardData } from '@eclipse-glsp/sprotty';
import { PostEditSelectionService } from './post-edit-selection-service';

type ClipboardIdEnvelope = { clipboardId: string };

function toClipboardId(clipboardId: string): string {
    return JSON.stringify({ clipboardId });
}

function isClipboardIdEnvelope(value: unknown): value is ClipboardIdEnvelope {
    return !!value && typeof value === 'object' && 'clipboardId' in (value as any);
}

function getClipboardIdFromDataTransfer(dataTransfer: DataTransfer): string | undefined {
    const jsonString = dataTransfer.getData('text/plain');
    if (!jsonString) {
        return undefined;
    }
    try {
        const jsonObject = JSON.parse(jsonString) as unknown;
        return isClipboardIdEnvelope(jsonObject) ? jsonObject.clipboardId : undefined;
    } catch {
        return undefined;
    }
}

function newClipboardId(): string {
    try {
        return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    } catch {
        return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
}

type IAsyncClipboardService = {
    clear(): void;
    put(data: ClipboardData, id?: string): void;
    get(id?: string): ClipboardData | undefined;
};

export interface ICopyPasteHandler {
    handleCopy(event: ClipboardEvent): void;
    handleCut(event: ClipboardEvent): void;
    handlePaste(event: ClipboardEvent): void;
}

@injectable()
export class WorkflowCopyPasteHandler implements ICopyPasteHandler {
    @inject(PostEditSelectionService)
    protected readonly postEditSelection!: PostEditSelectionService;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    @inject(TYPES.ViewerOptions)
    protected readonly viewerOptions!: ViewerOptions;

    @inject(TYPES.IAsyncClipboardService)
    protected readonly clipboardService!: IAsyncClipboardService;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    private readonly pendingClipboardData = new Map<string, Promise<ClipboardData>>();

    handleCopy(event: ClipboardEvent): void {
        if (event.clipboardData && this.shouldCopy(event)) {
            const clipboardId = newClipboardId();
            event.clipboardData.setData('text/plain', toClipboardId(clipboardId));

            const pending = this.actionDispatcher
                .request(RequestClipboardDataAction.create(this.editorContext.get()))
                .then(action => {
                    this.clipboardService.put(action.clipboardData, clipboardId);
                    return action.clipboardData as ClipboardData;
                })
                .finally(() => this.pendingClipboardData.delete(clipboardId));
            this.pendingClipboardData.set(clipboardId, pending);

            event.preventDefault();
        } else {
            if (event.clipboardData) {
                event.clipboardData.clearData();
            }
            this.clipboardService.clear();
        }
    }

    handleCut(event: ClipboardEvent): void {
        if (event.clipboardData && this.shouldCopy(event)) {
            this.handleCopy(event);
            this.actionDispatcher.dispatch(CutOperation.create(this.editorContext.get()));
            event.preventDefault();
        }
    }

    handlePaste(event: ClipboardEvent): void {
        if (event.clipboardData && this.shouldPaste(event)) {
            const clipboardId = getClipboardIdFromDataTransfer(event.clipboardData);
            if (!clipboardId) {
                return;
            }

            const clipboardData = this.clipboardService.get(clipboardId) as ClipboardData | undefined;
            if (clipboardData) {
                this.postEditSelection.prepareForPaste(clipboardData as any, (this.editorContext as any).modelRoot);
                this.actionDispatcher.dispatch(PasteOperation.create({ clipboardData, editorContext: this.editorContext.get() }));
                event.preventDefault();
                return;
            }

            const pending = this.pendingClipboardData.get(clipboardId);
            if (pending) {
                // Fast paste (Cmd/Ctrl+V right after Cmd/Ctrl+C) can beat the async clipboard payload request.
                // Queue the paste after the data arrives.
                pending.then(resolved => {
                    this.postEditSelection.prepareForPaste(resolved as any, (this.editorContext as any).modelRoot);
                    this.actionDispatcher.dispatch(PasteOperation.create({ clipboardData: resolved, editorContext: this.editorContext.get() }));
                });
                event.preventDefault();
            }
        }
    }

    protected shouldCopy(_event: ClipboardEvent): boolean {
        return this.editorContext.get().selectedElementIds.length > 0 && this.isDiagramActive();
    }

    protected shouldPaste(_event: ClipboardEvent): boolean {
        return this.isDiagramActive();
    }

    // Keep in sync with upstream logic.
    private isDiagramActive(): boolean {
        const baseDivId = (this.viewerOptions as any).baseDiv as string | undefined;
        if (!baseDivId) {
            return true;
        }
        const active = document.activeElement as HTMLElement | null;
        const escape = (globalThis as any).CSS?.escape as ((value: string) => string) | undefined;
        const safeId = escape ? escape(baseDivId) : baseDivId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        return !!active?.closest?.(`#${safeId}`);
    }
}
