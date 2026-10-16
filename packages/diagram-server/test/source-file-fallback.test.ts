/**
 * A location without a file is in the graph's own file.
 *
 * A hierarchy export of a large netlist repeated one absolute path on every
 * node, port and edge of every graph, a third of the export. A producer may
 * leave the file out where it is the graph's `meta.file`; these pin that the
 * reader puts it back everywhere a location is read, that a location naming
 * another file keeps it, and that a document with every file spelled out, or
 * with no graph file to fall back on, reads exactly as before.
 */

import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GraphGModelSource, resolveSourceFiles, type PyGraphDocument } from '../src/model/graph-gmodel-source';

const OWN = '/rtl/top.sv';
const OWN_URI = 'file:///rtl/top.sv';

function doc(withFile: boolean, locationFile?: string): PyGraphDocument {
    const at = (line: number) => ({ line, ...(locationFile ? { file: locationFile } : {}) });
    return {
        version: '1.1',
        graph: {
            id: 'wf:top',
            meta: withFile ? { file: OWN } : {},
            nodes: [
                {
                    id: 'wf:input:x', kind: 'wf-input', label: 'x', scope: 'scope:root',
                    meta: { source: at(3) },
                    ports: [{ id: 'port:wf:input:x:out', name: 'x', direction: 'out', type: 'logic', source: at(3) }]
                },
                {
                    id: 'node:u', kind: 'instance', label: 'u_add', type: 'adder', scope: 'scope:root',
                    meta: { source: at(10), referencedSource: at(2) },
                    ports: [{ id: 'port:node:u:a', name: 'a', direction: 'in', type: 'logic', source: at(4) }]
                }
            ],
            edges: [
                { id: 'e1', from: 'port:wf:input:x:out', to: 'port:node:u:a', scope: 'scope:root', source: at(11) }
            ]
        }
    };
}

function transform(d: PyGraphDocument): any[] {
    return new GraphGModelSource().transform(d).graph.children ?? [];
}

const uriOf = (element: any): string | undefined => element?.args?.[WorkflowDiagramMetadata.REFERENCED_URI];
const find = (children: any[], id: string): any => {
    for (const child of children) {
        if (child.id === id) {
            return child;
        }
        const nested = find(child.children ?? [], id);
        if (nested) {
            return nested;
        }
    }
    return undefined;
};

describe('a location without a file', () => {
    it('is read in the graph\'s own file: node, port, edge and boundary', () => {
        const children = transform(doc(true));
        const instance = find(children, 'u_add');
        expect(uriOf(instance)).toBe(OWN_URI);
        expect(instance.args[WorkflowDiagramMetadata.SOURCE_RANGE].start.line).toBe(9);
        expect(instance.args[WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE].start.line).toBe(1);
        const port = find(children, 'u_add')?.children?.find((c: any) => c.args?.[WorkflowDiagramMetadata.PORT_NAME] === 'a');
        expect(uriOf(port)).toBe(OWN_URI);
        const edge = children.find(c => c.type?.startsWith('edge'));
        expect(uriOf(edge)).toBe(OWN_URI);
        const boundary = find(children, 'x');
        expect(JSON.stringify(boundary)).toContain(OWN_URI);
    });

    it('keeps a file it names itself', () => {
        const resolved = resolveSourceFiles(doc(true, '/rtl/other.sv'));
        expect(resolved.graph.nodes[1].meta?.['source']).toEqual({ line: 10, file: '/rtl/other.sv' });
        expect(uriOf(find(transform(doc(true, '/rtl/other.sv')), 'u_add'))).toBe('file:///rtl/other.sv');
    });

    it('stays where it is when the graph names no file: no navigation, as before', () => {
        const d = doc(false);
        expect(resolveSourceFiles(d)).toBe(d);
        const instance = find(transform(d), 'u_add');
        expect(uriOf(instance)).toBeUndefined();
    });

    it('returns the same document when nothing was missing, and a new one otherwise, leaving the input alone', () => {
        const complete = doc(true, OWN);
        expect(resolveSourceFiles(complete)).toBe(complete);
        const sparse = doc(true);
        const before = JSON.stringify(sparse);
        const resolved = resolveSourceFiles(sparse);
        expect(resolved).not.toBe(sparse);
        expect(JSON.stringify(sparse)).toBe(before);
        expect(resolved.graph.edges[0].source).toEqual({ line: 11, file: OWN });
    });
});
