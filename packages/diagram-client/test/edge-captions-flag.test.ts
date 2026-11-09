/**
 * `clientBehavior.edgeCaptions: false`: nothing is written on a wire.
 *
 * The edge view draws, besides the line, up to four things on the wire: the
 * carried label (a width, a payload type), a run's queue badge and last-token
 * button, and the index labels of a list connection. A product with many
 * wires whose ports already say what they carry turns them all off with one
 * flag. The views need the GLSP runtime to render, so this pins the source:
 * the flag is read once in the edge view and guards each of the four, an
 * index save when it is the bits of a port the wire is.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const EDGE_VIEW = VIEWS.slice(VIEWS.indexOf('export class WorkflowEdgeView'), VIEWS.indexOf('export class WorkflowNoArrowEdgeView'));

describe('edge captions', () => {
    it('are one flag, read in the edge view, on by default', () => {
        expect(EDGE_VIEW).toContain("const captions = clientBehavior().edgeCaptions !== false;");
    });

    it('guard every caption the edge view draws', () => {
        for (const draw of ['this.renderEdgeOpenButton(', 'this.renderEdgeQueueSizeBadge(', 'this.renderEdgeCarriedLabel(']) {
            const at = EDGE_VIEW.indexOf(draw);
            expect(at, draw).toBeGreaterThan(-1);
            expect(EDGE_VIEW.slice(Math.max(0, at - 80), at)).toContain('captions &&');
        }
        // An index is guarded too, unless it is the bits of a port the wire is
        // (`EDGE_SLICE`), which nothing else on the drawing says.
        expect(EDGE_VIEW).toContain('const indexCaptions = captions || edgeArgs?.[WorkflowDiagramMetadata.EDGE_SLICE] === true;');
        expect(EDGE_VIEW).toContain('...(indexCaptions && fromIndexLabel && fromIndexPos');
        expect(EDGE_VIEW).toContain('...(indexCaptions && toIndexLabel && toIndexPos');
    });

    it('leaves the hover tooltip alone', () => {
        expect(EDGE_VIEW).toContain("...(viewerTooltip ? [svg('title', {}, viewerTooltip)] : [])");
    });
});
