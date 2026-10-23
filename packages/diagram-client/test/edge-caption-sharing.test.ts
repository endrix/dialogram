/**
 * `clientBehavior.edgeCaptions: 'once'`: one caption per bundle of edges that
 * leave or reach a port together with the same text.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { captionIsShared, carriedTextOf, edgesWithSharedCaption } from '../src/edge-caption-sharing';

const edge = (id: string, sourceId: string, targetId: string, caption?: string) => ({ id, sourceId, targetId, caption });

describe('captions written once per trunk', () => {
    it('leave out the copies on edges that leave one port together', () => {
        const shared = edgesWithSharedCaption([
            edge('a1', 'a:out', 'x:in', 'depends-on'),
            edge('a2', 'a:out', 'y:in', 'depends-on'),
            edge('a3', 'a:out', 'z:in', 'depends-on')
        ]);
        expect([...shared]).toEqual(['a2', 'a3']);
    });

    it('and on edges that reach one port together', () => {
        const shared = edgesWithSharedCaption([
            edge('ax', 'a:out', 'x:in', 'depends-on'),
            edge('bx', 'b:out', 'x:in', 'depends-on')
        ]);
        expect([...shared]).toEqual(['bx']);
    });

    it('keep a different caption, and an edge alone on its ports', () => {
        const shared = edgesWithSharedCaption([
            edge('dep', 'a:out', 'x:in', 'depends-on'),
            edge('ref', 'a:out', 'y:in', 'references'),
            edge('alone', 'b:out', 'z:in', 'depends-on'),
            edge('none', 'a:out', 'w:in')
        ]);
        expect([...shared]).toEqual([]);
    });

    it('count only the captions actually written', () => {
        // a→y is left out (a's trunk has one); c→y has nothing else written on
        // y's trunk, so it writes its own.
        const shared = edgesWithSharedCaption([
            edge('ax', 'a:out', 'x:in', 'depends-on'),
            edge('ay', 'a:out', 'y:in', 'depends-on'),
            edge('cy', 'c:out', 'y:in', 'depends-on')
        ]);
        expect([...shared]).toEqual(['ay']);
    });

    it('read the caption the edge view writes: the label, else the width', () => {
        expect(carriedTextOf({ [WorkflowDiagramMetadata.EDGE_LABEL]: ' u32 ', [WorkflowDiagramMetadata.EDGE_WIDTH]: 32 })).toBe('u32');
        expect(carriedTextOf({ [WorkflowDiagramMetadata.EDGE_WIDTH]: 8.7 })).toBe('8');
        expect(carriedTextOf({ [WorkflowDiagramMetadata.EDGE_LABEL]: '  ' })).toBeUndefined();
        expect(carriedTextOf(undefined)).toBeUndefined();
    });

    it('decide once per model, for every edge of it', () => {
        const label = (text: string) => ({ [WorkflowDiagramMetadata.EDGE_LABEL]: text });
        const elements: any[] = [
            { id: 'a1', sourceId: 'a:out', targetId: 'x:in', args: label('depends-on') },
            { id: 'a2', sourceId: 'a:out', targetId: 'y:in', args: label('depends-on') },
            { id: 'node-a' }
        ];
        let walks = 0;
        const root = { index: { all: () => (walks++, elements) } };
        for (const element of elements) {
            element.root = root;
        }
        expect(captionIsShared(elements[0])).toBe(false);
        expect(captionIsShared(elements[1])).toBe(true);
        expect(captionIsShared(elements[1])).toBe(true);
        expect(walks).toBe(1);
        // A new model (a new root) is decided afresh.
        const next = { index: { all: () => [{ id: 'a2', sourceId: 'a:out', targetId: 'y:in', args: label('depends-on') }] } };
        expect(captionIsShared({ id: 'a2', root: next })).toBe(false);
    });
});

describe('the edge view', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
    const EDGE_VIEW = VIEWS.slice(VIEWS.indexOf('export class WorkflowEdgeView'), VIEWS.indexOf('export class WorkflowNoArrowEdgeView'));

    it("leaves a shared caption out only under 'once', and says it in the tooltip", () => {
        expect(EDGE_VIEW).toContain("const sharedCaption = clientBehavior().edgeCaptions === 'once' && captionIsShared(edge);");
        expect(EDGE_VIEW).toContain('const carriedWritten = captions && !!carriedText && !sharedCaption;');
        expect(EDGE_VIEW).toContain('carriedText && !carriedWritten ? carriedText : undefined,');
        expect(EDGE_VIEW).toContain('...(captions && carriedText && carriedWritten');
    });
});
