/**
 * Double-clicking a node whose open target is a path it DECLARES.
 *
 * Every other route through the viewer listener resolves its target from the
 * last token on an input, which is right for a node whose target is something
 * it produced — that cannot exist before a run. A node that declares its target
 * is openable immediately, and must not be told to go and run the workflow
 * first.
 *
 * The declared route shipped with no test at all, and it did not work: the
 * empty-`inputs` guard sat above it, so a node with a declared path and no
 * inputs always got "run the workflow first" instead of its file. Producers of
 * this annotation have no inputs by nature, so the route was unreachable for
 * exactly the nodes it was written for.
 */
import { describe, expect, it } from 'vitest';
import { ViewerMouseListener } from '../src/viewer-mouse-listener';
import { WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';

const SOURCE_URI = 'file:///w/flow.py';

interface AnnotationArg {
    name: string;
    value: string;
}

/** A node carrying one `viewer` annotation, as the exporter emits it. */
function nodeWith(args: AnnotationArg[], inputPorts: string[] = []) {
    const node: any = {
        id: 'n1',
        type: WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR,
        args: {
            [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true,
            [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: [
                { name: 'viewer', arguments: args }
            ]
        },
        children: inputPorts.map(name => ({ id: `n1_port_${name}`, type: 'port' })),
        root: { args: {}, children: [] }
    };
    node.root.children = [node];
    return node;
}

function doubleClick(node: unknown, sourceUri: string | undefined = SOURCE_URI): any[] {
    const listener: any = new ViewerMouseListener();
    listener.editorContext = { sourceUri };
    return listener.doubleClick(node, {} as MouseEvent);
}

const declared = (extra: AnnotationArg[] = []): AnnotationArg[] => [
    { name: 'source', value: '"declared"' },
    { name: 'path', value: '"designs/adder.py"' },
    ...extra
];

describe('a declared target with no inputs', () => {
    it('opens the declared path instead of demanding a run', () => {
        const [action] = doubleClick(nodeWith(declared([
            { name: 'action', value: '"openWith"' },
            { name: 'viewType', value: '"product.networkDiagram"' }
        ])));

        expect(action.args['wf:viewerAction']).toBe('openWith');
        expect(action.uri).toBe('file:///w/designs/adder.py');
        expect(action.args['wf:viewerViewType']).toBe('product.networkDiagram');
    });

    it('resolves the path beside the file the diagram came from', () => {
        const [action] = doubleClick(
            nodeWith(declared([{ name: 'viewType', value: '"x"' }])),
            'file:///w/nested/deep/flow.py'
        );

        expect(action.uri).toBe('file:///w/nested/deep/designs/adder.py');
    });

    it('leaves an absolute path alone', () => {
        const [action] = doubleClick(nodeWith([
            { name: 'source', value: '"declared"' },
            { name: 'path', value: '"/abs/designs/adder.py"' },
            { name: 'viewType', value: '"x"' }
        ]));

        expect(action.uri).toBe('/abs/designs/adder.py');
    });

    it('still says what is missing when there is no path', () => {
        const [action] = doubleClick(nodeWith([
            { name: 'source', value: '"declared"' },
            { name: 'viewType', value: '"x"' }
        ]));

        expect(action.args['wf:viewerAction']).toBe('error');
        expect(action.args['wf:viewerMessage']).toMatch(/path/);
    });
});

/**
 * The guard moved rather than went away. Everything that resolves through a
 * token genuinely needs an input to resolve through, and without the guard it
 * would fail later with a worse message — one about a missing token rather than
 * a missing declaration.
 */
describe('a token target still needs inputs', () => {
    it('asks for inputs when the target comes from a token', () => {
        const [action] = doubleClick(nodeWith([{ name: 'action', value: '"open"' }]));

        expect(action.args['wf:viewerAction']).toBe('error');
        expect(action.args['wf:viewerMessage']).toMatch(/inputs/);
    });

    it('asks for inputs for an explicit token source too', () => {
        const [action] = doubleClick(nodeWith([
            { name: 'source', value: '"token"' },
            { name: 'action', value: '"openWith"' },
            { name: 'viewType', value: '"x"' }
        ]));

        expect(action.args['wf:viewerAction']).toBe('error');
        expect(action.args['wf:viewerMessage']).toMatch(/inputs/);
    });

    it('reports a diff needing two inputs, not zero', () => {
        const [action] = doubleClick(nodeWith([
            { name: 'action', value: '"diff"' },
            { name: 'inputs', value: '["only"]' }
        ]));

        expect(action.args['wf:viewerMessage']).toMatch(/2 inputs/);
    });
});
