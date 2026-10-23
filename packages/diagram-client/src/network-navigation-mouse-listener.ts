import { EditorContextService, Ranked } from '@eclipse-glsp/client';
import {
    Action,
    Args,
    GModelElement,
    MouseListener,
    NavigateToExternalTargetAction,
    RequestModelAction
} from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';
import { navigatesInPlace, WorkflowNavigationUi } from './navigation-ui';
import { clientBehavior } from './profile';
import { openTargetAction } from './open-target';
import {
    buildCrossFileNavigationTarget,
    GRAPH_SOURCE_URI_ARG,
    INSTANCE_PATH_ARG,
    ROOT_WORKFLOW_ARG,
    NAV_TRAIL_ARG,
    RUN_ID_ARG
} from './network-navigation-target';

function normalizeSourceUriKey(sourceUri: string): string {
    const trimmed = sourceUri.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const parsed = new URL(trimmed);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString();
    } catch {
        return trimmed;
    }
}

function displayNameFromQualifiedName(qualifiedName: string): string {
    // Normalize both legacy and dot-qualified references:
    // - "namespace__Name" -> "Name"
    // - "namespace.Name"  -> "Name"
    const afterDots = qualifiedName.split('.').pop() ?? qualifiedName;
    const parts = afterDots.split('__');
    return parts.length > 0 ? parts[parts.length - 1] : afterDots;
}

function instancePathFromTrail(trail: Array<{ workflowInstanceName?: string }>): string[] {
    const out: string[] = [];
    for (const entry of trail) {
        const value = typeof entry.workflowInstanceName === 'string' ? entry.workflowInstanceName.trim() : '';
        if (value !== '') {
            out.push(value);
        }
    }
    return out;
}

/**
 * Find a network instance node in the element's ancestry.
 * This includes:
 * - NODE_NETWORK type nodes
 * - NODE_PROXY nodes where IS_NETWORK_INSTANCE is true (e.g., c[i] where c is a list of networks)
 */
function findContainingNetworkInstanceNode(element: GModelElement | undefined): GModelElement | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const isNetworkInstance = args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true;

        // Direct network node type
        if (current.type === WorkflowDiagramTypes.NODE_NETWORK && isNetworkInstance) {
            return current;
        }
        
        // Proxy node (e.g., c[i]) that represents a network instance
        if (current.type === WorkflowDiagramTypes.NODE_PROXY && isNetworkInstance) {
            return current;
        }
        
        // @eclipse-glsp/sprotty model elements have `parent` at runtime.
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';
/** The client handler's kind (`editing-action-handlers.ts`), without importing the module. */
const OPEN_VIEW_KIND = 'dialogram.openView';

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };

function isSerializedRange(value: unknown): value is SerializedRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    const ok = (p: unknown): boolean => !!p && typeof p === 'object'
        && typeof (p as SerializedPosition).line === 'number' && typeof (p as SerializedPosition).character === 'number';
    return ok(v.start) && ok(v.end);
}

/**
 * Where a double-click lands when the node has no diagram to drill into.
 *
 * A node that is not a network instance has nothing behind it on the canvas.
 * When the producer offers views of its unit (`wf:views`: a leaf's synthesis,
 * say), the first one opens in place, as a crumb of the trail. Otherwise, with
 * `clientBehavior.doubleClickOpensSource`, the node's definition opens in the
 * text editor (`REFERENCED_URI`, what "Go to Source" uses) for real, not as a
 * preview: the reader asked for the code. Both look the node up through the
 * element's ancestry, so a port or label resolves to its node.
 */
function openLeaf(target: GModelElement): Action[] {
    let current: GModelElement | undefined = target;
    while (current) {
        const args = (current as unknown as { args?: Args }).args;
        const uri = args?.[WorkflowDiagramMetadata.REFERENCED_URI];
        if (typeof uri === 'string' && uri.trim() !== '') {
            const views = args?.[WorkflowDiagramMetadata.VIEWS] as unknown;
            const first = Array.isArray(views) ? views.find(v => typeof v?.id === 'string' && v.id.trim() !== '') : undefined;
            const referencedName = args?.[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME] ?? args?.[WorkflowDiagramMetadata.ENTITY_TYPE];
            if (first && typeof referencedName === 'string' && referencedName.trim() !== '') {
                const instanceName = args?.['wf:entityInstanceName'];
                return [{
                    kind: OPEN_VIEW_KIND,
                    view: String(first.id).trim(),
                    ...(typeof first.label === 'string' ? { label: first.label } : {}),
                    uri,
                    workflowName: displayNameFromQualifiedName(referencedName.trim()),
                    ...(typeof instanceName === 'string' && instanceName.trim() !== '' ? { workflowInstanceName: instanceName.trim() } : {})
                } as Action];
            }
            if (clientBehavior().doubleClickOpensSource !== true) {
                return [];
            }
            const range = args?.[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE];
            return [
                NavigateToExternalTargetAction.create({
                    uri,
                    args: {
                        [SHOW_OPTIONS_ARG]: JSON.stringify({
                            ...(isSerializedRange(range) ? { selection: range } : {}),
                            preview: false,
                            preserveFocus: false
                        })
                    }
                })
            ];
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return [];
}

@injectable()
export class WorkflowNetworkNavigationMouseListener extends MouseListener implements Ranked {
    // Run fairly early so we beat default tools (drag etc.).
    rank = 10;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    @inject(WorkflowNavigationUi)
    protected readonly workflowNavUi!: WorkflowNavigationUi;

    override doubleClick(target: GModelElement, _event: MouseEvent): (Action | Promise<Action>)[] {
        // A node that stands for a file opens it, whatever else it could do
        // (see open-target.ts); the viewer listener stands back for it.
        const openFile = openTargetAction(target);
        if (openFile) {
            return [openFile];
        }
        const networkNode = findContainingNetworkInstanceNode(target);
        if (!networkNode) {
            return openLeaf(target);
        }

        const args = (networkNode as unknown as { args?: Args }).args;
        if (!args) {
            return [];
        }

        const isNetworkInstance = args[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true;
        if (!isNetworkInstance) {
            return [];
        }

        const referencedUri = args[WorkflowDiagramMetadata.REFERENCED_URI] as string | undefined;
        const entityType = args[WorkflowDiagramMetadata.ENTITY_TYPE] as string | undefined;
        const referencedEntityName = args[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME] as string | undefined;
        if (!referencedUri || (!entityType && !referencedEntityName)) {
            return [];
        }

        const targetNameRaw = referencedEntityName?.trim() || entityType?.trim() || '';
        const targetNetworkName = displayNameFromQualifiedName(targetNameRaw);
        if (!targetNetworkName) {
            return [];
        }
        const targetWorkflowInstanceName = typeof args['wf:entityInstanceName'] === 'string'
            ? String(args['wf:entityInstanceName']).trim() || undefined
            : undefined;
        const hasTargetInstanceName = typeof targetWorkflowInstanceName === 'string' && targetWorkflowInstanceName.trim() !== '';
        const currentSourceUri = this.editorContext.sourceUri;
        const selectedRunId = typeof (globalThis as any)?.__calDiagramContext?.selectedRunId === 'string'
            ? String((globalThis as any).__calDiagramContext.selectedRunId).trim() || undefined
            : undefined;
        const useGraphSourceNavigation = clientBehavior().graphSourceNavigation === true;

        // No-op guard: avoid dispatching when drill-down resolves to the workflow
        // currently displayed in the same document.
        const currentWorkflowName = typeof (globalThis as any)?.__calDiagramContext?.workflowName === 'string'
            ? String((globalThis as any).__calDiagramContext.workflowName).trim()
            : undefined;
        const normalizedCurrentSourceUri = currentSourceUri ? normalizeSourceUriKey(currentSourceUri) : undefined;
        const normalizedReferencedUri = normalizeSourceUriKey(referencedUri);
        const allowSameSourceDrilldown = useGraphSourceNavigation && hasTargetInstanceName;

        if (
            normalizedCurrentSourceUri &&
            normalizedReferencedUri === normalizedCurrentSourceUri &&
            currentWorkflowName &&
            targetNetworkName === currentWorkflowName &&
            !allowSameSourceDrilldown
        ) {
            return [];
        }

        const targetSourceUri = referencedUri;
        const navTrail = this.workflowNavUi.buildNavigationTrail(
            currentSourceUri,
            targetSourceUri,
            targetNetworkName,
            targetWorkflowInstanceName
        );
        const serializedTrail = JSON.stringify(navTrail);
        const instancePath = useGraphSourceNavigation ? instancePathFromTrail(navTrail) : [];
        const rootWorkflowName = useGraphSourceNavigation
            ? navTrail[0]?.workflowName?.trim() || currentWorkflowName
            : undefined;

        // Same file, or any file when navigating in place: switch the diagram
        // model within the current editor. The request names the defining file;
        // the trail keeps the editor's root at its head.
        if (
            (normalizedCurrentSourceUri && normalizedReferencedUri === normalizedCurrentSourceUri)
            || navigatesInPlace()
        ) {
            this.workflowNavUi.noteNavigate(referencedUri, targetNetworkName, navTrail);
            const includeGraphSourceFallback = useGraphSourceNavigation
                && !!normalizedCurrentSourceUri
                && !!rootWorkflowName
                && instancePath.length > 0;
            return [
                RequestModelAction.create({
                    requestId: `nav-${Date.now()}`,
                    options: {
                        sourceUri: referencedUri,
                        diagramType: this.editorContext.diagramType,
                        networkName: targetNetworkName,
                        [NAV_TRAIL_ARG]: serializedTrail,
                        ...(includeGraphSourceFallback
                            ? ({
                                [GRAPH_SOURCE_URI_ARG]: normalizedCurrentSourceUri,
                                [ROOT_WORKFLOW_ARG]: rootWorkflowName,
                                // instancePath is a string[]; GLSP Args only types JsonPrimitive
                                // values, but the arg is serialized/consumed as a list downstream.
                                [INSTANCE_PATH_ARG]: instancePath
                            } as unknown as Args)
                            : {}),
                        ...(selectedRunId ? { [RUN_ID_ARG]: selectedRunId } : {})
                    }
                })
            ];
        }

        // Cross-file: ask the VS Code host to open the referenced file as a *diagram*.
        this.workflowNavUi.noteNavigate(referencedUri, targetNetworkName, navTrail);
        return [
            NavigateToExternalTargetAction.create({
                ...buildCrossFileNavigationTarget({
                    referencedUri,
                    targetNetworkName,
                    serializedTrail,
                    selectedRunId,
                    useGraphSourceNavigation,
                    currentSourceUri: currentSourceUri ? normalizeSourceUriKey(currentSourceUri) : undefined,
                    rootWorkflowName,
                    instancePath
                })
            })
        ];
    }
}
