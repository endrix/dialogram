/**
 * Workflow GLSP Diagram Module
 *
 * Pure re-export facade. The classes that used to live in this file have been
 * split into focused modules (source-model-storage, diagram-action-handlers,
 * diagram-configuration, diagram-module). This file only re-exports the names
 * external code (tests, index.ts, server-module.ts) imports from the
 * historical `diagram-glsp-module` path.
 */

export { WorkflowSourceModelStorage } from './source-model-storage';

export {
    WorkflowModelSubmissionHandler,
    WorkflowRequestModelActionHandler,
    WorkflowComputedBoundsActionHandler,
    WorkflowLayoutOperationHandler
} from './diagram-action-handlers';

export { WorkflowDiagramConfiguration } from './diagram-configuration';

export { WorkflowDiagramModule } from './diagram-module';

// Re-export from shared for backwards compatibility within this package
export { WORKFLOW_DIAGRAM_TYPE, WORKFLOW_NETWORK_MODEL_KEY, WORKFLOW_LAYOUT_PERSISTENCE_KEY } from '@dialogram/shared';
// The relationship/caller types are now neutral seam types living in shared; the source-analysis
// free functions moved to the language toolkit package (behind the DiagramModelSource `analysis`
// seam) and are no longer re-exported from this server barrel.
export { type WorkflowRelationshipInfo, type WorkflowCallerReference } from '@dialogram/shared';
