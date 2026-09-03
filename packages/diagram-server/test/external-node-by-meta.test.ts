/**
 * A product's own node kind, rendered without the platform knowing the word.
 *
 * The platform used to decide "is this external?" from a hardcoded list of kind
 * names, which meant every product's vocabulary had to be added to a file in
 * here. It now honours `meta.external`, said by whoever exported the graph —
 * the same idea the exporter already used for `meta.tool` / `meta.agent` /
 * `meta.viewer`, only said plainly.
 *
 * The TYPE is what these assert, not the appearance. `viewer-mouse-listener`
 * refuses to read a node's annotations unless it is `NODE_EXTERNAL_ACTOR`:
 *
 *     if (node.type !== WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR) return [];
 *
 * so a node that does not land there cannot be opened by double-click, and
 * fails silently with nothing logged.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';

function docWith(kind: string, meta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{
                id: 'node:adder',
                kind,
                label: 'adder',
                scope: 'root',
                meta,
                ports: [{ id: 'p', name: 'stimulus', direction: 'in' }]
            }],
            edges: []
        }
    };
}

/**
 * The families a product declares. The platform holds none — `task` and
 * `network` are its own concepts, but a node that is a source or a viewer
 * belongs to a product's taxonomy — so a test that wants one has to say so,
 * exactly as a profile does.
 *
 * Order matters here as it does in a profile: a source carries the openable
 * annotation too, and only the first match decides.
 */
const FAMILIES = [
    { annotation: 'source', color: '#4fa97a' },
    { annotation: 'viewer', color: '#49a6b8' },
    { annotation: 'tool', color: '#b26dff' }
];

const nodeFor = (kind: string, meta?: Record<string, unknown>): any =>
    new GraphGModelSource({ nodeFamilies: FAMILIES } as any)
        .transform(docWith(kind, meta)).graph.children
        ?.find((child: any) => child.id === 'adder');

describe('a product kind the platform has never heard of', () => {
    it('is external because the producer said so, not because it is on a list', () => {
        const node = nodeFor('streamblocks', { external: true });

        expect(node.type).toBe(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
    });

    it('is an ordinary actor without that flag', () => {
        // The control. If this also came back external the assertion above
        // would prove nothing about the flag.
        expect(nodeFor('streamblocks').type).toBe(WorkflowDiagramTypes.NODE_ACTOR);
    });

    it('works for any kind, not one the platform was taught', () => {
        expect(nodeFor('something-nobody-has-written-yet', { external: true }).type)
            .toBe(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
    });

    it('still honours the kinds the platform does know', () => {
        expect(nodeFor('tool').type).toBe(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR);
        expect(nodeFor('internal').type).toBe(WorkflowDiagramTypes.NODE_ACTOR);
    });

    it('gets a styling hook derived from its kind', () => {
        const classes: string[] = nodeFor('streamblocks', { external: true }).cssClasses ?? [];

        // Derived, not enumerated: the platform writes `<kind>-node` for
        // whatever kind it is handed and names no product.
        expect(classes).toContain('streamblocks-node');
        expect(classes).toContain('external-actor-node');
        expect(nodeFor('tool').cssClasses ?? []).toContain('tool-node');
    });
});

/**
 * The body and the header decide "is this external?" separately, and only the
 * body asked the producer. So a node external by `meta.external` got an
 * external body and a TASK header — two colour families on one node — and the
 * per-annotation tint never applied either, because its rule is written under
 * `.header-external`.
 */
describe('the header of a node that is external by meta', () => {
    const headerOf = (kind: string, meta?: Record<string, unknown>): string[] => {
        const node: any = nodeFor(kind, meta);
        const header = (node.children ?? []).find((child: any) =>
            (child.cssClasses ?? []).some((c: string) => c.startsWith('header-')));
        return header?.cssClasses ?? [];
    };

    it('is styled external, like the rest of the node', () => {
        const classes = headerOf('streamblocks', { external: true });

        expect(classes).toContain('header-external');
        expect(classes).not.toContain('header-task');
    });

    it('matches the header a kind-based external node gets', () => {
        expect(headerOf('streamblocks', { external: true })).toEqual(headerOf('tool'));
    });

    /**
     * The tint rules are written as
     * `.external-actor-node.external-actor-viewer .header-external`, so the
     * annotation class alone was never enough.
     */
    it('can be tinted by its annotation', () => {
        const classes = headerOf('source', {
            external: true,
            definitionAnnotations: [{ name: 'viewer' }]
        });

        expect(classes).toContain('header-external');
        expect(classes).toContain('external-actor-viewer');
    });

    it('leaves an ordinary node on the task header', () => {
        // The control: without it the assertions above would pass if every
        // node were simply called external.
        expect(headerOf('internal')).toContain('header-task');
    });
});

/**
 * A source is coloured as itself, not as the thing it is the opposite of.
 *
 * Double-click is driven by an annotation that a source carries too — that one
 * says what opening does, not what the node is. Deriving the colour family from
 * it painted a source in the viewer's accent, so a source and a viewer were
 * indistinguishable but for the icon, at opposite ends of the graph.
 */
describe('the colour family a source node lands in', () => {
    const classesFor = (annotations: Array<{ name: string }>) => {
        const node: any = nodeFor('source', {
            external: true,
            definitionAnnotations: annotations.map(a => ({ ...a, arguments: [] }))
        });
        const header = (node.children ?? []).find((child: any) =>
            (child.cssClasses ?? []).includes('header-compartment'));
        return { node: node.cssClasses ?? [], header: header?.cssClasses ?? [] };
    };

    it('is its own, on the node and the header alike', () => {
        // Both annotations, exactly as the exporter emits them.
        const { node, header } = classesFor([{ name: 'viewer' }, { name: 'source' }]);

        expect(node).toContain('external-actor-source');
        expect(header).toContain('external-actor-source');
    });

    it('is not the viewer family', () => {
        const { node, header } = classesFor([{ name: 'viewer' }, { name: 'source' }]);

        expect(node).not.toContain('external-actor-viewer');
        expect(header).not.toContain('external-actor-viewer');
    });

    it('does not fall through to the unannotated default', () => {
        // Without the guard below the family checks, a source would also be
        // called default and get the dimmed treatment on top of its own.
        const { node } = classesFor([{ name: 'viewer' }, { name: 'source' }]);

        expect(node).not.toContain('external-actor-default');
    });

    /** The control: a real viewer keeps the viewer family. */
    it('leaves an actual viewer in the viewer family', () => {
        const node: any = nodeFor('viewer', {
            definitionAnnotations: [{ name: 'viewer', arguments: [] }]
        });

        expect(node.cssClasses).toContain('external-actor-viewer');
        expect(node.cssClasses).not.toContain('external-actor-source');
        // And not ALSO the unannotated default, which dims the icon — an
        // annotated node landing there is styled as if it had none.
        expect(node.cssClasses).not.toContain('external-actor-default');
    });
});
