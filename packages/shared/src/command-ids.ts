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
    /**
     * Open a file's diagram, or bring its editor forward (`vscode.openWith`,
     * which takes the focus). With `{ sourceUri, networkName }`, at that
     * graph: in an editor that is open already, the graph is entered as by
     * {@link refreshDiagramModel} with `open: true`. The target is resolved
     * as a text document first, so a source VS Code will not open as text
     * for another reason than its size is refused.
     */
    openDiagram: string;
    openDiagramSplit: string;
    layoutDiagram: string;
    /**
     * Ask a file's diagrams for their models again
     * (`{ sourceUri?, workflowName?, reveal?, open? }`), each for the view it
     * shows. A `workflowName` alone is a hint, taken only by a single
     * editor with no view name on record, and what it draws is not recorded:
     * the next refresh that names none (a save, a view option marked
     * `reload`) is of the editor's default view again.
     *
     * With `open: true` the view named is entered in the file's own editor
     * (the one used last, of two) and recorded as what the editor shows, in
     * place of any view before, so the refreshes after it are of it. No text
     * document is opened and the focus stays where it is: the way to enter a
     * view from a row that is the product's (`DiagramOutline.activate`). The
     * view entered is the editor's root: its crumbs start over at it, with
     * no crumb back to the file's root, and anything else on the argument (a
     * `trail`) is ignored. A product whose views lie below a root and that
     * draws its own page enters them from the page by the diagram's own
     * navigation request, which carries the trail (a model request with
     * `wf:navTrail`, as a drill-down or the platform's outline sends it).
     * The name is not checked (the open commands ask `canOpenSource` first;
     * this asks nothing): one the file does not have is entered and
     * recorded, and every save and view option marked `reload` asks for it
     * again, so it is the caller's to give rightly.
     * Nothing is asked where the file has no editor of its own: with none
     * open, or where it is shown in place inside another file's editor,
     * which a refresh without `open` does reach.
     */
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
