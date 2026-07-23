/**
 * Graph payload → GraphDocument normalization.
 *
 * Pure transform lifted verbatim from the model source: normalizes a raw sidecar/CLI graph payload
 * into the neutral `{version, graph: {...}}` `GraphDocument` shape the server's storage consumes.
 */

import type { GraphDocument } from '@dialogram/shared';
import { normalizeGraphLoadErrors } from '@dialogram/diagram-server/server/graph-load-request-options';

/**
 * Normalize a raw sidecar/CLI graph payload into the `{version, graph: {...}}` doc shape the
 * server's `finishLoadFromDoc`/GModel transform consume.
 */
export function graphPayloadToDoc(graphPayload: Record<string, unknown>): GraphDocument {
    const nodesRaw = Array.isArray(graphPayload.nodes) ? graphPayload.nodes : [];
    const edgesRaw = Array.isArray(graphPayload.edges) ? graphPayload.edges : [];
    const scopesRaw = Array.isArray(graphPayload.scopes) ? graphPayload.scopes : [];
    const childrenRaw = Array.isArray(graphPayload.children) ? graphPayload.children : [];
    const graphMetadataSource = typeof graphPayload.metadata === 'object' && graphPayload.metadata && !Array.isArray(graphPayload.metadata)
        ? graphPayload.metadata as Record<string, unknown>
        : typeof graphPayload.meta === 'object' && graphPayload.meta && !Array.isArray(graphPayload.meta)
            ? graphPayload.meta as Record<string, unknown>
            : undefined;
    const graphMeta: Record<string, unknown> = graphMetadataSource
        ? { ...graphMetadataSource }
        : {};
    const graphParameters = graphPayload.parameters
        ?? graphPayload.networkParameters
        ?? graphPayload.workflowParameters;
    if (
        graphParameters !== undefined
        && graphMeta.parameters === undefined
        && (Array.isArray(graphParameters) || (typeof graphParameters === 'object' && graphParameters !== null))
    ) {
        graphMeta.parameters = graphParameters;
    }
    const graphFactoryName = typeof graphPayload.factoryName === 'string' && graphPayload.factoryName.trim() !== ''
        ? graphPayload.factoryName.trim()
        : undefined;
    if (graphFactoryName && graphMeta.factoryName === undefined) {
        graphMeta.factoryName = graphFactoryName;
    }

    const nestedWorkflowByInstance = new Map<string, Record<string, unknown>>();
    for (const child of childrenRaw) {
        if (!child || typeof child !== 'object') {
            continue;
        }
        const instanceName = typeof (child as any).instance === 'string' ? (child as any).instance.trim() : '';
        const childGraph = typeof (child as any).graph === 'object' && (child as any).graph && !Array.isArray((child as any).graph)
            ? (child as any).graph as Record<string, unknown>
            : undefined;
        if (!instanceName || !childGraph) {
            continue;
        }
        nestedWorkflowByInstance.set(instanceName, childGraph);
    }

    const normalizeEntityParameters = (raw: unknown): Array<Record<string, unknown>> | undefined => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return undefined;
        }
        const entries = Object.entries(raw as Record<string, unknown>)
            .filter(([name]) => name.trim() !== '')
            .map(([name, value]) => ({ name, value }));
        return entries.length > 0 ? entries : undefined;
    };

    const normalizeDefinitionParameters = (raw: unknown): Array<Record<string, unknown>> | undefined => {
        const entityParams = normalizeEntityParameters(raw);
        if (!entityParams) {
            return undefined;
        }
        return entityParams.map(param => ({
            name: param.name,
            ...(param.value !== undefined ? { defaultValue: param.value } : {})
        }));
    };

    const nodes = nodesRaw
        .filter((node: any) => node && typeof node === 'object')
        .map((node: any) => {
            const nodeId = String(node.id ?? '');
            const nodeLabel = String(node.label ?? node.id ?? '');
            const nestedWorkflowGraph = nestedWorkflowByInstance.get(nodeId) ?? nestedWorkflowByInstance.get(nodeLabel);
            const metadata = {
                ...(typeof node?.metadata === 'object' && node.metadata ? node.metadata : {}),
                ...(node?.location && typeof node.location === 'object' ? { source: node.location } : {})
            } as Record<string, unknown>;
            if (metadata.parameters === undefined) {
                const nestedParameters = nestedWorkflowGraph?.parameters;
                const kwargsParameters = normalizeEntityParameters(node?.kwargs);
                if (Array.isArray(nestedParameters) || (typeof nestedParameters === 'object' && nestedParameters !== null && !Array.isArray(nestedParameters))) {
                    metadata.parameters = nestedParameters;
                } else if (kwargsParameters) {
                    metadata.parameters = kwargsParameters;
                }
            }
            if (metadata.definitionParams === undefined) {
                const nestedParameters = nestedWorkflowGraph?.parameters;
                if (Array.isArray(nestedParameters)) {
                    metadata.definitionParams = nestedParameters.map((param: any) => ({
                        name: String(param?.name ?? ''),
                        ...(typeof param?.type === 'string' ? { type: param.type } : {}),
                        ...(param?.value !== undefined ? { defaultValue: param.value } : {})
                    })).filter((param: any) => param.name !== '');
                } else {
                    const kwargsDefinitionParams = normalizeDefinitionParameters(node?.kwargs);
                    if (kwargsDefinitionParams) {
                        metadata.definitionParams = kwargsDefinitionParams;
                    }
                }
            }
            if (metadata.factoryName === undefined && typeof nestedWorkflowGraph?.factoryName === 'string' && nestedWorkflowGraph.factoryName.trim() !== '') {
                metadata.factoryName = nestedWorkflowGraph.factoryName.trim();
            }
            if (metadata.referencedEntityName === undefined && typeof nestedWorkflowGraph?.workflow === 'string' && nestedWorkflowGraph.workflow.trim() !== '') {
                metadata.referencedEntityName = nestedWorkflowGraph.workflow.trim();
            }

            return {
                id: nodeId,
                kind: String(node.kind ?? 'actor'),
                label: nodeLabel,
                type: typeof node.type === 'string' ? node.type : undefined,
                scope: String(node.scope ?? 'scope:root'),
                ports: Array.isArray(node.ports)
                ? node.ports.map((port: any) => ({
                    id: String(port?.id ?? ''),
                    name: String(port?.name ?? ''),
                    direction: (port?.direction === 'in' ? 'in' : 'out') as 'in' | 'out',
                    type: typeof port?.type === 'string' ? port.type : undefined,
                    source: port?.location && typeof port.location === 'object'
                        ? {
                            file: typeof port.location.file === 'string' ? port.location.file : undefined,
                            line: typeof port.location.line === 'number' ? port.location.line : undefined
                        }
                        : undefined
                }))
                : [],
                meta: metadata
            };
        });

    const edges = edgesRaw
        .filter((edge: any) => edge && typeof edge === 'object')
        .map((edge: any) => {
            // Edge diagnostics arrive under `metadata` (some runtimes) or `meta` (others); pass them
            // through additively so the model source can mark errored edges.
            const edgeMetaSource = (edge?.metadata && typeof edge.metadata === 'object' && !Array.isArray(edge.metadata))
                ? edge.metadata as Record<string, unknown>
                : (edge?.meta && typeof edge.meta === 'object' && !Array.isArray(edge.meta))
                    ? edge.meta as Record<string, unknown>
                    : undefined;
            return {
                id: String(edge.id ?? ''),
                from: String(edge?.from?.portId ?? ''),
                to: String(edge?.to?.portId ?? ''),
                scope: String(edge.scope ?? 'scope:root'),
                source: edge?.location && typeof edge.location === 'object'
                    ? {
                        file: typeof edge.location.file === 'string' ? edge.location.file : undefined,
                        line: typeof edge.location.line === 'number' ? edge.location.line : undefined
                    }
                    : undefined,
                ...(edgeMetaSource ? { meta: edgeMetaSource } : {})
            };
        });

    const subgraphs = scopesRaw
        .filter((scope: any) => scope && typeof scope === 'object')
        .map((scope: any) => ({
            id: String(scope.id ?? ''),
            kind: String(scope.kind ?? 'network'),
            parent: typeof scope.parent === 'string' ? scope.parent : undefined,
            controlNodeId: typeof scope.controlNodeId === 'string' ? scope.controlNodeId : undefined,
            children: Array.isArray(scope.children) ? scope.children.map((v: any) => String(v)) : undefined,
            nodes: Array.isArray(scope.nodes) ? scope.nodes.map((v: any) => String(v)) : undefined,
            edges: Array.isArray(scope.edges) ? scope.edges.map((v: any) => String(v)) : undefined
        }));

    const graphId = typeof graphPayload.network === 'string' && graphPayload.network.trim() !== ''
        ? `wf:${graphPayload.network.trim()}`
        : 'wf:workflow';
    const graphErrors = normalizeGraphLoadErrors(graphPayload.errors);
    const isPartialGraph = graphPayload.partial === true;

    return {
        version: '1.0',
        ...(isPartialGraph ? { partial: true } : {}),
        ...(graphErrors.length > 0 ? { errors: graphErrors } : {}),
        graph: {
            id: graphId,
            nodes,
            edges,
            subgraphs,
            ...(Object.keys(graphMeta).length > 0 ? { meta: graphMeta } : {})
        }
    };
}
