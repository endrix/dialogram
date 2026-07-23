/**
 * Binding keys and constants shared between diagram-server and extension packages.
 * Extracted from cal-diagram-glsp-module.ts to break circular imports.
 */

/**
 * Diagram type identifier for Workflow network diagrams.
 * Used by editor provider to match the custom editor viewType.
 */
export const WORKFLOW_DIAGRAM_TYPE = 'cal-network-diagram';

/**
 * Custom key for storing the Workflow network diagram model in ModelState.
 */
export const WORKFLOW_NETWORK_MODEL_KEY = 'calNetworkModel';

/**
 * Metadata for layout persistence / initial layout behavior.
 */
export const WORKFLOW_LAYOUT_PERSISTENCE_KEY = 'calLayoutPersistence';
