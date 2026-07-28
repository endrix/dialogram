/**
 * Workflow GLSP VS Code Server
 * 
 * Provides the GLSP server integration for VS Code using NodeGlspVscodeServer.
 * This handles the communication between the VS Code extension and the GLSP server.
 */

import 'reflect-metadata';

// @ts-ignore - Module resolution issue with Node16, but works at runtime
import { NodeGlspVscodeServer, NodeGlspVscodeServerOptions } from '@eclipse-glsp/vscode-integration/node';
import type { BaseGLSPClient } from '@eclipse-glsp/protocol';
import type { ContainerModule } from 'inversify';
import { createWorkflowServerModules } from './server-module';
import { createSessionGatedGlspClient } from './session-gated-glsp-client';
import type { EditStrategy, DiagramModelSource } from '@dialogram/shared';
import type { StorageRuntimeOptions } from './storage-runtime-options';

/**
 * NodeGlspVscodeServer that gates client→server forwarding on the per-client
 * session. It wraps the in-process GLSP client so an action forwarded before its
 * `initializeClientSession` completes is buffered and flushed (in order) once the
 * session exists, instead of being dropped by the server's
 * "No client session has been initialized" throw. See
 * {@link createSessionGatedGlspClient} for the full rationale.
 */
class SessionGatedNodeGlspVscodeServer extends NodeGlspVscodeServer {
    override createGLSPClient(): BaseGLSPClient {
        return createSessionGatedGlspClient(super.createGLSPClient());
    }
}

/**
 * Options for creating the Workflow GLSP VS Code server
 */
export interface WorkflowGlspVscodeServerOptions extends Partial<Omit<NodeGlspVscodeServerOptions, 'serverModules'>> {
    /** Factory for the graph model source; supplied by the consuming extension (product-neutral core). */
    modelSourceFactory?: () => DiagramModelSource;
    /** Neutral storage runtime options (settings namespace + operation-prefix). */
    storageOptions?: StorageRuntimeOptions;
    /** DI modules the consuming extension contributes (e.g. the language toolkit's model module). */
    additionalServerModules?: ContainerModule[];
    /** Edit strategy passthrough (`read-only` disables writes; an editable strategy carries the
     *  consumer-supplied operation modules that register the source-editing handlers). */
    edits?: EditStrategy;
    /** Build-time library seam: factory for the consumer's OWN GLSP DiagramModule, replacing the
     *  stock one. Valid only in single-bundle (library) consumption — see the field's JSDoc in
     *  server-module.ts and `DiagramProfile.serverDiagramModule`. */
    diagramModuleFactory?: () => unknown;
}

/**
 * Default options for the Workflow GLSP VS Code server
 */
export const DEFAULT_WORKFLOW_SERVER_OPTIONS: Partial<WorkflowGlspVscodeServerOptions> = {
    clientId: 'glsp.workflow',
    clientName: 'workflow'
};

/**
 * Create a Workflow GLSP VS Code server instance.
 * 
 * This creates a NodeGlspVscodeServer configured with the Workflow diagram module,
 * ready to handle GLSP protocol communication within the VS Code extension.
 * 
 * @param options - Server options (clientId, clientName, etc.)
 * @returns Configured NodeGlspVscodeServer
 */
export function createWorkflowGlspVscodeServer(
    options: WorkflowGlspVscodeServerOptions = {}
): NodeGlspVscodeServer {
    const mergedOptions = {
        ...DEFAULT_WORKFLOW_SERVER_OPTIONS,
        ...options
    };

    const server = new SessionGatedNodeGlspVscodeServer({
        clientId: mergedOptions.clientId!,
        clientName: mergedOptions.clientName!,
        serverModules: createWorkflowServerModules({
            modelSourceFactory: mergedOptions.modelSourceFactory,
            storageOptions: mergedOptions.storageOptions,
            additionalServerModules: mergedOptions.additionalServerModules,
            edits: mergedOptions.edits,
            diagramModuleFactory: mergedOptions.diagramModuleFactory
        })
    });
    return server;
}

export { NodeGlspVscodeServer };
