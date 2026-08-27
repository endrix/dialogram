/**
 * The client's live router and the server's commit router must land on the same
 * anchor, or the edge jumps when the mouse is released. That is now guaranteed
 * by construction — both call the same function — so these tests pin the
 * arithmetic itself, including the fallbacks that used to differ between the
 * server's two copies.
 */
import { describe, expect, it } from 'vitest';
import { portAnchor, portSide, WorkflowDiagramConstants } from '@dialogram/shared';

const W = WorkflowDiagramConstants.PORT_WIDTH_PX;   // 9
const H = WorkflowDiagramConstants.PORT_HEIGHT_PX;  // 7

describe('port anchor', () => {
    it('attaches an output on the east edge, vertically centred', () => {
        expect(portAnchor({
            absolute: { x: 100, y: 200 }, size: { width: 9, height: 7 }, direction: 'output'
        })).toEqual({ x: 109, y: 203.5, side: 'EAST' });
    });

    it('attaches an input on the west edge, vertically centred', () => {
        expect(portAnchor({
            absolute: { x: 100, y: 200 }, size: { width: 9, height: 7 }, direction: 'input'
        })).toEqual({ x: 100, y: 203.5, side: 'WEST' });
    });

    it('falls back to the shared constants when size is missing or zero', () => {
        const missing = portAnchor({ absolute: { x: 0, y: 0 }, direction: 'output' });
        const zero = portAnchor({ absolute: { x: 0, y: 0 }, size: { width: 0, height: 0 }, direction: 'output' });
        expect(missing).toEqual({ x: W, y: H / 2, side: 'EAST' });
        expect(zero).toEqual(missing);
    });

    it('falls back to the type string when direction is absent', () => {
        expect(portSide({ absolute: { x: 0, y: 0 }, type: 'port:output' })).toBe('EAST');
        expect(portSide({ absolute: { x: 0, y: 0 }, type: 'port:input' })).toBe('WEST');
    });

    it('treats an unrecognised direction as an input, like the model default', () => {
        // The server's two copies disagreed here: one consulted the type only
        // when direction was undefined, the other whenever it was unrecognised.
        expect(portSide({ absolute: { x: 0, y: 0 }, direction: 'sideways', type: 'port:output' })).toBe('EAST');
        expect(portSide({ absolute: { x: 0, y: 0 }, direction: 'sideways' })).toBe('WEST');
        expect(portSide({ absolute: { x: 0, y: 0 } })).toBe('WEST');
    });

    it('places anchors exactly PORT_WIDTH_PX outside the node box', () => {
        // The invariant the libavoid router depends on: a west port sits at
        // node.x - 9, an east port at node.x + width. Anything that changes this
        // changes the buffer ceiling in libavoid-router.ts.
        const nodeX = 500, nodeWidth = 216;
        const input = portAnchor({ absolute: { x: nodeX - W, y: 300 }, size: { width: W, height: H }, direction: 'input' });
        const output = portAnchor({ absolute: { x: nodeX + nodeWidth, y: 300 }, size: { width: W, height: H }, direction: 'output' });
        expect(nodeX - input.x).toBe(W);
        expect(output.x - (nodeX + nodeWidth)).toBe(W);
    });
});
