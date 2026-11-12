import { EditorContextService, Ranked } from '@eclipse-glsp/client';
import {
    Action,
    Args,
    GModelElement,
    MouseListener,
    NavigateToExternalTargetAction
} from '@eclipse-glsp/sprotty';
import { openTargetOf } from './open-target';
import { openLeaf } from './network-navigation-mouse-listener';
import { inject, injectable, multiInject, optional } from 'inversify';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { NodeOpener } from './node-opener';
import { lastPerKey } from './contributions';
import { portBusToggleOf } from './port-bus-toggle';

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';
const NAVIGATE_PREFER_DEFINITION_ARG = 'wf:navigatePreferDefinition';
const NAVIGATE_SOURCE_URI_ARG = 'wf:navigateSourceUri';
const NAVIGATE_SOURCE_RANGE_ARG = 'wf:navigateSourceRange';
const NAVIGATE_SYMBOL_ARG = 'wf:navigateSymbol';
// The target is the definition itself, named by the producer: the host opens it as it is.
const NAVIGATE_TARGET_IS_DEFINITION_ARG = 'wf:navigateTargetIsDefinition';

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };

function findContainingEntityNode(element: GModelElement | undefined): GModelElement | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        if (
            current.type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR ||
            current.type === WorkflowDiagramTypes.NODE_ACTOR ||
            current.type === WorkflowDiagramTypes.NODE_NETWORK
        ) {
            return current;
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

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

function findSourceRange(element: GModelElement | undefined): SerializedRange | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return range;
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

function findDefinitionTarget(element: GModelElement | undefined): { uri: string; range?: SerializedRange; isDefinition?: boolean } | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const referencedUri = args?.[WorkflowDiagramMetadata.REFERENCED_URI];
        if (typeof referencedUri === 'string') {
            const referencedRange = args?.[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE];
            const isDefinition = args?.[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION] === true ? { isDefinition: true } : {};
            if (isSerializedRange(referencedRange)) {
                return { uri: referencedUri, range: referencedRange, ...isDefinition };
            }
            return { uri: referencedUri, ...isDefinition };
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

function displayNameFromQualifiedName(qualifiedName: string): string {
    const afterDots = qualifiedName.split('.').pop() ?? qualifiedName;
    const parts = afterDots.split('__');
    return parts.length > 0 ? parts[parts.length - 1] : afterDots;
}

function findNavigationSymbol(element: GModelElement | undefined): string | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const referencedEntityName = args?.[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME];
        if (typeof referencedEntityName === 'string' && referencedEntityName.trim() !== '') {
            return displayNameFromQualifiedName(referencedEntityName.trim());
        }
        const entityType = args?.[WorkflowDiagramMetadata.ENTITY_TYPE];
        if (typeof entityType === 'string' && entityType.trim() !== '') {
            return displayNameFromQualifiedName(entityType.trim());
        }
        const entityName = args?.[WorkflowDiagramMetadata.ENTITY_NAME];
        if (typeof entityName === 'string' && entityName.trim() !== '') {
            return displayNameFromQualifiedName(entityName.trim());
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

export function buildDefinitionNavigationAction(
    element: GModelElement,
    sourceUri: string | undefined
): ReturnType<typeof NavigateToExternalTargetAction.create> | undefined {
    const defTarget = findDefinitionTarget(element);
    const fallbackRange = sourceUri ? findSourceRange(element) : undefined;
    const symbolHint = findNavigationSymbol(element);
    if (!defTarget && (!sourceUri || !fallbackRange)) {
        return undefined;
    }

    const targetUri = defTarget?.uri ?? sourceUri!;
    const targetRange = defTarget?.range ?? fallbackRange;

    return NavigateToExternalTargetAction.create({
        uri: targetUri,
        args: {
            [SHOW_OPTIONS_ARG]: JSON.stringify({
                ...(targetRange ? { selection: targetRange } : {}),
                preview: true,
                preserveFocus: false
            }),
            [NAVIGATE_PREFER_DEFINITION_ARG]: true,
            ...(defTarget?.isDefinition ? { [NAVIGATE_TARGET_IS_DEFINITION_ARG]: true } : {}),
            ...(sourceUri ? { [NAVIGATE_SOURCE_URI_ARG]: sourceUri } : {}),
            ...(fallbackRange ? { [NAVIGATE_SOURCE_RANGE_ARG]: JSON.stringify(fallbackRange) } : {}),
            ...(symbolHint ? { [NAVIGATE_SYMBOL_ARG]: symbolHint } : {})
        }
    });
}

/**
 * Whether the network navigation listener opens something itself for this
 * node on a double-click (its `openLeaf`): the node's first view, or, with
 * `doubleClickOpensSource`, its definition for real. Answering here too opened
 * a second thing beside it: a specification clause opened its refinement
 * trace and its heading as a preview at once.
 */
function leafOpensItself(node: GModelElement): boolean {
    // Asked of `openLeaf` itself, so the two never disagree: a node it opens
    // nothing for (a view but no referenced name, say) keeps its definition.
    return openLeaf(node).length > 0;
}

@injectable()
export class ViewerMouseListener extends MouseListener implements Ranked {
    // Run early so it triggers before default tools.
    rank = 9;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    /** What products open on a double-click; see `node-opener.ts`. */
    @multiInject(NodeOpener) @optional()
    protected readonly contributedOpeners: readonly NodeOpener[] | undefined;

    /** One opener per id, in the order the ids were first bound; a later binding replaces the earlier one. */
    protected nodeOpeners(): readonly NodeOpener[] {
        return lastPerKey(this.contributedOpeners, opener => opener.id);
    }

    override doubleClick(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        // A double-click on a bus toggle is two toggles, not a request to open the node.
        if (portBusToggleOf(event)) {
            return [];
        }
        const node = findContainingEntityNode(target);
        if (!node) {
            return [];
        }
        // The network navigation listener opens the file such a node stands
        // for; answering here too would open its definition beside it.
        if (openTargetOf(node)) {
            return [];
        }

        const args = (node as unknown as { args?: Args }).args;
        if (!args) {
            return [];
        }

        // What a product opens for the node, before the platform's own: its
        // definition. An empty answer is no answer; an opener that throws is
        // skipped, so it cannot stop the node from opening anything.
        for (const opener of this.nodeOpeners()) {
            let opened: (Action | Promise<Action>)[] | undefined;
            try {
                opened = opener.open(node, { sourceUri: this.editorContext.sourceUri });
            } catch (error) {
                console.warn(`[dialogram] the node opener '${opener.id}' failed`, error);
                continue;
            }
            if (opened && opened.length > 0) {
                return opened;
            }
        }

        // The definition of a task, or of an actor that is not marked external.
        const opensDefinition = node.type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
            || (node.type === WorkflowDiagramTypes.NODE_ACTOR && args[WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR] !== true);
        if (!opensDefinition) {
            return [];
        }
        const definitionNavigationAction = buildDefinitionNavigationAction(node, this.editorContext.sourceUri);
        return definitionNavigationAction && !leafOpensItself(node) ? [definitionNavigationAction] : [];
    }
}
