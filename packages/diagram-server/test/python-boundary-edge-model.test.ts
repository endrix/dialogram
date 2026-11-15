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

    it('reads the ends of an edge whose port ids it cannot parse from the ports\' nodes, a bus end too, and of one from a network port', () => {
        const doc: PyGraphDocument = {
            version: '1',
            graph: {
                id: 'root',
                nodes: [
                    { id: 'wf:in:IN', kind: 'wf-input', label: 'IN', scope: 'root', ports: [{ id: 'wf:in:IN:p:IN', name: 'IN', direction: 'out' }] },
                    { id: 'n:a', kind: 'actor', label: 'a', scope: 'root', ports: [
                        { id: 'n:a:p:In', name: 'In', direction: 'in' },
                        { id: 'n:a:p:Out', name: 'Out', direction: 'out' },
                        { id: 'n:a:p:data:p:0', name: 'data:p:0', direction: 'out' }
                    ] },
                    { id: 'n:adder0', kind: 'actor', label: 'Adder', scope: 'root', ports: [
                        { id: 'n:adder0:p:In', name: 'In', direction: 'in' },
                        { id: 'n:adder0:p:B', name: 'B', direction: 'in' }
                    ] }
                ],
                edges: [
                    { id: 'e:in', from: 'wf:in:IN:p:IN', to: 'n:a:p:In', scope: 'root' },
                    { id: 'e:ab', from: 'n:a:p:Out', to: 'n:adder0:p:In', scope: 'root' },
                    { id: 'e:colon', from: 'n:a:p:data:p:0', to: 'n:adder0:p:B', scope: 'root' },
                    { id: 'e:bus', from: 'bus:n:a:Bundle', to: 'n:adder0:p:B', scope: 'root' }
                ]
            }
        } as PyGraphDocument;

        const result = new GraphGModelSource().transform(doc);
        const ends = (id: string) => {
            const args = result.graph.children?.find(child => child.id === id)?.args ?? {};
            return [args['wf:from'], args['wf:outPort'], args['wf:to'], args['wf:inPort']];
        };
        expect(ends('e:in')).toEqual(['boundary', 'IN', 'a', 'In']);
        // A node by its name, as a connection drawn to it names it.
        expect(ends('e:ab')).toEqual(['a', 'Out', 'Adder', 'In']);
        expect(ends('e:colon')).toEqual(['a', 'data:p:0', 'Adder', 'B']);
        expect(ends('e:bus')).toEqual(['a', 'Bundle', 'Adder', 'B']);
    });
});
