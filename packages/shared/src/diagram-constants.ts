// Shared constants used by both the GLSP server and the diagram webview client.
// Keep these aligned with the CSS in `src/extension/diagram-client/diagram-client.css`.

export const WorkflowDiagramConstants = {
    // Text sizes (px)
    HEADER_LABEL_FONT_SIZE_PX: 11,
    PORT_LABEL_FONT_SIZE_PX: 12,
    BOUNDARY_NAME_FONT_SIZE_PX: 11,
    BOUNDARY_TYPE_FONT_SIZE_PX: 9,

    // Port label placement/geometry
    PORT_LABEL_GAP_PX: 1,
    // Extra horizontal room in the label box for input labels.
    // Tests and layout assume 6px.
    PORT_LABEL_INPUT_BOX_EXTRA_WIDTH_PX: 6,

    // Node sizing helpers
    HEADER_LABEL_EXTRA_WIDTH_PX: 16,

    // Header height (px) – must match the rendered header in views.ts / HeaderCompartmentView.
    // Used by the server to align port Y positions below the header.
    HEADER_HEIGHT_PX: 24,

    // Vertical padding between the bottom of the header and the top edge of the first port.
    // Using the same value for bottom padding keeps nodes visually symmetric.
    PORT_AREA_PADDING_PX: 6,

    // Port sizing used in the model and client views
    PORT_WIDTH_PX: 9,
    PORT_HEIGHT_PX: 7,
    PORT_CIRCLE_SIZE_PX: 6,

    // Vertical gap between adjacent port rows inside a node.
    // Increasing this improves readability when many ports are present.
    PORT_ROW_VERTICAL_GAP_PX: 14,

    // Port spacing: vertical distance between port centers (= PORT_HEIGHT_PX + PORT_ROW_VERTICAL_GAP_PX).
    // Used for consistent port positioning in both workflow and network diagrams.
    PORT_SPACING_PX: 21,

    // Padding between the port marker and the start of the label box column when
    // computing node width.
    PORT_LABEL_PADDING_PX: 8,

    // Vertical band reserved below a node for its italic type label (the
    // `wf:footerTypeLabel`), when it has one.
    //
    // The label is drawn OUTSIDE the node body — at `height + 4` with a 10px
    // font — but it still occupies space on the canvas. Leaving it out of the
    // node's height made it invisible to everything that reasons about
    // geometry: ELK spaced nodes box-to-box and could drop a label onto the
    // node below, and both edge routers took the same boxes as obstacles, so a
    // route could pass straight through a label.
    //
    // So the height INCLUDES this band, and the client draws the body that much
    // shorter and places the label inside it. The node looks identical; the
    // geometry is now honest.
    NODE_FOOTER_LABEL_GAP_PX: 4,
    NODE_FOOTER_LABEL_FONT_SIZE_PX: 10,
    NODE_FOOTER_LABEL_HEIGHT_PX: 14,
} as const;
