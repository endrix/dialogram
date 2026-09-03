import { EditorContextService } from '@eclipse-glsp/client';
import {
    Args,
    GModelElement,
    IContextMenuItemProvider,
    LabeledAction,
    NavigateToExternalTargetAction,
    Point,
    isSelected
} from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';

function isContextMenuDebugEnabled(): boolean {
    try {
        return globalThis?.localStorage?.getItem('workflow.debugContextMenu') === '1';
    } catch {
        return false;
    }
}

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };

type NavigationTarget = {
    uri: string;
    range?: SerializedRange;
};

function isSerializedPosition(value: unknown): value is SerializedPosition {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return typeof v.line === 'number' && typeof v.character === 'number';
}

function isSerializedRange(value: unknown): value is SerializedRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return isSerializedPosition(v.start) && isSerializedPosition(v.end);
}

function declarationTargetFromElement(element: GModelElement | undefined, fallbackSourceUri: string): NavigationTarget | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return { uri: fallbackSourceUri, range };
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

function sourceTargetFromElement(element: GModelElement | undefined, fallbackSourceUri: string): NavigationTarget | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const referencedUri = args?.[WorkflowDiagramMetadata.REFERENCED_URI];
        const referencedRange = args?.[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE];
        if (typeof referencedUri === 'string') {
            if (isSerializedRange(referencedRange)) {
                return { uri: referencedUri, range: referencedRange };
            }
            // At least open the referenced document.
            return { uri: referencedUri };
        }

        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return { uri: fallbackSourceUri, range };
        }

        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

/**
 * Where this element was authored, when that is a third file.
 *
 * Deliberately does NOT fall back to anything. The other two targets fall
 * through to the diagram's own file because a missing range there still means
 * "somewhere in this document"; here an absent value means the producer did not
 * claim a separate authored file, and offering the generated one under that
 * label would be a lie about which file the reader is being sent to.
 */
function authoredTargetFromElement(element: GModelElement | undefined): NavigationTarget | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const authoredUri = args?.[WorkflowDiagramMetadata.AUTHORED_URI];
        if (typeof authoredUri === 'string') {
            const range = args?.[WorkflowDiagramMetadata.AUTHORED_SOURCE_RANGE];
            return isSerializedRange(range) ? { uri: authoredUri, range } : { uri: authoredUri };
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

function toNavigateAction(target: NavigationTarget): LabeledAction['actions'][number] {
    return NavigateToExternalTargetAction.create({
        uri: target.uri,
        args: {
            [SHOW_OPTIONS_ARG]: JSON.stringify({
                ...(target.range ? { selection: target.range } : {}),
                preview: true,
                preserveFocus: false
            })
        }
    });
}

@injectable()
export class WorkflowGoToSourceContextMenuItemProvider implements IContextMenuItemProvider {
    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    async getItems(root: Readonly<GModelElement>, _lastMousePosition?: Point): Promise<LabeledAction[]> {
        const sourceUri = this.editorContext.sourceUri;
        if (!sourceUri) {
            return [];
        }

        const debug = isContextMenuDebugEnabled();
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] getItems called', { sourceUri });
        }

        // The context menu is selection-based in GLSP; find the first selected element
        // and walk up to locate source metadata (works for ports/labels too).
        const selected = Array.from(root.index.all().filter(isSelected));
        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] selection', { count: selected.length, first: selected[0]?.id, firstType: selected[0]?.type });
        }
        const declarationTarget = selected.length > 0 ? declarationTargetFromElement(selected[0], sourceUri) : undefined;
        const sourceTarget = selected.length > 0 ? sourceTargetFromElement(selected[0], sourceUri) : undefined;
        const authoredTarget = selected.length > 0 ? authoredTargetFromElement(selected[0]) : undefined;
        if (!declarationTarget && !sourceTarget && !authoredTarget) {
            if (debug) {
                // eslint-disable-next-line no-console
                console.log('[cal][context-menu] no navigation target (no menu items)');
            }
            return [];
        }

        if (debug) {
            // eslint-disable-next-line no-console
            console.log('[cal][context-menu] navigation targets', { declarationTarget, sourceTarget });
        }

        const items: LabeledAction[] = [];
        if (declarationTarget) {
            items.push({
                label: 'Go to Declaration',
                actions: [toNavigateAction(declarationTarget)]
            });
        }
        if (sourceTarget) {
            items.push({
                label: 'Go to Source',
                actions: [toNavigateAction(sourceTarget)]
            });
        }
        if (authoredTarget) {
            items.push({
                label: 'Go to Authored Source',
                actions: [toNavigateAction(authoredTarget)]
            });
        }
        return items;
    }
}
