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
import { WorkflowNavigationUi } from './navigation-ui';
import { clientBehavior } from './profile';
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

@injectable()
export class WorkflowNetworkNavigationMouseListener extends MouseListener implements Ranked {
    // Run fairly early so we beat default tools (drag etc.).
    rank = 10;

    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    @inject(WorkflowNavigationUi)
    protected readonly workflowNavUi!: WorkflowNavigationUi;

    override doubleClick(target: GModelElement, _event: MouseEvent): (Action | Promise<Action>)[] {
        const networkNode = findContainingNetworkInstanceNode(target);
        if (!networkNode) {
            return [];
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

        // Same-file: switch diagram model within the current editor.
        if (normalizedCurrentSourceUri && normalizedReferencedUri === normalizedCurrentSourceUri) {
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
