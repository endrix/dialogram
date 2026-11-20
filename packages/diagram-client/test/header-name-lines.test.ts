/**
 * The header draws a name in the lines the server broke it into, and is as
 * tall as they need; the node's body, and the family's mark in it, start
 * under it. The views need the GLSP runtime to render, so the helper is
 * tested on its own and its use is pinned in the header and node views.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { nameLinesOf, nodeHeaderHeight } from '../src/header-name-lines';

const here = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const lines = ['Q-003: an undecoded instruction', 'hangs when `CATCH_ILLINSN` is off', 'and a co-processor is present'];

describe('a name in its header', () => {
    it('is the server\'s lines when it broke the name, else the text', () => {
        expect(nameLinesOf({ text: lines.join(' '), args: { [WorkflowDiagramMetadata.HEADER_LINES]: lines } })).toEqual(lines);
        expect(nameLinesOf({ text: 'A trap is a halt' })).toEqual(['A trap is a halt']);
        expect(nameLinesOf({ text: 'x', args: { [WorkflowDiagramMetadata.HEADER_LINES]: 'not lines' } })).toEqual(['x']);
    });

    it('makes the header a line taller for each line past the first', () => {
        const node = (args?: Record<string, unknown>) => ({
            children: [{ type: WorkflowDiagramTypes.COMPARTMENT_HEADER, children: [{ type: WorkflowDiagramTypes.LABEL_NAME, text: 'n', args }] }]
        });
        expect(nodeHeaderHeight(node())).toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX);
        expect(nodeHeaderHeight(node({ [WorkflowDiagramMetadata.HEADER_LINES]: lines })))
            .toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX + 2 * WorkflowDiagramConstants.HEADER_LINE_HEIGHT_PX);
        expect(nodeHeaderHeight({})).toBe(WorkflowDiagramConstants.HEADER_HEIGHT_PX);
    });
});

describe('the views', () => {
    it('draw the name\'s lines, one tspan each, in a header as tall as they need', () => {
        expect(views).toContain('nameLinesOf(nameLabel');
        expect(views).toContain('headerHeight(nameLines.length)');
        expect(views).toMatch(/svg\('tspan'/);
    });

    it('centre the family\'s mark in the body under that header', () => {
        expect(views).toContain('nodeHeaderHeight(node');
        expect(views).toContain('markFits(openHeight, headerH)');
    });
});
