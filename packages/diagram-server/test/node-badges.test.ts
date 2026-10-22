/**
 * A producer's badges on a node's header.
 *
 * `meta.badges` becomes badge labels in the header compartment, one per
 * entry, in the producer's order, each carrying its tone as a class, and the
 * node grows to make room for them beside the name. A malformed entry is
 * dropped; a tone the platform does not have falls back to neutral.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { parseBadgesMeta } from '../src/server/graph-load-request-options';

type Element = { id: string; type: string; text?: string; cssClasses?: string[]; args?: Record<string, unknown>; size?: { width: number }; children?: Element[] };

function docWith(meta?: Record<string, unknown>): PyGraphDocument {
    return {
        version: '1',
        graph: {
            id: 'root',
            nodes: [{ id: 'node:a', kind: 'actor', label: 'a', scope: 'scope:root', meta, ports: [] }],
            edges: []
        }
    };
}

const nodeFor = (meta?: Record<string, unknown>): Element =>
    (new GraphGModelSource().transform(docWith(meta)).graph.children as unknown as Element[]).find(e => e.id === 'a')!;

const headerBadges = (node: Element): Element[] =>
    node.children!.find(c => c.type === WorkflowDiagramTypes.COMPARTMENT_HEADER)!.children!
        .filter(c => c.type === WorkflowDiagramTypes.LABEL_BADGE);

describe('badges on a node’s header', () => {
    it('become badge labels in the header, in order, with their tone', () => {
        const node = nodeFor({ badges: [{ text: 'MUST', tone: 'warning' }, { text: 'L1' }, { text: 'draft', tone: 'neutral' }] });

        const badges = headerBadges(node);
        expect(badges.map(b => b.text)).toEqual(['MUST', 'L1', 'draft']);
        expect(badges.map(b => b.cssClasses)).toEqual([['badge-tone-warning'], ['badge-tone-neutral'], ['badge-tone-neutral']]);
        expect(node.args?.[WorkflowDiagramMetadata.BADGES]).toEqual([
            { text: 'MUST', tone: 'warning' }, { text: 'L1', tone: 'neutral' }, { text: 'draft', tone: 'neutral' }
        ]);
    });

    it('widen the node so they sit beside the name', () => {
        const plain = nodeFor();
        const badged = nodeFor({ badges: [{ text: 'MUST' }, { text: 'active' }, { text: 'superseded-by-review' }] });

        expect(badged.size!.width).toBeGreaterThan(plain.size!.width);
    });

    it('are absent, with no badge label and no arg, when the producer lists none', () => {
        const node = nodeFor({});

        expect(headerBadges(node)).toEqual([]);
        expect(node.args?.[WorkflowDiagramMetadata.BADGES]).toBeUndefined();
    });

    it('drop malformed entries and fall back to neutral for a tone the platform lacks', () => {
        expect(parseBadgesMeta([{ text: 'ok', tone: 'loud' }, { text: '   ' }, 'x', null, { tone: 'error' }, { text: 'bad', tone: 'error' }]))
            .toEqual([{ text: 'ok', tone: 'neutral' }, { text: 'bad', tone: 'error' }]);
        expect(parseBadgesMeta([])).toBeUndefined();
        expect(parseBadgesMeta('MUST')).toBeUndefined();
    });
});
