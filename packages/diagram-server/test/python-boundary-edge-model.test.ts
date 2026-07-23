import { describe, expect, it } from 'vitest';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

describe('GraphGModelSource boundary edge encoding', () => {
    it('uses the boundary port name instead of wf input direction markers', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'wf:input:trace_json',
                        kind: 'wf-input',
                        label: 'trace_json',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:wf:input:trace_json:out',
                                name: 'trace_json',
                                direction: 'out'
                            }
                        ]
                    },
                    {
                        id: 'node:trace_gen',
                        kind: 'tool',
                        label: 'trace_gen',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:trace_gen:json_trace',
                                name: 'json_trace',
                                direction: 'in'
                            }
                        ]
                    }
                ],
                edges: [
                    {
                        id: 'edge:trace-json-in',
                        from: 'port:wf:input:trace_json:out',
                        to: 'port:node:trace_gen:json_trace',
                        scope: 'root'
                    }
                ]
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const edge = result.graph.children?.find(child => child.id === 'edge:trace-json-in');

        expect(edge?.args?.['wf:from']).toBe('boundary');
        expect(edge?.args?.['wf:outPort']).toBe('trace_json');
        expect(edge?.args?.['wf:to']).toBe('trace_gen');
        expect(edge?.args?.['wf:inPort']).toBe('json_trace');
    });

    it('uses the boundary port name instead of wf output direction markers', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node:weight_gen',
                        kind: 'tool',
                        label: 'weight_gen',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:weight_gen:weights',
                                name: 'weights',
                                direction: 'out'
                            }
                        ]
                    },
                    {
                        id: 'wf:output:weights',
                        kind: 'wf-output',
                        label: 'weights',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:wf:output:weights:in',
                                name: 'weights',
                                direction: 'in'
                            }
                        ]
                    }
                ],
                edges: [
                    {
                        id: 'edge:weights-out',
                        from: 'port:node:weight_gen:weights',
                        to: 'port:wf:output:weights:in',
                        scope: 'root'
                    }
                ]
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const edge = result.graph.children?.find(child => child.id === 'edge:weights-out');

        expect(edge?.args?.['wf:from']).toBe('weight_gen');
        expect(edge?.args?.['wf:outPort']).toBe('weights');
        expect(edge?.args?.['wf:to']).toBe('boundary');
        expect(edge?.args?.['wf:inPort']).toBe('weights');
    });

    it('normalizes output-boundary edge endpoints to boundary instead of the boundary node label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node:weight_gen',
                        kind: 'tool',
                        label: 'weight_gen',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:weight_gen:weights',
                                name: 'weights',
                                direction: 'out'
                            }
                        ]
                    },
                    {
                        id: 'node:wf-output:weights',
                        kind: 'wf-output',
                        label: 'weights',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:weights:weights',
                                name: 'weights',
                                direction: 'in'
                            }
                        ]
                    }
                ],
                edges: [
                    {
                        id: 'edge:weights-out',
                        from: 'port:node:weight_gen:weights',
                        to: 'port:node:weights:weights',
                        scope: 'root'
                    }
                ]
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const edge = result.graph.children?.find(child => child.id === 'edge:weights-out');

        expect(edge?.args?.['wf:from']).toBe('weight_gen');
        expect(edge?.args?.['wf:outPort']).toBe('weights');
        expect(edge?.args?.['wf:to']).toBe('boundary');
        expect(edge?.args?.['wf:inPort']).toBe('weights');
    });

    it('normalizes input-boundary edge endpoints to boundary instead of the boundary node label', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    {
                        id: 'node:wf-input:trace_json',
                        kind: 'wf-input',
                        label: 'trace_json',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:trace_json:trace_json',
                                name: 'trace_json',
                                direction: 'out'
                            }
                        ]
                    },
                    {
                        id: 'node:trace_project',
                        kind: 'workflow',
                        label: 'trace_project',
                        scope: 'root',
                        ports: [
                            {
                                id: 'port:node:trace_project:trace_json',
                                name: 'trace_json',
                                direction: 'in'
                            }
                        ]
                    }
                ],
                edges: [
                    {
                        id: 'edge:trace-json-in',
                        from: 'port:node:trace_json:trace_json',
                        to: 'port:node:trace_project:trace_json',
                        scope: 'root'
                    }
                ]
            }
        };

        const result = new GraphGModelSource().transform(doc);
        const edge = result.graph.children?.find(child => child.id === 'edge:trace-json-in');

        expect(edge?.args?.['wf:from']).toBe('boundary');
        expect(edge?.args?.['wf:outPort']).toBe('trace_json');
        expect(edge?.args?.['wf:to']).toBe('trace_project');
        expect(edge?.args?.['wf:inPort']).toBe('trace_json');
    });
});