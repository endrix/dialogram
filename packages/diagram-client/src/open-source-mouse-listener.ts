import { EditorContextService, Ranked } from '@eclipse-glsp/client';
import {
    Action,
    Args,
    GModelElement,
    MouseListener,
    NavigateToExternalTargetAction
} from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };
type NavigationTarget = { uri: string; range?: SerializedRange };

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
            return { uri: referencedUri };
        }

        const sourceRange = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(sourceRange)) {
            return { uri: fallbackSourceUri, range: sourceRange };
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

@injectable()
export class WorkflowOpenSourceMouseListener extends MouseListener implements Ranked {
    // Run early so we can optionally prevent the default context menu.
    rank = 10;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    override contextMenu(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        const sourceUri = this.editorContext.sourceUri;
        if (!sourceUri) {
            return [];
        }

        const navigationTarget = sourceTargetFromElement(target, sourceUri);
        if (!navigationTarget) {
            return [];
        }

        // Turn right-click into "open source".
        try {
            event.preventDefault();
            event.stopPropagation();
        } catch {
            // ignore
        }

        return [
            NavigateToExternalTargetAction.create({
                uri: navigationTarget.uri,
                args: {
                    [SHOW_OPTIONS_ARG]: JSON.stringify({
                        ...(navigationTarget.range ? { selection: navigationTarget.range } : {}),
                        preview: true,
                        preserveFocus: false
                    })
                }
            })
        ];
    }
}
