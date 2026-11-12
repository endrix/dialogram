// Shared constants used by both the GLSP server and the diagram webview client.
// Keep these aligned with the CSS in `packages/diagram-client/src/diagram-client.css`.

export const WorkflowDiagramConstants = {
    // Text sizes (px)
    HEADER_LABEL_FONT_SIZE_PX: 11,
    PORT_LABEL_FONT_SIZE_PX: 12,

    // Port label placement/geometry: the gap between a port's dot and its name.
    PORT_LABEL_GAP_PX: 3,

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

    // Vertical gap between adjacent port rows inside a node.
    // Increasing this improves readability when many ports are present.
    PORT_ROW_VERTICAL_GAP_PX: 14,

    // Padding between the port marker and the start of the label box column when
    // computing node width.
    PORT_LABEL_PADDING_PX: 8,

    // A bus port is a dot about a port's own size, with its toggle (+ or −)
    // inside: 10px across, the smallest that keeps the mark legible at 100%
    // (at 9 its arms blur into the ring). Its box is the dot, square, centred
    // on the node's border like every port's, and its name keeps a small
    // inset. A member of an open bus keeps a slot for its rail, so its name
    // sits under the bundle's, one step in.
    PORT_BUS_DOT_RADIUS_PX: 5,
    PORT_BUS_LABEL_INSET_PX: 2,
    PORT_BUS_RAIL_SLOT_PX: 12,

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
    NODE_FOOTER_LABEL_HEIGHT_PX: 14,

    /** The lines of text a producer puts in a node (`meta.lines`): each a band
     *  across the bottom of its body. */
    NODE_LINE_HEIGHT_PX: 16,
    NODE_LINE_FONT_SIZE_PX: 10,
    NODE_LINE_PADDING_PX: 6,
    /** The most of a line that is drawn, in columns of its fixed-width font
     *  (a wide character takes two): the rest is for the property panel. */
    NODE_LINE_MAX_CHARS: 48,
    /** The most lines a node draws. */
    NODE_LINE_MAX_COUNT: 6,

    // Group containers (a producer's `group` scopes), drawn as a nested
    // region: a header band carrying the label on top, the members laid out
    // below it. The server pads the layout by these,
    // the client draws by them and keeps a dragged member inside them, so all
    // three agree on where the inside of a group is.
    GROUP_HEADER_HEIGHT_PX: 24,
    GROUP_PADDING_PX: 14,
    /** The point on a group's frame an edge passes through on its way in or out. */
    GROUP_BOUNDARY_PORT_SIZE_PX: 8,
    /** The loop on a group's frame (edges between the group and its own members). */
    GROUP_LOOP_RADIUS_PX: 14,
    /** Between the band of pinned groups and the diagram under it, and between two pinned groups. */
    GROUP_PIN_GAP_PX: 40,
    /** The least a group is drawn at: one that holds nothing still has a title to show and edges to end at. */
    GROUP_MIN_WIDTH_PX: 140,
    GROUP_MIN_HEIGHT_PX: 66,
} as const;
