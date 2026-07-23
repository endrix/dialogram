import { inject, injectable } from 'inversify';
import { ContextMenuItemProvider, ModelState } from '@eclipse-glsp/server';
import {
    Args,
    DeleteElementOperation,
    LayoutOperation,
    MenuItem,
    NavigateToExternalTargetAction,
    Point
} from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

const SHOW_OPTIONS_ARG = 'jsonOpenerOptions';
const NAVIGATE_PREFER_DEFINITION_ARG = 'wf:navigatePreferDefinition';
const NAVIGATE_SOURCE_URI_ARG = 'wf:navigateSourceUri';
const NAVIGATE_SOURCE_RANGE_ARG = 'wf:navigateSourceRange';
const NAVIGATE_SYMBOL_ARG = 'wf:navigateSymbol';

const PROMPT_LABEL_EDIT_KIND = 'dialogram.promptLabelEdit';
const EDIT_PARAMETERS_KIND = 'dialogram.editParameters';
const PROMPT_RENAME_ENTITY_KIND = 'dialogram.promptRenameEntity';
const RESET_EDGE_ROUTES_KIND = 'dialogram.resetEdgeRoutes';
const REROUTE_EDGES_AVOID_OVERLAPS_KIND = 'dialogram.rerouteEdgesAvoidOverlaps';
const LAYOUT_BOUNDARY_FLOW_KIND = 'dialogram.layoutBoundaryFlow';
const LAYOUT_SERPENTINE_MESH_KIND = 'dialogram.layoutSerpentineMesh';
const WORKFLOW_SOURCE_URI_ARG = 'wf:workflowSourceUri';
const WORKFLOW_SOURCE_RANGE_ARG = 'wf:workflowSourceRange';

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

function navigationTargetFromElement(element: unknown, fallbackSourceUri: string): NavigationTarget | undefined {
    let current: any = element;
    while (current) {
        const args: Args | undefined = current.args;

        const referencedUri = args?.[WorkflowDiagramMetadata.REFERENCED_URI];
        const referencedRange = args?.[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE];
        if (typeof referencedUri === 'string') {
            if (isSerializedRange(referencedRange)) {
                return { uri: referencedUri, range: referencedRange };
            }
            return { uri: referencedUri };
        }

        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return { uri: fallbackSourceUri, range };
        }

        current = current.parent;
    }

    return undefined;
}

function declarationTargetFromElement(element: unknown, fallbackSourceUri: string): NavigationTarget | undefined {
    let current: any = element;
    while (current) {
        const args: Args | undefined = current.args;
        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return { uri: fallbackSourceUri, range };
        }
        current = current.parent;
    }
    return undefined;
}

function sourceTargetFromElement(element: unknown, fallbackSourceUri: string): NavigationTarget | undefined {
    let current: any = element;
    while (current) {
        const args: Args | undefined = current.args;

        const referencedUri = args?.[WorkflowDiagramMetadata.REFERENCED_URI];
        const referencedRange = args?.[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE];
        if (typeof referencedUri === 'string') {
            if (isSerializedRange(referencedRange)) {
                return { uri: referencedUri, range: referencedRange };
            }
            return { uri: referencedUri };
        }

        const range = args?.[WorkflowDiagramMetadata.SOURCE_RANGE];
        if (isSerializedRange(range)) {
            return { uri: fallbackSourceUri, range };
        }

        current = current.parent;
    }

    return undefined;
}

function workflowDefinitionTargetFromRoot(rootElement: unknown, fallbackSourceUri: string): NavigationTarget | undefined {
    if (!rootElement || typeof rootElement !== 'object') {
        return undefined;
    }

    const args = (rootElement as { args?: Args }).args;
    const explicitUri = typeof args?.[WORKFLOW_SOURCE_URI_ARG] === 'string'
        ? (args?.[WORKFLOW_SOURCE_URI_ARG] as string)
        : fallbackSourceUri;
    const explicitRange = args?.[WORKFLOW_SOURCE_RANGE_ARG];

    if (isSerializedRange(explicitRange)) {
        return { uri: explicitUri, range: explicitRange };
    }

    if (typeof explicitUri === 'string' && explicitUri.trim() !== '') {
        return { uri: explicitUri };
    }

    return undefined;
}

function displayNameFromQualifiedName(qualifiedName: string): string {
    const afterDots = qualifiedName.split('.').pop() ?? qualifiedName;
    const parts = afterDots.split('__');
    return parts.length > 0 ? parts[parts.length - 1] : afterDots;
}

function navigationSymbolFromElement(element: unknown): string | undefined {
    let current: any = element;
    while (current) {
        const args: Args | undefined = current.args;

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

        current = current.parent;
    }

    return undefined;
}

function toNavigateAction(
    target: NavigationTarget,
    preferDefinitionFrom?: NavigationTarget,
    symbolHint?: string
): ReturnType<typeof NavigateToExternalTargetAction.create> {
    const preferSourceUri = preferDefinitionFrom?.uri;
    const preferSourceRange = preferDefinitionFrom?.range;
    const symbol = typeof symbolHint === 'string' && symbolHint.trim() !== ''
        ? symbolHint.trim()
        : undefined;

    return NavigateToExternalTargetAction.create({
        uri: target.uri,
        args: {
            [SHOW_OPTIONS_ARG]: JSON.stringify({
                ...(target.range ? { selection: target.range } : {}),
                preview: true,
                preserveFocus: false
            }),
            ...(preferSourceUri
                ? {
                    [NAVIGATE_PREFER_DEFINITION_ARG]: true,
                    [NAVIGATE_SOURCE_URI_ARG]: preferSourceUri,
                    ...(preferSourceRange ? { [NAVIGATE_SOURCE_RANGE_ARG]: JSON.stringify(preferSourceRange) } : {}),
                    ...(symbol ? { [NAVIGATE_SYMBOL_ARG]: symbol } : {})
                }
                : {})
        }
    });
}

@injectable()
export class WorkflowContextMenuItemProvider extends ContextMenuItemProvider {
    @inject(ModelState)
    protected readonly modelState!: ModelState;

    override getItems(selectedElementIds: string[], _position: Point, _args?: Args): MenuItem[] {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return [];
        }

        const element = selectedElementIds.length > 0 ? this.modelState.index.find(selectedElementIds[0]) : this.modelState.root;
        if (!element) {
            return [];
        }

        const items: MenuItem[] = [];
        let addedRootGoToSource = false;

        const elementType = (element as any).type as string | undefined;
        const elementArgs: Args | undefined = (element as any).args;
        const navSymbolHint = navigationSymbolFromElement(element);

        const boundaryAncestor = (() => {
            let current: any = element;
            while (current) {
                const t = (current as any).type as string | undefined;
                if (t === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || t === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
                    return current;
                }
                current = current.parent;
            }
            return undefined;
        })();

        // Boundary ports: allow remove when right-clicking the port element itself.
        if (elementType?.startsWith('port') && boundaryAncestor) {
            items.push({
                id: 'dialogram.removeBoundaryPort',
                label: 'Remove Port',
                sortString: 'e',
                actions: [
                    DeleteElementOperation.create([String((boundaryAncestor as any).id)])
                ]
            });
        }

        // Boundary ports: rename + change type.
        if (elementType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || elementType === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const portName = elementArgs?.[WorkflowDiagramMetadata.PORT_NAME];
            const portType = elementArgs?.[WorkflowDiagramMetadata.PORT_TYPE];
            if (typeof portName === 'string') {
                items.push({
                    id: 'dialogram.renameBoundaryPort',
                    label: 'Rename Port...',
                    sortString: 'b',
                    actions: [
                        {
                            kind: PROMPT_LABEL_EDIT_KIND,
                            labelId: `${(element as any).id}_label_name`,
                            title: 'Rename Port',
                            value: portName
                        } as any
                    ]
                });
            }
            if (typeof portName === 'string' && typeof portType === 'string') {
                items.push({
                    id: 'dialogram.changeBoundaryPortType',
                    label: 'Change Type...',
                    sortString: 'c',
                    actions: [
                        {
                            kind: PROMPT_LABEL_EDIT_KIND,
                            labelId: `${(element as any).id}_label_type`,
                            title: 'Change Port Type',
                            value: portType
                        } as any
                    ]
                });
            }
        }

        // Entity instances: rename.
        if (
            elementType === WorkflowDiagramTypes.NODE_ACTOR ||
            elementType === WorkflowDiagramTypes.NODE_NETWORK ||
            elementType === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const entityName = elementArgs?.[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof entityName === 'string' && entityName.trim() !== '') {
                items.push({
                    id: 'dialogram.renameEntity',
                    label: 'Rename Entity...',
                    sortString: 'b2',
                    actions: [
                        {
                            kind: PROMPT_RENAME_ENTITY_KIND,
                            elementId: String((element as any).id),
                            title: 'Rename Entity',
                            value: entityName,
                            placeholder: 'New entity name'
                        } as any
                    ]
                });
            }
        }

        // Duplicate (entity instances + boundary ports)
        if (
            elementType === WorkflowDiagramTypes.NODE_ACTOR ||
            elementType === WorkflowDiagramTypes.NODE_NETWORK ||
            elementType === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR ||
            elementType === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT ||
            elementType === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT
        ) {
            items.push({
                id: 'dialogram.duplicate',
                label: 'Duplicate',
                sortString: 'd2',
                actions: [
                    {
                        kind: 'dialogram.duplicate',
                        isOperation: true,
                        elementIds: selectedElementIds
                    } as any
                ]
            });
        }

        // Selection-scoped actions (no auto-layout entries on node/edge right-click)
        if (selectedElementIds.length > 0) {
            items.push({
                id: 'dialogram.rerouteEdgesSelectionAvoidOverlaps',
                label: 'Reroute Edges (Avoid Overlaps, Keep Nodes)',
                sortString: 'g1.1',
                actions: [
                    {
                        kind: REROUTE_EDGES_AVOID_OVERLAPS_KIND,
                        isOperation: true,
                        elementIds: selectedElementIds
                    } as any
                ]
            });

            items.push({
                id: 'dialogram.rerouteEdgesSelectionAvoidOverlapsStable',
                label: 'Reroute Edges (Stable, Experimental)',
                sortString: 'g1.2',
                actions: [
                    {
                        kind: REROUTE_EDGES_AVOID_OVERLAPS_KIND,
                        isOperation: true,
                        elementIds: selectedElementIds,
                        routingStrategy: 'stable'
                    } as any
                ]
            });

            // Keep the simple "clear routes" variant available while we experiment.
            items.push({
                id: 'dialogram.rerouteEdgesSelection',
                label: 'Reroute Edges (Clear Routes Only)',
                sortString: 'g1.3',
                actions: [
                    {
                        kind: RESET_EDGE_ROUTES_KIND,
                        isOperation: true,
                        elementIds: selectedElementIds
                    } as any
                ]
            });
        }

        if (selectedElementIds.length === 0) {
            items.push({
                id: 'dialogram.layoutDiagramBoundaryFlow',
                label: 'Layout Diagram',
                sortString: 'g2',
                group: 'layout',
                actions: [
                    {
                        kind: LAYOUT_BOUNDARY_FLOW_KIND,
                        isOperation: true
                    } as any
                ]
            });

            items.push({
                id: 'dialogram.layoutDiagram',
                label: 'Compact Layout',
                sortString: 'g2.2',
                group: 'layout',
                actions: [LayoutOperation.create()]
            });

            items.push({
                id: 'dialogram.layoutDiagramSerpentineMesh',
                label: 'Serpentine Mesh Layout',
                sortString: 'g2.3',
                group: 'layout',
                actions: [
                    {
                        kind: LAYOUT_SERPENTINE_MESH_KIND,
                        isOperation: true
                    } as any
                ]
            });

            const workflowDefinitionTarget = workflowDefinitionTargetFromRoot(element, sourceUri);
            if (workflowDefinitionTarget) {
                items.push({
                    id: 'dialogram.goToSourceWorkflowDefinition',
                    label: 'Go to Source',
                    sortString: 'a1',
                    group: 'navigation',
                    actions: [
                        toNavigateAction(workflowDefinitionTarget)
                    ]
                });
                addedRootGoToSource = true;
            }

        }

        // Entity instances: edit instantiated parameters.
        if (
            elementType === WorkflowDiagramTypes.NODE_ACTOR ||
            elementType === WorkflowDiagramTypes.NODE_NETWORK ||
            elementType === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const defParams = elementArgs?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS];
            if (Array.isArray(defParams) && defParams.length > 0) {
                items.push({
                    id: 'dialogram.editParameters',
                    label: 'Edit Parameters...',
                    sortString: 'd',
                    actions: [
                        {
                            kind: EDIT_PARAMETERS_KIND,
                            elementId: (element as any).id
                        } as any
                    ]
                });
            }
        }

        // Go to Declaration / Go to Source
        const declarationTarget = declarationTargetFromElement(element, sourceUri);
        if (declarationTarget) {
            items.push({
                id: 'dialogram.goToDeclaration',
                label: 'Go to Declaration',
                sortString: 'a',
                actions: [
                    toNavigateAction(declarationTarget, declarationTarget, navSymbolHint)
                ]
            });
        }

        const sourceTarget = sourceTargetFromElement(element, sourceUri);
        if (sourceTarget && !(selectedElementIds.length === 0 && addedRootGoToSource)) {
            items.push({
                id: 'dialogram.goToSource',
                label: 'Go to Source',
                sortString: 'a1',
                actions: [
                    toNavigateAction(sourceTarget, sourceTarget, navSymbolHint)
                ]
            });
        }

        return items;
    }
}
