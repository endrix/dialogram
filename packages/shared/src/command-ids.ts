/**
 * The command ids a diagram profile owns. Members are consumer-owned strings so
 * two installed consumers never collide. Neutral successor of the pre-0.2.0
 * per-extension command-ids type.
 */
/** The product's operation kinds for the two entity-port edits, as the webview dispatches them. */
export interface DiagramOperationKinds {
    createEntityPort: string;
    deleteEntityPort: string;
}

export interface DiagramCommandIds {
    openDiagram: string;
    openDiagramSplit: string;
    layoutDiagram: string;
    refreshDiagramModel: string;
    renameEntityByName: string;
    undo: string;
    redo: string;
    fitToScreen: string;
    center: string;
    exportSvg: string;
    toggleGrid: string;
    setQueueTraceVisible: string;
    stopWorkflow: string;
    runWorkflow: string;
    layoutDiagramIfNeeded: string;
    setAgentToolConfig: string;
    getAgentToolConfig: string;
    /** @deprecated Nothing registers or runs it; accepted and ignored. */
    createAgentToolPolicyFile?: string;
    /** @deprecated Nothing registers or runs it; accepted and ignored. */
    chatAddViewerEditor?: string;
    /** @deprecated Nothing registers or runs it; accepted and ignored. */
    chatAddViewerTask?: string;
    createNewContainer: string;
    /**
     * The launcher: starts an external program on the arguments a viewer
     * gives it, for outputs with no editor in VS Code. A profile without it
     * has no launcher.
     */
    launch?: string;
}
