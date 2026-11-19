/**
 * The node list (`node-list.ts`): one family's nodes across a hierarchy,
 * under the instances holding them and no others, each carrying the node as
 * the canvas draws it with the run's tokens on the edges into it.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, type GraphDocument, type HierarchyGraph, type HierarchyOutlineEntry } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { buildNodeList, type NodeListInput } from '../src/server/node-list';

const FAMILIES = [
    { annotation: 'source', color: '#4fa97a' },
    { annotation: 'viewer', color: '#49a6b8' }
];
const SPEC = { family: 'viewer', title: 'Viewers', codicon: 'eye' };
const TOKEN = WorkflowDiagramMetadata.VIEWER_LAST_TOKEN;

const viewer = (name: string) => ({
    id: `node:${name}`, kind: 'viewer', label: name, type: 'HtmlReportViewer', scope: 'root',
    meta: { definitionAnnotations: [{ name: 'viewer', arguments: [{ name: 'inputs', value: '["In"]' }] }] },
    ports: [{ id: `port:node:${name}:In`, name: 'In', direction: 'in' }]
});
const task = (name: string) => ({
    id: `node:${name}`, kind: 'task', label: name, scope: 'root',
    ports: [{ id: `port:node:${name}:Out`, name: 'Out', direction: 'out' }]
});
const docOf = (nodes: any[], edges: any[] = []): GraphDocument =>
    ({ version: '1', graph: { id: 'root', nodes, edges } }) as unknown as GraphDocument;

const graphs: HierarchyGraph[] = [
    {
        path: [], workflowName: 'top', sourceUri: 'file:///w/top.py',
        document: docOf([task('decode'), viewer('report'), { ...task('trace'), kind: 'workflow' }], [
            { id: 'e1', from: 'port:node:decode:Out', to: 'port:node:report:In', scope: 'root' }
        ])
    },
    { path: ['trace'], workflowName: 'trace_project', sourceUri: 'file:///w/trace.py', document: docOf([task('a'), viewer('plot')]) },
    { path: ['quiet'], workflowName: 'quiet', document: docOf([task('b')]) }
];
const hierarchy: HierarchyOutlineEntry = {
    path: [], workflowName: 'top', sourceUri: 'file:///w/top.py',
    children: [
        { path: ['quiet'], workflowName: 'quiet', nodeId: 'node:quiet', children: [] },
        { path: ['trace'], workflowName: 'trace_project', nodeId: 'node:trace', children: [] }
    ]
};
// The canvas's families: the server's own transform is given none, as wfpy-ide's is not.
const transform = (document: GraphDocument) =>
    new GraphGModelSource({} as any).transform(document as unknown as PyGraphDocument).graph as any;
const input = (more: Partial<NodeListInput> = {}): NodeListInput => ({ spec: SPEC, families: FAMILIES, graphs, hierarchy, transform, ...more });

const labels = (entry: HierarchyOutlineEntry): unknown =>
    entry.role === 'node' ? entry.label : { [entry.path.join('/') || '(root)']: entry.children.map(labels) };

describe('a node list', () => {
    it('lists the family\'s nodes under the instances holding them, and no instance without one', () => {
        const list = buildNodeList(input())!;

        expect(list.title).toBe('Viewers');
        expect(list.codicon).toBe('eye');
        expect(labels(list.outline)).toEqual({ '(root)': ['report', { trace: ['plot'] }] });
        const trace = list.outline.children[1];
        expect(trace).toMatchObject({ workflowName: 'trace_project', nodeId: 'node:trace', sourceUri: 'file:///w/trace.py' });
    });

    it('makes each a node row, found in its view by the producer\'s id', () => {
        const plot = buildNodeList(input())!.outline.children[1].children[0];

        expect(plot).toMatchObject({ role: 'node', path: ['trace', 'plot'], nodeId: 'node:plot', family: 'viewer', label: 'plot' });
        expect(plot.detachedNode?.type).toBe('node:external-actor');
        expect(plot.detachedNode?.args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]).toBeDefined();
    });

    it('carries the edges into the node with the run\'s token, and the run\'s arguments', () => {
        const list = buildNodeList(input({
            tokenOf: () => ({ token: '/runs/1/report.html' }),
            rootArgs: { 'wf:viewerOverlayRunId': 'run-1' }
        }))!;
        const report = list.outline.children[0].detachedNode!;

        expect(report.edges).toHaveLength(1);
        // The edge ends at one of the viewer's ports, as the opener looks it up.
        expect(report.edges[0].targetId).toBe(`${report.id}_port_In`);
        expect(report.edges[0].args?.[TOKEN]).toBe('/runs/1/report.html');
        // The run's arguments once, for every node's root.
        expect(list.rootArgs).toEqual({ 'wf:viewerOverlayRunId': 'run-1' });
    });

    it('carries no token without a run', () => {
        const list = buildNodeList(input())!;

        expect(list.outline.children[0].detachedNode!.edges[0].args?.[TOKEN]).toBeUndefined();
        expect(list.rootArgs).toBeUndefined();
    });

    it('is none for a hierarchy without the family\'s nodes', () => {
        expect(buildNodeList(input({ spec: { ...SPEC, family: 'nothing' } }))).toBeUndefined();
        expect(buildNodeList(input({ graphs: graphs.slice(1) }))).toBeUndefined();
    });

    it('places an instance the outline lacks from the graphs\' paths', () => {
        expect(labels(buildNodeList(input({ hierarchy: undefined }))!.outline)).toEqual({ '(root)': ['report', { trace: ['plot'] }] });
    });

    it('transforms an export\'s document once, however often the list is built, and one without the family not at all', () => {
        const transformed: string[] = [];
        const counted = (document: GraphDocument) => {
            transformed.push((document.graph as any).nodes.map((node: any) => node.label).join(','));
            return transform(document);
        };
        const own = graphs.map(graph => ({ ...graph, document: { ...graph.document } }));
        buildNodeList(input({ graphs: own, transform: counted }));
        buildNodeList(input({ graphs: own, transform: counted, tokenOf: () => ({ token: 'x' }) }));

        // The root and `trace`; `quiet` names no viewer.
        expect(transformed).toEqual(['decode,report,trace', 'a,plot']);
    });

    it('tries a document that cannot be transformed once, and lists the others', () => {
        let tries = 0;
        const own = graphs.map(graph => ({ ...graph, document: { ...graph.document } }));
        const failing = (document: GraphDocument) => {
            if (document === own[1].document) {
                tries++;
                throw new Error('no');
            }
            return transform(document);
        };
        const first = buildNodeList(input({ graphs: own, transform: failing }))!;
        buildNodeList(input({ graphs: own, transform: failing }));

        expect(tries).toBe(1);
        expect(labels(first.outline)).toEqual({ '(root)': ['report'] });
    });

    it('is none when the product has no such family', () => {
        expect(buildNodeList(input({ families: [] }))).toBeUndefined();
    });
});
