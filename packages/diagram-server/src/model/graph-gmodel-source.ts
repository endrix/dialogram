import { WorkflowDiagramCss, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import * as path from 'node:path';
import { findFeedbackEdges } from './feedback-edges';
import { URI } from 'vscode-uri';

export type PyGraphPort = {
    id: string;
    name: string;
    direction: 'in' | 'out';
    type?: string;
    role?: string;
    source?: { file?: string; line?: number } | null;
};

export type PyGraphNode = {
    id: string;
    kind: string;
    label: string;
    type?: string;
    scope: string;
    ports: PyGraphPort[];
    meta?: Record<string, unknown>;
};

export type PyGraphEdge = {
    id: string;
    from: string;
    to: string;
    scope: string;
    source?: { file?: string; line?: number } | null;
    meta?: Record<string, unknown>;
};

export type PyGraphScope = {
    id: string;
    kind: string;
    parent?: string | null;
    controlNodeId?: string | null;
    children?: string[];
    nodes?: string[];
    edges?: string[];
};

export type PyGraph = {
    id: string;
    nodes: PyGraphNode[];
    edges: PyGraphEdge[];
    subgraphs?: PyGraphScope[];
    meta?: Record<string, unknown>;
};

export type PyGraphDocument = {
    version: string;
    graph: PyGraph;
    partial?: boolean;
    errors?: Array<{ message?: string; file?: string; line?: number; column?: number }>;
};

export type GModelElement = {
    id: string;
    type: string;
    children?: GModelElement[];
    cssClasses?: string[];
    args?: Record<string, unknown>;
};

export type GNode = GModelElement & {
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    layoutOptions?: Record<string, unknown>;
};

export type GPort = GModelElement & {
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    layoutOptions?: Record<string, unknown>;
};

export type GEdge = GModelElement & {
    sourceId: string;
    targetId: string;
};

export type GGraph = GModelElement & {
    type: typeof WorkflowDiagramTypes.GRAPH;
};

/** True for the element types an edge can actually be attached to. */
function isEdge(element: GModelElement): element is GEdge {
    return (
        typeof (element as GEdge).sourceId === 'string' &&
        typeof (element as GEdge).targetId === 'string'
    );
}

/**
 * Tag the connections that close a feedback loop.
 *
 * The graph is walked in `feedback-edges.ts`; this is the part that knows the
 * model. Two jobs: say which node owns each endpoint — an edge attaches to a
 * PORT, and an actor's in and out ports are the same node, so without this
 * every actor in a straight pipeline would look like a loop — and put the class
 * on the edges the walk names.
 *
 * The class is always applied. Whether it is DRAWN differently is the reader's
 * choice, made in the webview with no round trip, because it is a question
 * about looking rather than about the graph (see the palette toggle).
 */
function markFeedbackEdges(children: GModelElement[]): void {
    /** endpoint id → owning node id, for every port under every node. */
    const ownerByEndpoint = new Map<string, string>();
    const indexPorts = (element: GModelElement, owner: string | undefined): void => {
        const isNode = !isEdge(element) && element.type !== WorkflowDiagramTypes.GRAPH;
        const nodeId = isNode ? element.id : owner;
        if (owner !== undefined) {
            ownerByEndpoint.set(element.id, owner);
        }
        for (const child of element.children ?? []) {
            indexPorts(child, nodeId);
        }
    };
    for (const child of children) {
        indexPorts(child, undefined);
    }

    const edges = children.filter(isEdge);
    if (edges.length === 0) {
        return;
    }
    // An endpoint nothing claims is its own node: a boundary port hangs off the
    // graph itself, and calling two of them the same node would invent a loop.
    const feedback = findFeedbackEdges(edges, id => ownerByEndpoint.get(id) ?? id);
    for (const edge of edges) {
        if (!feedback.has(edge.id)) {
            continue;
        }
        edge.cssClasses = [...(edge.cssClasses ?? []), WorkflowDiagramCss.EDGE_FEEDBACK];
        edge.args = { ...(edge.args ?? {}), [WorkflowDiagramMetadata.IS_FEEDBACK]: true };
    }
}

function normalizeNavigationFileUri(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }

    try {
        const uri = URI.parse(trimmed);
        if (uri.scheme === 'file') {
            return URI.file(path.resolve(uri.fsPath)).toString();
        }
        if (uri.scheme !== '') {
            return uri.toString();
        }
    } catch {
        // Fall through to raw filesystem path handling.
    }

    return URI.file(path.resolve(trimmed)).toString();
}

export class GraphGModelSource {
    transform(doc: PyGraphDocument): { graph: GGraph } {
        const children: GModelElement[] = [];
        const nodeMap = new Map<string, GNode>();
        const portIdMap = new Map<string, string>();
        const boundaryPortIds = new Set<string>();
        let workflowName: string | undefined;
        let workflowDefinitionSource: { file?: string; line: number } | undefined;
        const scopeNodes = new Map<string, string[]>();
        const scopeMeta = new Map<string, PyGraphScope>();
        const irNodeToStableId = new Map<string, string>();
        const removedNodeIds = new Set<string>();
        const scopeById = new Map<string, PyGraphScope>();
        const controlBranchPortMap = new Map<string, Map<string, { inId: string; outId: string; inIndex: number; outIndex: number; branch: string }>>();
        for (const scope of doc.graph.subgraphs ?? []) {
            scopeMeta.set(scope.id, scope);
            scopeById.set(scope.id, scope);
        }

        for (const node of doc.graph.nodes) {
            if (!workflowName && (node.kind === 'workflow' || node.kind === 'wf-input' || node.kind === 'wf-output')) {
                workflowName = node.label;
            }
            if (!workflowDefinitionSource && node.kind === 'workflow') {
                const workflowSource = node.meta?.['source'] as { file?: string; line?: number } | undefined;
                if (typeof workflowSource?.line === 'number' && workflowSource.line > 0) {
                    workflowDefinitionSource = {
                        file: normalizeNavigationFileUri(typeof workflowSource.file === 'string' ? workflowSource.file : undefined),
                        line: workflowSource.line
                    };
                }
            }
            const stableNodeId = node.label ? node.label : node.id;
            if (node.kind === 'wf-input' || node.kind === 'wf-output') {
                const boundaryNode = this.createBoundaryNode(node, stableNodeId);
                children.push(boundaryNode);
                irNodeToStableId.set(node.id, boundaryNode.id);
                for (const port of node.ports) {
                    const stablePortId = `${stableNodeId}_port_${port.name ?? 'Port'}`;
                    portIdMap.set(port.id, stablePortId);
                    boundaryPortIds.add(stablePortId);
                }
                continue;
            }
            const inputs = node.ports.filter(p => p.direction === 'in');
            const outputs = node.ports.filter(p => p.direction === 'out');

            const portW = WorkflowDiagramConstants.PORT_WIDTH_PX;
            const portH = WorkflowDiagramConstants.PORT_HEIGHT_PX;
            const portRowH = portH + WorkflowDiagramConstants.PORT_ROW_VERTICAL_GAP_PX;
            const yStart = WorkflowDiagramConstants.HEADER_HEIGHT_PX + WorkflowDiagramConstants.PORT_AREA_PADDING_PX;
            const minHeight = node.kind === 'if' || node.kind === 'loop' ? 160 : 60;
            const defaultWidth = node.kind === 'if' || node.kind === 'loop' ? 260 : 140;

            const maxPorts = Math.max(inputs.length, outputs.length);
            // Symmetric padding: PORT_AREA_PADDING_PX above the first port and below the last port.
            // requiredHeight = yStart + maxPorts * portRowH - PORT_ROW_VERTICAL_GAP_PX + PORT_HEIGHT + PORT_AREA_PADDING_PX
            const requiredHeight = yStart + maxPorts * portRowH
                - WorkflowDiagramConstants.PORT_ROW_VERTICAL_GAP_PX
                + WorkflowDiagramConstants.PORT_HEIGHT_PX
                + WorkflowDiagramConstants.PORT_AREA_PADDING_PX;

            const labelGap = WorkflowDiagramConstants.PORT_LABEL_GAP_PX;
            const labelPad = WorkflowDiagramConstants.PORT_LABEL_PADDING_PX;
            const centreGap = 12;
            let maxInputLabelW = 0;
            let maxOutputLabelW = 0;
            for (const p of inputs) {
                const w = this.estimateLabelSize(p.name, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX).width;
                if (w > maxInputLabelW) maxInputLabelW = w;
            }
            for (const p of outputs) {
                const w = this.estimateLabelSize(p.name, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX).width;
                if (w > maxOutputLabelW) maxOutputLabelW = w;
            }
            const labelRequiredWidth = portW + labelGap + labelPad + maxInputLabelW + centreGap + maxOutputLabelW + labelPad + labelGap + portW;
            const headerLabelW = this.estimateLabelSize(node.label, WorkflowDiagramConstants.HEADER_LABEL_FONT_SIZE_PX).width
                + WorkflowDiagramConstants.HEADER_LABEL_EXTRA_WIDTH_PX;
            const isNetworkInstanceNode = this.isNetworkInstanceNode(node);
            // Does this node get an italic type label under it? Mirrors the
            // condition used below when setting `wf:footerTypeLabel`.
            const footerTypeLabel = node.type
                ? (isNetworkInstanceNode ? node.type : (node.type !== node.label ? node.type : undefined))
                : undefined;
            // Reserve the label's band INSIDE the node height. The label is drawn
            // below the body, but leaving it out of the height hid it from
            // everything that reasons about geometry: ELK spaced nodes box to box
            // and could drop a label onto the node beneath, and both routers take
            // these same boxes as obstacles, so a route could cross a label.
            // The client draws the body shorter by the same amount, so nothing
            // changes visually.
            const footerReserve = footerTypeLabel
                ? WorkflowDiagramConstants.NODE_FOOTER_LABEL_HEIGHT_PX
                : 0;
            const size = {
                width: Math.max(defaultWidth, labelRequiredWidth, headerLabelW),
                height: Math.max(minHeight, requiredHeight) + footerReserve
            };
            const gnode: GNode = {
                id: stableNodeId,
                type: this.nodeType(node),
                children: [],
                cssClasses: this.getNodeCssClasses(node),
                layoutOptions: {
                    'elk.portConstraints': 'FIXED_POS'
                },
                size,
                args: {
                    [WorkflowDiagramMetadata.AST_PATH]: stableNodeId,
                    [WorkflowDiagramMetadata.ENTITY_NAME]: node.label,
                    [WorkflowDiagramMetadata.ENTITY_TYPE]: node.type,
                    'wf:entityInstanceName': node.label,
                    'wf:entityRef': node.type,
                    'wf:nodeKind': node.kind,
                    'wf:scope': node.scope
                }
            };
            if (node.meta) {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    'wf:nodeMeta': node.meta
                };
                // A parameterized network/actor instance carries its factory function
                // name; surface it so definition-parameter edits target the factory
                // (`def make_top(...)`) rather than the network name.
                const nodeFactoryName = node.meta['factoryName'];
                if (typeof nodeFactoryName === 'string' && nodeFactoryName.trim() !== '') {
                    (gnode.args as Record<string, unknown>)[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] = nodeFactoryName.trim();
                }
            }
            if (node.kind === 'if' || node.kind === 'loop') {
                gnode.cssClasses = [WorkflowDiagramCss.NODE, WorkflowDiagramCss.NODE_STRUCTURE, node.kind === 'if' ? WorkflowDiagramCss.NODE_STRUCTURE_IF : WorkflowDiagramCss.NODE_STRUCTURE_FOREACH];
                gnode.args = {
                    ...(gnode.args ?? {}),
                    [WorkflowDiagramMetadata.STRUCTURE_KIND]: node.kind
                };
                gnode.layoutOptions = {
                    'elk.algorithm': 'layered',
                    'elk.direction': 'DOWN',
                    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                    'elk.padding': '[top=28,left=10,bottom=10,right=10]',
                    'elk.spacing.nodeNode': '10',
                    'elk.portConstraints': 'FIXED_POS'
                };
            }
            if (this.isExternalNodeKind(node.kind)) {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true
                };
            }
            if (isNetworkInstanceNode) {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true
                };
            }
            if (node.meta) {
                const annots: Array<{ name: string; arguments?: Array<{ name?: string; value?: string }> }> = [];
                if (node.meta['tool']) annots.push({ name: 'tool' });
                if (node.meta['agent']) annots.push({ name: 'agent' });
                const viewerMeta = node.meta['viewer'];
                if (viewerMeta) {
                    const viewerArgs = this.annotationArgs(viewerMeta);
                    annots.push(viewerArgs.length > 0 ? { name: 'viewer', arguments: viewerArgs } : { name: 'viewer' });
                }
                const extraAnnots = node.meta['annotations'] as Record<string, unknown> | undefined;
                if (extraAnnots) {
                    for (const [name, value] of Object.entries(extraAnnots)) {
                        if (name === 'viewer') {
                            const existingIndex = annots.findIndex(annot => annot.name === 'viewer');
                            const next = { name, arguments: this.annotationArgs(value) };
                            if (existingIndex >= 0) {
                                annots[existingIndex] = next;
                            } else {
                                annots.push(next);
                            }
                        } else if (name === 'streaming' || name === 'pipeline' || name === 'keep') {
                            annots.push({ name });
                        }
                    }
                }
                if (annots.length > 0) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: annots
                    };
                }
                if (node.meta['parameters']) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.ENTITY_PARAMETERS]: node.meta['parameters']
                    };
                }
                if (node.meta['definitionParams']) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS]: node.meta['definitionParams']
                    };
                }
                if (node.meta['definitionAnnotations']) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: node.meta['definitionAnnotations']
                    };
                }
                // Static graph diagnostics use DEDICATED durable classes. The run-overlay cleanup
                // (clearExecutionGlowState) strips the run-execution markers (cal-node-error /
                // IS_ERRORED) on every overlay apply; a graph-export diagnostic is a property of
                // the source, not run state, so it must survive that. Severity drives the color:
                // error → red (a wrong port you typed), warning → amber (e.g. a node shown from
                // source that couldn't be elaborated).
                const graphDiagnostics = Array.isArray(node.meta['diagnostics'])
                    ? node.meta['diagnostics'] as Array<{ severity?: string }>
                    : [];
                const hasGraphError = node.meta['isErrored'] === true
                    || graphDiagnostics.some(d => d?.severity === 'error');
                const hasGraphWarning = !hasGraphError
                    && graphDiagnostics.some(d => d?.severity === 'warning');
                if (hasGraphError && !gnode.cssClasses?.includes('cal-node-graph-error')) {
                    gnode.cssClasses = [...(gnode.cssClasses ?? []), 'cal-node-graph-error'];
                } else if (hasGraphWarning && !gnode.cssClasses?.includes('cal-node-graph-warning')) {
                    gnode.cssClasses = [...(gnode.cssClasses ?? []), 'cal-node-graph-warning'];
                }
                const graphDiagMessage = typeof node.meta['errorMessage'] === 'string' && node.meta['errorMessage'].trim() !== ''
                    ? node.meta['errorMessage'].trim()
                    : (graphDiagnostics.find(d => typeof (d as { message?: string }).message === 'string') as { message?: string } | undefined)?.message?.trim();
                if (graphDiagMessage) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        'wf:errorMessage': graphDiagMessage
                    };
                }
                if (!node.meta['definitionAnnotations'] && annots.length > 0) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: annots
                    };
                }
                const sourceMeta = node.meta['source'] as { file?: string; line?: number } | undefined;
                const sourceMetaFile = normalizeNavigationFileUri(sourceMeta?.file);
                if (sourceMetaFile && sourceMeta?.line) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.SOURCE_RANGE]: {
                            start: { line: Math.max(0, sourceMeta.line - 1), character: 0 },
                            end: { line: Math.max(0, sourceMeta.line - 1), character: 0 }
                        },
                        [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: {
                            start: { line: Math.max(0, sourceMeta.line - 1), character: 0 },
                            end: { line: Math.max(0, sourceMeta.line - 1), character: 0 }
                        },
                        [WorkflowDiagramMetadata.REFERENCED_URI]: sourceMetaFile
                    };
                }
                const referencedSourceMeta = node.meta['referencedSource'] as { file?: string; line?: number } | undefined;
                const referencedSourceMetaFile = normalizeNavigationFileUri(referencedSourceMeta?.file);
                if (referencedSourceMetaFile && referencedSourceMeta?.line) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: {
                            start: { line: Math.max(0, referencedSourceMeta.line - 1), character: 0 },
                            end: { line: Math.max(0, referencedSourceMeta.line - 1), character: 0 }
                        },
                        [WorkflowDiagramMetadata.REFERENCED_URI]: referencedSourceMetaFile
                    };
                }
                const referencedEntityName = node.meta['referencedEntityName'];
                if (typeof referencedEntityName === 'string' && referencedEntityName.trim() !== '') {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: referencedEntityName.trim()
                    };
                }
                if (node.meta['tool']) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        'wf:toolSpec': node.meta['tool'],
                        [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true
                    };
                }
                if (node.meta['agent']) {
                    const agentSpec = node.meta['agent'] as Record<string, unknown>;
                    const normalizedAgentSpec: Record<string, unknown> = { ...agentSpec };
                    if (typeof normalizedAgentSpec['skill'] === 'string') {
                        normalizedAgentSpec['skill'] = this.wfStringLiteral(String(normalizedAgentSpec['skill']));
                    }
                    if (typeof normalizedAgentSpec['claudeAgent'] === 'string') {
                        normalizedAgentSpec['claudeAgent'] = this.wfStringLiteral(String(normalizedAgentSpec['claudeAgent']));
                    }
                    if (typeof normalizedAgentSpec['prompt'] === 'string') {
                        normalizedAgentSpec['prompt'] = this.wfStringLiteral(String(normalizedAgentSpec['prompt']));
                    }
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        'wf:agentSpec': normalizedAgentSpec,
                        [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true
                    };
                }
                if (node.meta['viewer']) {
                    gnode.args = {
                        ...(gnode.args ?? {}),
                        [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true
                    };
                }
            }
            if (node.kind === 'if') {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    [WorkflowDiagramMetadata.CONDITION_TEXT]: node.meta?.['condition'] ?? undefined,
                    [WorkflowDiagramMetadata.STRUCTURE_CONDITION]: node.meta?.['condition'] ?? undefined
                };
            }
            if (node.kind === 'loop') {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    [WorkflowDiagramMetadata.STRUCTURE_FOREACH]: node.meta?.['iterable'] ?? undefined
                };
            }
            const headerLabelId = `${stableNodeId}_label_name`;
            const subtitle = this.controlSubtitle(node);
            const headerClasses = this.getHeaderCssClasses(node);
            gnode.children!.push(this.createHeaderCompartment(headerLabelId, node.label, subtitle, headerClasses));
            const typeLabel = footerTypeLabel;
            if (typeLabel) {
                gnode.args = {
                    ...(gnode.args ?? {}),
                    'wf:footerTypeLabel': typeLabel
                };
            }
            const mkPort = (port: PyGraphPort, direction: 'input' | 'output', idx: number): GPort => {
                const portId = `${stableNodeId}_port_${port.name}`;
                const x = direction === 'output' ? size.width : -portW;
                const y = yStart + idx * portRowH;
                const labelText = port.name;
                const labelSize = this.estimateLabelSize(labelText, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX);
                const labelBoxWidth = labelSize.width;
                const gport: GPort = {
                    id: portId,
                    type: direction === 'output' ? WorkflowDiagramTypes.PORT_OUTPUT : WorkflowDiagramTypes.PORT_INPUT,
                    position: { x, y },
                    size: { width: portW, height: portH },
                    args: {
                        [WorkflowDiagramMetadata.PORT_NAME]: port.name,
                        [WorkflowDiagramMetadata.PORT_DIRECTION]: direction,
                        [WorkflowDiagramMetadata.PORT_TYPE]: port.type,
                        [WorkflowDiagramMetadata.IS_INPUT_PORT]: direction === 'input',
                        'wf:portRole': port.role
                    },
                    layoutOptions: {
                        'elk.port.side': direction === 'output' ? 'EAST' : 'WEST'
                    }
                };
                gport.cssClasses = [
                    WorkflowDiagramCss.PORT,
                    direction === 'output' ? WorkflowDiagramCss.PORT_OUTPUT : WorkflowDiagramCss.PORT_INPUT
                ];
                if (port.role === 'control') {
                    gport.cssClasses.push('cal-port-control');
                }
                const labelId = `${portId}_label`;
                const label: GModelElement = {
                    id: labelId,
                    type: WorkflowDiagramTypes.LABEL_PORT,
                    text: port.name,
                    cssClasses: [
                        WorkflowDiagramCss.LABEL,
                        'port-label',
                        direction === 'input' ? 'input-port-label' : 'output-port-label'
                    ],
                    position: {
                        x: direction === 'input' ? portW + 1 : -1 - labelBoxWidth,
                        y: Math.round((portH - labelSize.height) / 2)
                    },
                    size: { width: labelBoxWidth, height: labelSize.height },
                    args: {
                        [WorkflowDiagramMetadata.PORT_ID]: portId,
                        [WorkflowDiagramMetadata.PORT_NAME]: port.name,
                        [WorkflowDiagramMetadata.PORT_DIRECTION]: direction,
                        [WorkflowDiagramMetadata.PORT_TYPE]: port.type
                    }
                } as any;
                const portSourceFile = normalizeNavigationFileUri(port.source?.file);
                if (portSourceFile && port.source?.line) {
                    gport.args = {
                        ...(gport.args ?? {}),
                        [WorkflowDiagramMetadata.SOURCE_RANGE]: {
                            start: { line: Math.max(0, port.source.line - 1), character: 0 },
                            end: { line: Math.max(0, port.source.line - 1), character: 0 }
                        },
                        [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: {
                            start: { line: Math.max(0, port.source.line - 1), character: 0 },
                            end: { line: Math.max(0, port.source.line - 1), character: 0 }
                        },
                        [WorkflowDiagramMetadata.REFERENCED_URI]: portSourceFile
                    };
                }
                if (port.role) {
                    label.args = {
                        ...(label.args ?? {}),
                        'wf:portRole': port.role
                    };
                }
                gport.children = [label];
                portIdMap.set(port.id, portId);
                return gport;
            };

            inputs.forEach((p, i) => gnode.children!.push(mkPort(p, 'input', i)));
            outputs.forEach((p, i) => gnode.children!.push(mkPort(p, 'output', i)));

            if (node.kind === 'if' || node.kind === 'loop') {
                const branches = this.createControlBranchPorts(node.id, node.kind);
                if (branches.size > 0) {
                    controlBranchPortMap.set(node.id, branches);
                }
                for (const ports of branches.values()) {
                    const inName = `${ports.branch}_in`;
                    const outName = `${ports.branch}_out`;
                    const gport: GPort = {
                        id: ports.inId,
                        type: WorkflowDiagramTypes.PORT_INPUT,
                        position: { x: -portW, y: yStart + ports.inIndex * portRowH },
                        size: { width: portW, height: portH },
                        args: {
                            [WorkflowDiagramMetadata.PORT_NAME]: inName,
                            [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input',
                            [WorkflowDiagramMetadata.STRUCTURE_BRANCH]: ports.branch,
                            'wf:portRole': 'control'
                        },
                        layoutOptions: {
                            'elk.port.side': 'WEST',
                            'elk.port.index': ports.inIndex
                        }
                    };
                    const gportOut: GPort = {
                        id: ports.outId,
                        type: WorkflowDiagramTypes.PORT_OUTPUT,
                        position: { x: size.width, y: yStart + ports.outIndex * portRowH },
                        size: { width: portW, height: portH },
                        args: {
                            [WorkflowDiagramMetadata.PORT_NAME]: outName,
                            [WorkflowDiagramMetadata.PORT_DIRECTION]: 'output',
                            [WorkflowDiagramMetadata.STRUCTURE_BRANCH]: ports.branch,
                            'wf:portRole': 'control'
                        },
                        layoutOptions: {
                            'elk.port.side': 'EAST',
                            'elk.port.index': ports.outIndex
                        }
                    };
                    gport.cssClasses = [WorkflowDiagramCss.PORT, WorkflowDiagramCss.PORT_INPUT, 'cal-port-control'];
                    gportOut.cssClasses = [WorkflowDiagramCss.PORT, WorkflowDiagramCss.PORT_OUTPUT, 'cal-port-control'];
                    const inLabelSize = this.estimateLabelSize(inName, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX);
                    const outLabelSize = this.estimateLabelSize(outName, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX);
                    gport.children = [
                        {
                            id: `${ports.inId}_label`,
                            type: WorkflowDiagramTypes.LABEL_PORT,
                            text: inName,
                            cssClasses: [WorkflowDiagramCss.LABEL, 'port-label', 'input-port-label'],
                            position: {
                                x: portW + 1,
                                y: Math.round((portH - inLabelSize.height) / 2)
                            },
                            size: { width: inLabelSize.width, height: inLabelSize.height },
                            args: {
                                [WorkflowDiagramMetadata.PORT_ID]: ports.inId,
                                [WorkflowDiagramMetadata.PORT_NAME]: inName,
                                [WorkflowDiagramMetadata.PORT_DIRECTION]: 'input'
                            }
                        } as any
                    ];
                    gportOut.children = [
                        {
                            id: `${ports.outId}_label`,
                            type: WorkflowDiagramTypes.LABEL_PORT,
                            text: outName,
                            cssClasses: [WorkflowDiagramCss.LABEL, 'port-label', 'output-port-label'],
                            position: {
                                x: -1 - outLabelSize.width,
                                y: Math.round((portH - outLabelSize.height) / 2)
                            },
                            size: { width: outLabelSize.width, height: outLabelSize.height },
                            args: {
                                [WorkflowDiagramMetadata.PORT_ID]: ports.outId,
                                [WorkflowDiagramMetadata.PORT_NAME]: outName,
                                [WorkflowDiagramMetadata.PORT_DIRECTION]: 'output'
                            }
                        } as any
                    ];
                    gnode.children!.push(gport, gportOut);
                }
            }
            nodeMap.set(stableNodeId, gnode);
            irNodeToStableId.set(node.id, stableNodeId);
            children.push(gnode);
            if (node.scope) {
                const list = scopeNodes.get(node.scope) ?? [];
                list.push(stableNodeId);
                scopeNodes.set(node.scope, list);
            }

            if (node.kind === 'if' || node.kind === 'loop') {
                const controlScopeIds: string[] = [];
                const scopeInfo = doc.graph.subgraphs ?? [];
                for (const scope of scopeInfo) {
                    if (scope.controlNodeId === node.id) {
                        controlScopeIds.push(scope.id);
                    }
                }
                const ordered = this.orderControlScopes(controlScopeIds, scopeMeta);
                const branches = ordered.map(id => this.createScopeNode(id, scopeMeta, scopeNodes, irNodeToStableId, nodeMap, removedNodeIds));
                gnode.children!.push(...branches);
            }
        }

        for (const edge of doc.graph.edges) {
            const scope = scopeById.get(edge.scope);
            const branch = this.scopeLabel(scope?.kind ?? '');
            const controlNodeId = scope?.controlNodeId ?? undefined;

            let sourceId = portIdMap.get(edge.from) ?? this._edgePortId(edge.from);
            let targetId = portIdMap.get(edge.to) ?? this._edgePortId(edge.to);

            const rawEdgeInfo = this.parseEdgeEndpoints(edge);
            // Boundary ports are addressed through node-based IDs in the IR, which makes
            // parseEndpoint read the boundary label as an entity name unless we normalize it here.
            const edgeInfo = rawEdgeInfo
                ? {
                    ...rawEdgeInfo,
                    ...(boundaryPortIds.has(sourceId) ? { from: 'boundary' } : {}),
                    ...(boundaryPortIds.has(targetId) ? { to: 'boundary' } : {})
                }
                : undefined;

            if (controlNodeId && branch) {
                const branchPorts = controlBranchPortMap.get(controlNodeId);
                if (branchPorts) {
                    const branchPort = branchPorts.get(branch);
                    if (branchPort) {
                        if (edge.from === `port:${controlNodeId}:out`) {
                            sourceId = branchPort.outId;
                        }
                        if (edge.to === `port:${controlNodeId}:out`) {
                            targetId = branchPort.outId;
                        }
                        if (edge.from === `port:${controlNodeId}:iter`) {
                            sourceId = branchPort.inId;
                        }
                    }
                }
            }
            const gedge: GEdge = {
                id: edge.id,
                type: WorkflowDiagramTypes.EDGE_CONNECTION,
                sourceId: sourceId,
                targetId: targetId,
                args: {
                    [WorkflowDiagramMetadata.AST_PATH]: edge.id,
                    'wf:scope': edge.scope,
                    ...(branch ? { [WorkflowDiagramMetadata.STRUCTURE_BRANCH]: branch } : {}),
                    ...(edgeInfo?.from ? { 'wf:from': edgeInfo.from } : {}),
                    ...(edgeInfo?.to ? { 'wf:to': edgeInfo.to } : {}),
                    ...(edgeInfo?.outPort ? { 'wf:outPort': edgeInfo.outPort } : {}),
                    ...(edgeInfo?.inPort ? { 'wf:inPort': edgeInfo.inPort } : {}),
                    ...(edgeInfo?.outPort ? { [WorkflowDiagramMetadata.SOURCE_PORT_NAME]: edgeInfo.outPort } : {}),
                    ...(edgeInfo?.inPort ? { [WorkflowDiagramMetadata.TARGET_PORT_NAME]: edgeInfo.inPort } : {}),
                    ...(normalizeNavigationFileUri(edge.source?.file) && edge.source?.line
                        ? {
                            [WorkflowDiagramMetadata.SOURCE_RANGE]: {
                                start: { line: Math.max(0, edge.source.line - 1), character: 0 },
                                end: { line: Math.max(0, edge.source.line - 1), character: 0 }
                            },
                            [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: {
                                start: { line: Math.max(0, edge.source.line - 1), character: 0 },
                                end: { line: Math.max(0, edge.source.line - 1), character: 0 }
                            },
                            [WorkflowDiagramMetadata.REFERENCED_URI]: normalizeNavigationFileUri(edge.source?.file)
                        }
                        : {})
                }
            };
            // Mark edges the model source flagged (bad direction / type mismatch / cross-scope) so they
            // render red with the message on hover, mirroring the node error treatment.
            const edgeMeta = edge.meta;
            if (edgeMeta && edgeMeta['isErrored'] === true) {
                gedge.cssClasses = [...(gedge.cssClasses ?? []), 'cal-edge-error'];
                (gedge.args as Record<string, unknown>)[WorkflowDiagramMetadata.IS_ERRORED] = true;
                const edgeErrorMessage = edgeMeta['errorMessage'];
                if (typeof edgeErrorMessage === 'string' && edgeErrorMessage.trim() !== '') {
                    (gedge.args as Record<string, unknown>)['wf:errorMessage'] = edgeErrorMessage.trim();
                }
            }
            // Surface the connection's queue capacity so the property panel can
            // show/edit it on the selected edge. Passed through additively.
            const edgeCapacity = edgeMeta?.['capacity'];
            if (typeof edgeCapacity === 'number' && Number.isFinite(edgeCapacity)) {
                (gedge.args as Record<string, unknown>)['wf:capacity'] = edgeCapacity;
            }
            children.push(gedge);
        }

        // After the edges exist and before anything is pruned: which of them
        // send the signal back up the pipeline. Done over the finished model
        // rather than over the IR because a loop belongs to the NODES, and only
        // the model knows which node owns a port — see `feedback-edges.ts`.
        markFeedbackEdges(children);

        // Remove re-parented nodes from root children
        if (removedNodeIds.size > 0) {
            const filtered: GModelElement[] = [];
            for (const child of children) {
                if (removedNodeIds.has(child.id)) {
                    continue;
                }
                filtered.push(child);
            }
            children.length = 0;
            children.push(...filtered);
        }

        const graphArgs: Record<string, unknown> = workflowName
            ? { 'wf:workflowName': workflowName, [WorkflowDiagramMetadata.NETWORK_NAME]: workflowName }
            : {};
        const factoryName = doc.graph.meta?.['factoryName'];
        if (typeof factoryName === 'string' && factoryName.trim() !== '') {
            graphArgs[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] = factoryName.trim();
        }
        const networkParameters = doc.graph.meta?.['parameters'];
        if (networkParameters !== undefined) {
            graphArgs[WorkflowDiagramMetadata.NETWORK_PARAMETERS] = networkParameters;
        }
        if (doc.partial) {
            graphArgs['wf:partial'] = true;
        }
        if (Array.isArray(doc.errors) && doc.errors.length > 0) {
            graphArgs['wf:errors'] = doc.errors;
        }
        if (workflowDefinitionSource) {
            const definitionRange = {
                start: { line: Math.max(0, workflowDefinitionSource.line - 1), character: 0 },
                end: { line: Math.max(0, workflowDefinitionSource.line - 1), character: 0 }
            };
            graphArgs['wf:workflowSourceRange'] = definitionRange;
            if (workflowDefinitionSource.file) {
                graphArgs['wf:workflowSourceUri'] = workflowDefinitionSource.file;
            }
        }
        const graph: GGraph = {
            id: doc.graph.id,
            type: WorkflowDiagramTypes.GRAPH,
            children,
            args: Object.keys(graphArgs).length > 0 ? graphArgs : undefined
        };
        return { graph };
    }

    private estimateLabelSize(text: string, fontSizePx: number = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX): { width: number; height: number } {
        const avgCharWidth = Math.max(5, Math.round(fontSizePx * 0.6));
        const width = Math.max(0, text.length * avgCharWidth);
        const height = Math.max(10, Math.round(fontSizePx * 1.2));
        return { width, height };
    }

    private createScopeNode(
        scopeId: string,
        scopeMeta: Map<string, PyGraphScope>,
        scopeNodes: Map<string, string[]>,
        irNodeToStableId: Map<string, string>,
        nodeMap: Map<string, GNode>,
        removedNodeIds: Set<string>
    ): GNode {
        const scope = scopeMeta.get(scopeId);
        const kind = scope?.kind ?? 'scope';
        const name = this.scopeLabel(kind);
        const nodeId = `scope:${scopeId}`;

        const branchType = kind === 'if-then'
            ? WorkflowDiagramTypes.NODE_STRUCTURE_THEN
            : kind === 'if-else'
                ? WorkflowDiagramTypes.NODE_STRUCTURE_ELSE
                : WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH;

        const node: GNode = {
            id: nodeId,
            type: branchType,
            cssClasses: [WorkflowDiagramCss.NODE, WorkflowDiagramCss.NODE_STRUCTURE, WorkflowDiagramCss.NODE_STRUCTURE_IF_BRANCH],
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                'elk.padding': '[top=18,left=8,bottom=8,right=8]'
            },
            children: [this.createHeaderCompartment(`${nodeId}_label`, name, undefined, ['header-structure'])],
            args: {
                [WorkflowDiagramMetadata.AST_PATH]: nodeId,
                'wf:scopeId': scopeId,
                [WorkflowDiagramMetadata.STRUCTURE_KIND]: kind,
                [WorkflowDiagramMetadata.STRUCTURE_BRANCH]: name
            }
        };

        const memberIds = scope?.nodes ?? [];
        for (const memberIrId of memberIds) {
            const stableId = irNodeToStableId.get(memberIrId);
            if (!stableId) continue;
            const member = nodeMap.get(stableId);
            if (!member) continue;
            node.children!.push(member);
            removedNodeIds.add(stableId);
        }

        return node;
    }

    private scopeLabel(kind: string): string {
        if (kind === 'if-then') return 'then';
        if (kind === 'if-else') return 'else';
        if (kind === 'loop-body') return 'loop';
        return kind;
    }

    private createControlBranchPorts(
        controlNodeId: string,
        kind: string
    ): Map<string, { inId: string; outId: string; inIndex: number; outIndex: number; branch: string }> {
        const ports = new Map<string, { inId: string; outId: string; inIndex: number; outIndex: number; branch: string }>();
        const branchNames = kind === 'if' ? ['then', 'else'] : ['loop'];
        for (let i = 0; i < branchNames.length; i++) {
            const branch = branchNames[i];
            ports.set(branch, {
                inId: `port_${controlNodeId}_${branch}_in`,
                outId: `port_${controlNodeId}_${branch}_out`,
                inIndex: i,
                outIndex: i,
                branch
            });
        }
        return ports;
    }

    private createHeaderCompartment(
        id: string,
        text: string,
        subtitle?: string,
        cssClasses?: string[]
    ): GModelElement {
        const children: GModelElement[] = [
            {
                id: id,
                type: WorkflowDiagramTypes.LABEL_NAME,
                text
            } as any
        ];
        if (subtitle && subtitle.trim()) {
            children.push({
                id: `${id}_subtitle`,
                type: WorkflowDiagramTypes.LABEL_TYPE,
                text: subtitle
            } as any);
        }
        const classes = Array.isArray(cssClasses) && cssClasses.length > 0
            ? cssClasses
            : ['header-task'];
        return {
            id: `${id}_header`,
            type: WorkflowDiagramTypes.COMPARTMENT_HEADER,
            cssClasses: ['header-compartment', ...classes],
            children
        };
    }

    private getHeaderCssClasses(node: PyGraphNode): string[] {
        const classes: string[] = [];
        if (node.kind === 'if' || node.kind === 'loop') {
            classes.push('header-structure');
            return classes;
        }
        if (this.isNetworkInstanceNode(node)) {
            classes.push('header-workflow');
        } else if (this.isExternalNodeKind(node.kind)) {
            classes.push('header-external');
        } else {
            classes.push('header-task');
        }
        const defAnnots = node.meta?.['definitionAnnotations'] as Array<{ name?: string }> | undefined;
        const annots = Array.isArray(defAnnots) ? defAnnots : undefined;
        const hasTool = annots?.some(a => a?.name === 'tool') ?? false;
        const hasAgent = annots?.some(a => a?.name === 'agent') ?? false;
        const hasViewer = annots?.some(a => a?.name === 'viewer') ?? false;
        if (hasTool) classes.push('external-actor-exec');
        if (hasAgent) classes.push('external-actor-agent');
        if (hasViewer) classes.push('external-actor-viewer');
        if (!hasTool && !hasAgent && !hasViewer && this.isExternalNodeKind(node.kind)) {
            classes.push('external-actor-default');
        }
        return classes;
    }


    private getNodeCssClasses(node: PyGraphNode): string[] {
        const classes: string[] = [WorkflowDiagramCss.NODE];
        if (this.isNetworkInstanceNode(node)) {
            classes.push(WorkflowDiagramCss.NODE_NETWORK, 'network-node');
        } else if (this.isExternalNodeKind(node.kind)) {
            classes.push(WorkflowDiagramCss.NODE_EXTERNAL_ACTOR, 'external-actor-node');
            const defAnnots = node.meta?.['definitionAnnotations'] as Array<{ name?: string }> | undefined;
            const annots = Array.isArray(defAnnots) ? defAnnots : undefined;
            const hasTool = annots?.some(a => a?.name === 'tool') ?? false;
            const hasAgent = annots?.some(a => a?.name === 'agent') ?? false;
            const hasViewer = annots?.some(a => a?.name === 'viewer') ?? false;
            if (hasTool) classes.push('external-actor-exec');
            if (hasAgent) classes.push('external-actor-agent');
            if (hasViewer) classes.push('external-actor-viewer');
            if (!hasTool && !hasAgent && !hasViewer) {
                classes.push('external-actor-default');
            }
        } else {
            classes.push(WorkflowDiagramCss.NODE_ACTOR, 'actor-node');
        }
        return classes;
    }

    private controlSubtitle(node: PyGraphNode): string | undefined {
        if (node.kind === 'if') {
            const cond = node.meta?.['condition'];
            return cond ? String(cond) : undefined;
        }
        if (node.kind === 'loop') {
            const iterable = node.meta?.['iterable'];
            return iterable ? String(iterable) : undefined;
        }
        return undefined;
    }

    private annotationArgs(value: unknown): Array<{ name?: string; value?: string }> {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const result: Array<{ name?: string; value?: string }> = [];
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                result.push({ name: String(k), value: this.annotationArgValue(v) });
            }
            return result;
        }
        if (typeof value === 'string') {
            return [{ value }];
        }
        if (typeof value === 'boolean') {
            return [{ value: value ? 'true' : 'false' }];
        }
        return [];
    }

    private annotationArgValue(value: unknown): string {
        if (Array.isArray(value) || (value && typeof value === 'object')) {
            return JSON.stringify(value);
        }
        return String(value);
    }

    private wfStringLiteral(value: string): string {
        const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return `"${escaped}"`;
    }

    private createBoundaryNode(node: PyGraphNode, stableNodeId: string): GNode {
        const port = node.ports[0];
        const isInput = node.kind === 'wf-input';
        const size = { width: 120, height: 50 };
        const portId = `${stableNodeId}_port_${port?.name ?? 'Port'}`;
        const p: GPort = {
            id: portId,
            type: isInput ? WorkflowDiagramTypes.PORT_OUTPUT : WorkflowDiagramTypes.PORT_INPUT,
            cssClasses: [WorkflowDiagramCss.PORT],
            position: { x: isInput ? size.width : -8, y: 22 },
            size: { width: 8, height: 6 },
            args: {
                [WorkflowDiagramMetadata.PORT_NAME]: port?.name ?? '',
                [WorkflowDiagramMetadata.PORT_DIRECTION]: isInput ? 'output' : 'input'
            },
            layoutOptions: { 'elk.port.side': isInput ? 'EAST' : 'WEST' }
        };

        const typeText = port?.type ?? '';
        return {
            id: stableNodeId,
            type: isInput ? WorkflowDiagramTypes.NODE_BOUNDARY_INPUT : WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT,
            cssClasses: [WorkflowDiagramCss.NODE_BOUNDARY, isInput ? WorkflowDiagramCss.NODE_BOUNDARY_INPUT : WorkflowDiagramCss.NODE_BOUNDARY_OUTPUT],
            position: { x: 0, y: 0 },
            size,
            layoutOptions: {
                'elk.portConstraints': 'FIXED_POS',
                'elk.layered.layering.layerConstraint': isInput ? 'FIRST_SEPARATE' : 'LAST_SEPARATE'
            },
            children: [
                {
                    id: `${stableNodeId}_label_name`,
                    type: WorkflowDiagramTypes.LABEL_BOUNDARY_NAME,
                    text: port?.name ?? '',
                    cssClasses: [WorkflowDiagramCss.LABEL, 'boundary-label', 'boundary-label-name'],
                    args: { [WorkflowDiagramMetadata.PORT_NAME]: port?.name ?? '' }
                } as any,
                {
                    id: `${stableNodeId}_label_type`,
                    type: WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE,
                    text: typeText,
                    cssClasses: [WorkflowDiagramCss.LABEL, 'boundary-label', 'boundary-label-type'],
                    args: { [WorkflowDiagramMetadata.PORT_NAME]: port?.name ?? '' }
                } as any,
                p
            ],
            args: {
                [WorkflowDiagramMetadata.AST_PATH]: stableNodeId,
                [WorkflowDiagramMetadata.ENTITY_NAME]: port?.name ?? '',
                [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Port',
                [WorkflowDiagramMetadata.PORT_NAME]: port?.name ?? '',
                [WorkflowDiagramMetadata.PORT_TYPE]: typeText,
                'wf:boundaryKind': isInput ? 'input' : 'output',
                'wf:portName': port?.name ?? ''
            }
        };
    }

    private parseEdgeEndpoints(edge: PyGraphEdge): { from?: string; to?: string; outPort?: string; inPort?: string } | undefined {
        const from = this.parseEndpoint(edge.from);
        const to = this.parseEndpoint(edge.to);
        if (!from || !to) return undefined;
        return {
            from: from.entity ?? 'boundary',
            to: to.entity ?? 'boundary',
            outPort: from.port,
            inPort: to.port
        };
    }

    private parseEndpoint(raw: string): { entity?: string; port?: string } | undefined {
        const cleaned = raw.replace(/^port:/, '');
        const parts = cleaned.split(':');
        if (parts.length < 2) return undefined;
        if (parts[0] === 'wf') {
            if (parts.length >= 4 && (parts[1] === 'input' || parts[1] === 'output')) {
                return { entity: undefined, port: parts[parts.length - 2] };
            }
            return { entity: undefined, port: parts[parts.length - 1] };
        }
        if (parts[0] === 'node') {
            if (parts.length >= 3) {
                const entity = parts[parts.length - 2];
                const port = parts[parts.length - 1];
                return { entity, port };
            }
            return undefined;
        }
        return undefined;
    }

    private orderControlScopes(ids: string[], scopeMeta: Map<string, PyGraphScope>): string[] {
        const order = ['if-then', 'if-else', 'loop-body'];
        return [...ids].sort((a, b) => {
            const ka = scopeMeta.get(a)?.kind ?? '';
            const kb = scopeMeta.get(b)?.kind ?? '';
            return order.indexOf(ka) - order.indexOf(kb);
        });
    }

    private _edgePortId(raw: string): string {
        const cleaned = raw.replace(/^port:/, '');
        const parts = cleaned.split(':');
        if (parts.length >= 2 && parts[0].startsWith('node')) {
            const nodeName = parts[1];
            const portName = parts.slice(2).join(':');
            return `${nodeName}_${portName}`;
        }
        return cleaned.replace(/:/g, '_');
    }

    private nodeType(node: PyGraphNode): string {
        if (this.isNetworkInstanceNode(node)) return WorkflowDiagramTypes.NODE_NETWORK;
        if (this.isExternalNodeKind(node.kind)) return WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR;
        if (node.kind === 'if') return WorkflowDiagramTypes.NODE_STRUCTURE_IF;
        if (node.kind === 'loop') return WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH;
        if (node.kind === 'wf-input') return WorkflowDiagramTypes.NODE_BOUNDARY_INPUT;
        if (node.kind === 'wf-output') return WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
        return WorkflowDiagramTypes.NODE_ACTOR;
    }

    private isNetworkInstanceNode(node: PyGraphNode): boolean {
        if (node.kind === 'workflow') {
            return true;
        }
        return node.meta?.['networkInstance'] === true;
    }

    private isExternalNodeKind(kind: string): boolean {
        return kind === 'external' || kind === 'tool' || kind === 'agent' || kind === 'viewer';
    }
}
