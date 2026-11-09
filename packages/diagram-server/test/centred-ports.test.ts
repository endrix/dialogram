/**
 * Ports sit centred on the node's border, a bus port's taller box centred on
 * its row; names sit on the row's whole pixel whatever the box, and a port
 * keeps its own offset from its row when the Free Ports layout reorders a side.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GNode, GPort } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramTypes, portLabelY, portRowOffset } from '@dialogram/shared';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';

const PORT_H = WorkflowDiagramConstants.PORT_HEIGHT_PX;
const BUS = 2 * WorkflowDiagramConstants.PORT_BUS_DOT_RADIUS_PX;

describe('a port name', () => {
    it('sits on the same whole pixel of its row beside a port and beside a bus', () => {
        const labelH = 15;
        const rowTop = 30;
        const besidePort = rowTop + portRowOffset(PORT_H) + portLabelY(PORT_H, labelH);
        const besideBus = rowTop + portRowOffset(BUS) + portLabelY(BUS, labelH);
        expect(besideBus).toBe(besidePort);
        expect(Number.isInteger(besidePort)).toBe(true);
    });
});

describe('ports reordered on a side', () => {
    it('take each other’s rows and keep their own offset from the row', () => {
        const port = (id: string, y: number, height: number): GPort => {
            const p = GPort.builder().id(id).type(WorkflowDiagramTypes.PORT_OUTPUT).position(0, y).size(BUS, height).build();
            p.args = { 'cal:portDirection': 'output' };
            return p;
        };
        // Row 0 holds a bus (its box above the row), row 1 a port.
        const bus = port('bus', 30 + portRowOffset(BUS), BUS);
        const plain = port('plain', 51, PORT_H);
        const node = GNode.builder().id('n').type(WorkflowDiagramTypes.NODE_ACTOR).addChildren(bus, plain).build();
        const engine = new WorkflowElkLayoutEngine(
            () => new (ELK as any)(),
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            { index: { get: () => undefined } } as any
        );
        // ELK puts the port first.
        (engine as any).regridPorts(node, [{ id: 'plain', y: 0 }, { id: 'bus', y: 40 }]);
        expect(plain.position).toEqual({ x: 0, y: 30 });
        expect(bus.position).toEqual({ x: 0, y: 51 + portRowOffset(BUS) });
    });
});
