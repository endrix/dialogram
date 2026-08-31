/**
 * The wire has to touch the arrow.
 *
 * A boundary port is drawn as a glyph on the wire's axis, and the two halves of
 * that are computed in different processes: the SERVER sizes the node and places
 * the port element the routers anchor to, the CLIENT draws the arrow. Nothing
 * connects them at runtime — if they disagree the wire simply ends somewhere
 * near the arrow instead of on it, which no test would notice and no error would
 * report.
 *
 * So both read `BoundaryPortGeometry`, and this pins the server's half of that
 * agreement: the anchor the routers compute must land exactly where the client
 * puts the arrow's tip. The client's half is held by the compiler — it builds
 * the glyph from the same constants.
 *
 * The old layout is what makes the axis worth asserting: a 50px box with the
 * wire at its vertical centre put the wire in the GAP between the name and the
 * type, running through the middle of the label. The axis is now the name's own
 * line, and the type sits below it, clear of the wire.
 */
import { describe, expect, it } from 'vitest';
import { BoundaryPortGeometry, portAnchor, WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWith(kind: 'wf-input' | 'wf-output'): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{
                id: `wf:${kind}:Com`,
                kind,
                label: 'Com',
                scope: 'root',
                ports: [{
                    id: 'p',
                    name: 'Com',
                    direction: kind === 'wf-input' ? 'out' : 'in',
                    type: 'Commit'
                }]
            }],
            edges: []
        }
    };
}

/** The boundary node and its port, as the server hands them to the client. */
function boundaryOf(kind: 'wf-input' | 'wf-output') {
    const result = new GraphGModelSource().transform(docWith(kind));
    const node: any = result.graph.children?.find((c: any) => c.args?.['wf:boundaryKind'] !== undefined);
    const port: any = node.children?.find((c: any) => c.type?.startsWith('port'));
    expect(port, 'boundary node has no port').toBeDefined();
    // The node sits at the origin until ELK places it, so port positions are
    // already absolute for the purposes of the anchor arithmetic.
    return {
        node,
        anchor: portAnchor({ absolute: port.position, size: port.size, type: port.type })
    };
}

describe('boundary port geometry', () => {
    it('is one row tall, not a box', () => {
        expect(boundaryOf('wf-input').node.size.height).toBe(BoundaryPortGeometry.ROW_PITCH_PX);
    });

    it('anchors the wire on the name line, not the node centre', () => {
        const input = boundaryOf('wf-input');
        const output = boundaryOf('wf-output');

        expect(input.anchor.y).toBe(BoundaryPortGeometry.AXIS_Y_PX);
        expect(output.anchor.y).toBe(BoundaryPortGeometry.AXIS_Y_PX);
        // The distinction the redesign turns on: the old anchor was here.
        expect(input.anchor.y).not.toBe(input.node.size.height / 2);
    });

    it("anchors an input at its arrow's tip, on the node's right edge", () => {
        const { node, anchor } = boundaryOf('wf-input');

        expect(anchor.side).toBe('EAST');
        expect(anchor.x).toBe(node.size.width);
    });

    it("anchors an output where its arrow begins, on the node's left edge", () => {
        const { anchor } = boundaryOf('wf-output');

        expect(anchor.side).toBe('WEST');
        expect(anchor.x).toBe(0);
    });

    it('keeps the type off the wire', () => {
        const G = BoundaryPortGeometry;
        // The name owns the axis; the type's line starts below the name's.
        expect(G.AXIS_Y_PX).toBeLessThan(G.NAME_LINE_HEIGHT_PX);
        expect(G.TYPE_Y_PX).toBeGreaterThan(G.NAME_LINE_HEIGHT_PX);
        expect(G.NAME_LINE_HEIGHT_PX + G.TYPE_LINE_HEIGHT_PX).toBe(G.ROW_PITCH_PX);
    });

    it('leaves a gap between glyph and text on both sides', () => {
        expect(BoundaryPortGeometry.textOffset(true))
            .toBe(BoundaryPortGeometry.SOURCE_ARROW.width + BoundaryPortGeometry.GLYPH_TEXT_GAP_PX);
        // An output's glyph is arrow plus bar, so its text starts further out.
        expect(BoundaryPortGeometry.textOffset(false))
            .toBe(BoundaryPortGeometry.SINK_ARROW.width + BoundaryPortGeometry.SINK_BAR.width
                + BoundaryPortGeometry.GLYPH_TEXT_GAP_PX);
    });

    it('keeps the grab target bigger than the arrow but only one row tall', () => {
        const G = BoundaryPortGeometry;

        expect(G.HIT.width).toBeGreaterThan(G.glyphWidth(false));
        // Not taller than a row: the type line can be hidden at low zoom, and a
        // hit area covering it would move the drag target when it goes.
        expect(G.HIT.height).toBe(G.ROW_PITCH_PX);
    });

    it('still carries the port identity', () => {
        const { node } = boundaryOf('wf-input');

        expect(node.args[WorkflowDiagramMetadata.PORT_NAME]).toBe('Com');
        expect(node.args[WorkflowDiagramMetadata.PORT_TYPE]).toBe('Commit');
    });
});
