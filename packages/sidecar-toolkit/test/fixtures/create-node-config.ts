import type { CreateNodeBehavior, CreateNodeStrings } from '../../src/server/sidecar-runtime-config.js';

/**
 * Neutral filler for the create-node config fields these graph-load / model-source suites do not
 * exercise. They construct a {@link SidecarRuntimeConfig} to drive the graph path, which never
 * touches create-node vocabulary or undo labels — but the fields are required, so tests spread
 * this in. Suites that assert create-node behavior supply their own values instead.
 */
export const NEUTRAL_CREATE_NODE_STRINGS: CreateNodeStrings = {
    newTypeNamePrompt: () => 'New class name',
    typeLabel: kind => (kind === 'workflow' ? 'workflow' : 'task'),
    classNamePlaceholder: kind => (kind === 'workflow' ? 'MyWorkflow' : 'MyTask'),
    sidecarDisplayName: 'Test sidecar',
    invalidCapabilitiesResponse: 'invalid capabilities',
    missingCapabilities: ops => `missing: ${ops.join(', ')}`,
    invalidListResponse: (action, field) => `invalid ${action}: ${field}`
};

export const NEUTRAL_CREATE_NODE_BEHAVIOR: CreateNodeBehavior = {
    capabilityProbeBeforeCreate: false,
    mergeProjectDiscoveredTypes: true,
    surfaceSidecarListErrors: false
};

/** Spread into a {@link SidecarRuntimeConfig} literal to satisfy the required create-node fields. */
export const NEUTRAL_CREATE_NODE_CONFIG = {
    undoLabelSuffix: ' (test)',
    createNodeStrings: NEUTRAL_CREATE_NODE_STRINGS,
    createNodeBehavior: NEUTRAL_CREATE_NODE_BEHAVIOR
} as const;
