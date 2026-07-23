export const OPEN_DIAGRAM_ARG = 'cal:openDiagram';
export const NETWORK_NAME_ARG = 'cal:networkName';
export const GRAPH_SOURCE_URI_ARG = 'cal:graphSourceUri';
export const ROOT_WORKFLOW_ARG = 'cal:rootWorkflow';
export const INSTANCE_PATH_ARG = 'cal:instancePath';
export const NAV_TRAIL_ARG = 'wf:navTrail';
export const RUN_ID_ARG = 'wf:runId';

export type CrossFileNavigationTarget = {
    uri: string;
    args: Record<string, unknown>;
};

export function buildCrossFileNavigationTarget(opts: {
    referencedUri: string;
    targetNetworkName: string;
    serializedTrail: string;
    selectedRunId?: string;
    useGraphSourceNavigation: boolean;
    currentSourceUri?: string;
    rootWorkflowName?: string;
    instancePath: string[];
}): CrossFileNavigationTarget {
    return {
        uri: opts.referencedUri,
        args: {
            [OPEN_DIAGRAM_ARG]: true,
            [NETWORK_NAME_ARG]: opts.targetNetworkName,
            [NAV_TRAIL_ARG]: opts.serializedTrail,
            ...(opts.useGraphSourceNavigation && opts.currentSourceUri && opts.rootWorkflowName && opts.instancePath.length > 0
                ? {
                    [GRAPH_SOURCE_URI_ARG]: opts.currentSourceUri,
                    [ROOT_WORKFLOW_ARG]: opts.rootWorkflowName,
                    [INSTANCE_PATH_ARG]: opts.instancePath
                }
                : {}),
            ...(opts.selectedRunId ? { [RUN_ID_ARG]: opts.selectedRunId } : {})
        }
    };
}