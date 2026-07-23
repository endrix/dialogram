import { describe, expect, it } from 'vitest';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource node error flagging', () => {
    it('marks a viewer node with meta.isErrored as cal-node-error (the wfpy partial-graph flag)', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node:scope:root:cp_report',
                    kind: 'viewer',
                    label: 'cp_report',
                    type: 'HtmlReportViewer',
                    scope: 'scope:root',
                    ports: [{ id: 'port-1', name: 'In', direction: 'in' }],
                    meta: {
                        taskKind: 'viewer',
                        isErrored: true,
                        errorMessage: "AttributeError: 'HtmlReportViewer' has no port or attribute 'X'",
                        diagnostics: [{
                            severity: 'error',
                            code: 'unknown_port',
                            message: "AttributeError: 'HtmlReportViewer' has no port or attribute 'X'"
                        }]
                    }
                }],
                edges: []
            }
        };

        const node = new GraphGModelSource().transform(doc).graph.children?.find(c => c.id === 'cp_report');
        expect(node).toBeDefined();
        // Dedicated durable class so the run-overlay glow cleanup (which strips cal-node-error /
        // IS_ERRORED) cannot wipe a static graph-export error.
        expect(node?.cssClasses ?? []).toContain('cal-node-graph-error');
        expect(node?.cssClasses ?? []).not.toContain('cal-node-graph-warning');
        expect(node?.args?.['wf:errorMessage']).toContain("has no port or attribute 'X'");
    });

    it('marks a node with only warning-severity diagnostics as cal-node-graph-warning (degraded, not a hard error)', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [{
                    id: 'node:scope:root:n',
                    kind: 'actor',
                    label: 'n',
                    type: 'A',
                    scope: 'scope:root',
                    ports: [],
                    meta: {
                        taskKind: 'actor',
                        diagnostics: [{ severity: 'warning', code: 'unelaborated', message: 'shown from source; graph elaboration failed' }]
                    }
                }],
                edges: []
            }
        };

        const node = new GraphGModelSource().transform(doc).graph.children?.find(c => c.id === 'n');
        expect(node?.cssClasses ?? []).toContain('cal-node-graph-warning');
        expect(node?.cssClasses ?? []).not.toContain('cal-node-graph-error');
        expect(node?.args?.['wf:errorMessage']).toContain('graph elaboration failed');
    });

    it('marks a broken connection edge (meta.isErrored) as cal-edge-error', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    { id: 'node:scope:root:a', kind: 'task', label: 'a', scope: 'scope:root',
                      ports: [{ id: 'port:node:scope:root:a:Out', name: 'Out', direction: 'out' }] },
                    { id: 'node:scope:root:b', kind: 'viewer', label: 'b', scope: 'scope:root',
                      ports: [{ id: 'port:node:scope:root:b:X', name: 'X', direction: 'in' }] }
                ],
                edges: [{
                    id: 'edge:port:node:scope:root:a:Out->port:node:scope:root:b:X',
                    from: 'port:node:scope:root:a:Out',
                    to: 'port:node:scope:root:b:X',
                    scope: 'scope:root',
                    meta: { isErrored: true, errorMessage: "no port or attribute 'X'" }
                }]
            }
        };

        const edges = new GraphGModelSource().transform(doc).graph.children?.filter(c => c.type?.startsWith('edge:')) ?? [];
        const broken = edges.find(e => e.id.includes(':b:X'));
        expect(broken).toBeDefined();
        expect(broken?.cssClasses ?? []).toContain('cal-edge-error');
    });
});
