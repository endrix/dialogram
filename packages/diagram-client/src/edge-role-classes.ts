/**
 * The producer's `edge-role-<role>` classes, for a connection's line group.
 *
 * The server puts a connection's role on the edge as a class, and the
 * renderer puts an edge's classes on the outermost group its view draws
 * (`.sprotty-edge`). The line, though, is drawn in the group inside it,
 * `.workflow-edge`, which also carries `selected` and `hover`; a product's
 * stylesheet that styles the line by its role and gives way to selection
 * writes `.workflow-edge.edge-role-x:not(.selected)`, and that matched
 * nothing. The edge views give their line group the role classes too, so
 * both `.sprotty-edge.edge-role-x .workflow-edge` and
 * `.workflow-edge.edge-role-x` reach the line. So does the producer's
 * `edge-tone-<tone>` (`meta.tone`, a warning on this one connection).
 */
export function edgeRoleClasses(edge: { cssClasses?: unknown }): Record<string, boolean> {
    const classes = edge.cssClasses;
    if (!Array.isArray(classes)) {
        return {};
    }
    const roles: Record<string, boolean> = {};
    for (const cls of classes) {
        if (typeof cls === 'string' && (cls.startsWith('edge-role-') || cls.startsWith('edge-tone-'))) {
            roles[cls] = true;
        }
    }
    return roles;
}
