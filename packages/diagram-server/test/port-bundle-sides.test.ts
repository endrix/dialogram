/**
 * A producer may place a port with its bundle rather than by its direction:
 * a handshake's `ready` beside the `valid` and `data` it answers, so the wire
 * between two nodes runs straight instead of looping around both. The port
 * says `side`; the boundary node says `meta.side`. The direction is untouched.
 */
import { describe, expect, it } from 'vitest';
import { BoundaryPortGeometry, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument, type PyGraphNode } from '../src/model/graph-gmodel-source';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';

function transform(nodes: PyGraphNode[]): any[] {
    const doc: PyGraphDocument = { version: '1', graph: { id: 'root', nodes, edges: [] } };
    return new GraphGModelSource().transform(doc).graph.children ?? [];
}

const PORT_W = WorkflowDiagramConstants.PORT_WIDTH_PX;
const ROW_H = WorkflowDiagramConstants.PORT_HEIGHT_PX + WorkflowDiagramConstants.PORT_ROW_VERTICAL_GAP_PX;
const Y0 = WorkflowDiagramConstants.HEADER_HEIGHT_PX + WorkflowDiagramConstants.PORT_AREA_PADDING_PX;

describe('ELK is told the side the producer placed the port on', () => {
    // The configurator's port options are the only side ELK sees. Derived
    // from the direction alone, a west-placed output was routed to as an east
    // port: the wire came around the far side of the margin and crossed the
    // whole node, label and all, to reach the glyph.
    // The transform yields plain objects, so call the port rule directly rather than through `apply`'s instanceof dispatch.
    const elkSide = (port: any): string | undefined => (new WorkflowLayoutConfigurator() as any).portOptions(port)?.['elk.port.side'] as string | undefined;

    it('for an instance port with a side', () => {
        const node = transform([{
            id: 'node:c', kind: 'instance', label: 'c', scope: 'root',
            ports: [
                { id: 'p:c:ready', name: 's_ready', direction: 'out', side: 'west' },
                { id: 'p:c:q', name: 'q', direction: 'out' }
            ]
        }])[0];
        expect(elkSide(node.children.find((c: any) => c.id === 'c_port_s_ready'))).toBe('WEST');
        expect(elkSide(node.children.find((c: any) => c.id === 'c_port_q'))).toBe('EAST');
    });

    it('for a boundary node placed in the other margin', () => {
        const [west, east] = transform([
            { id: 'wf:output:ready', kind: 'wf-output', label: 'ready', scope: 'root', meta: { side: 'west' },
              ports: [{ id: 'p:ready', name: 'ready', direction: 'in' }] },
            { id: 'wf:input:m_ready', kind: 'wf-input', label: 'm_ready', scope: 'root', meta: { side: 'east' },
              ports: [{ id: 'p:m_ready', name: 'm_ready', direction: 'out' }] }
        ]);
        expect(elkSide(west.children.find((c: any) => c.type.startsWith('port')))).toBe('EAST');
        expect(elkSide(east.children.find((c: any) => c.type.startsWith('port')))).toBe('WEST');
    });
});

describe('port side from the producer', () => {
    const consumer: PyGraphNode = {
        id: 'node:c', kind: 'instance', label: 'c', scope: 'root',
        ports: [
            { id: 'p:c:valid', name: 's_valid', direction: 'in', group: 's' },
            { id: 'p:c:ready', name: 's_ready', direction: 'out', group: 's', side: 'west' },
            { id: 'p:c:data', name: 's_data', direction: 'in', group: 's', width: 16 },
            { id: 'p:c:q', name: 'q', direction: 'out' }
        ]
    };

    it('puts an output with side west on the west edge, in the west rows, still an output', () => {
        const node = transform([consumer])[0];
        const ready = node.children.find((c: any) => c.id === 'c_port_s_ready');
        expect(ready.type).toBe(WorkflowDiagramTypes.PORT_OUTPUT);
        expect(ready.args[WorkflowDiagramMetadata.PORT_DIRECTION]).toBe('output');
        expect(ready.args[WorkflowDiagramMetadata.PORT_SIDE]).toBe('WEST');
        expect(ready.args[WorkflowDiagramMetadata.PORT_GROUP]).toBe('s');
        expect(ready.layoutOptions['elk.port.side']).toBe('WEST');
        expect(ready.position).toEqual({ x: -PORT_W, y: Y0 + 1 * ROW_H });
        // Its label reads inward from the west edge, like its neighbours'.
        expect(ready.children[0].position.x).toBe(PORT_W + 1);
        expect(ready.children[0].cssClasses).toContain('input-port-label');
        // The west column is valid, ready, data; the east column is q alone.
        const data = node.children.find((c: any) => c.id === 'c_port_s_data');
        const q = node.children.find((c: any) => c.id === 'c_port_q');
        expect(data.position).toEqual({ x: -PORT_W, y: Y0 + 2 * ROW_H });
        expect(q.position.y).toBe(Y0);
        expect(q.position.x).toBe(node.size.width);
    });

    it('leaves a port without a side exactly as before', () => {
        const node = transform([consumer])[0];
        const valid = node.children.find((c: any) => c.id === 'c_port_s_valid');
        expect(valid.args[WorkflowDiagramMetadata.PORT_SIDE]).toBeUndefined();
        expect(valid.layoutOptions['elk.port.side']).toBe('WEST');
        const q = node.children.find((c: any) => c.id === 'c_port_q');
        expect(q.args[WorkflowDiagramMetadata.PORT_SIDE]).toBeUndefined();
        expect(q.args[WorkflowDiagramMetadata.PORT_GROUP]).toBeUndefined();
        expect(q.layoutOptions['elk.port.side']).toBe('EAST');
    });

    it('sizes the node for the fuller column', () => {
        const [node] = transform([consumer]);
        const threeRows = Y0 + 3 * ROW_H - WorkflowDiagramConstants.PORT_ROW_VERTICAL_GAP_PX
            + WorkflowDiagramConstants.PORT_HEIGHT_PX + WorkflowDiagramConstants.PORT_AREA_PADDING_PX;
        expect(node.size.height).toBeGreaterThanOrEqual(threeRows);
    });
});

describe('boundary node placed with its bundle', () => {
    const tready: PyGraphNode = {
        id: 'wf:output:s_axis_tready', kind: 'wf-output', label: 's_axis_tready', scope: 'root',
        ports: [{ id: 'port:wf:output:s_axis_tready:in', name: 's_axis_tready', direction: 'in', group: 's_axis', side: 'east' }],
        meta: { side: 'west' }
    };
    const tdata: PyGraphNode = {
        id: 'wf:output:m_axis_tdata', kind: 'wf-output', label: 'm_axis_tdata', scope: 'root',
        ports: [{ id: 'port:wf:output:m_axis_tdata:in', name: 'm_axis_tdata', direction: 'in' }]
    };

    it('moves an output to the west margin, its port facing the diagram', () => {
        const [node] = transform([tready]);
        expect(node.type).toBe(WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT);
        expect(node.args[WorkflowDiagramMetadata.BOUNDARY_SIDE]).toBe('WEST');
        expect(node.layoutOptions['elk.layered.layering.layerConstraint']).toBe('FIRST_SEPARATE');
        const port = node.children.find((c: any) => c.type === WorkflowDiagramTypes.PORT_INPUT);
        expect(port.args[WorkflowDiagramMetadata.PORT_DIRECTION]).toBe('input');
        expect(port.args[WorkflowDiagramMetadata.PORT_SIDE]).toBe('EAST');
        expect(port.layoutOptions['elk.port.side']).toBe('EAST');
        expect(port.position.x).toBe(node.size.width - BoundaryPortGeometry.glyphWidth(false));
    });

    it('is placed in the first layer by the configurator, and an ordinary output in the last', () => {
        const [moved, plain] = transform([tready, tdata]);
        const configurator = new WorkflowLayoutConfigurator();
        expect((configurator as any).nodeOptions(moved)['elk.layered.layering.layerConstraint']).toBe('FIRST_SEPARATE');
        expect((configurator as any).nodeOptions(plain)['elk.layered.layering.layerConstraint']).toBe('LAST_SEPARATE');
        expect(plain.args[WorkflowDiagramMetadata.BOUNDARY_SIDE]).toBeUndefined();
        const plainPort = plain.children.find((c: any) => c.type === WorkflowDiagramTypes.PORT_INPUT);
        expect(plainPort.position.x).toBe(0);
        expect(plainPort.args[WorkflowDiagramMetadata.PORT_SIDE]).toBeUndefined();
    });
});
