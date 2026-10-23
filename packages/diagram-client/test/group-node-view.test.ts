/**
 * The group container on the client: registered, drawn as a nested region
 * (a tinted body, a header band carrying the producer's label, a border over
 * both), with the ports its crossing edges pass through drawn as dots on the
 * frame.
 *
 * Read from the sources the way the boundary-symbol test does, since the
 * views need a browser to render.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.resolve(here, '../src', file), 'utf8');
const VIEWS = read('views.ts');
const MODULE = read('stock-views.module.ts');
const CSS = read('diagram-client.css');

describe('the group container', () => {
    it('is registered as a model element with its own view, and so is its boundary port', () => {
        expect(WorkflowDiagramTypes.NODE_GROUP).toBe('node:group');
        expect(WorkflowDiagramTypes.PORT_GROUP_BOUNDARY).toBe('port:group-boundary');
        expect(MODULE).toMatch(/configureModelElement\(context, WorkflowDiagramTypes\.NODE_GROUP, GroupNode, GroupNodeView\)/);
        expect(MODULE).toMatch(/configureModelElement\(context, WorkflowDiagramTypes\.PORT_GROUP_BOUNDARY, GroupBoundaryPort, GroupBoundaryPortView\)/);
    });

    it('draws a body, the header band with the producer’s label, and the border, then the members', () => {
        const view = /export class GroupNodeView[\s\S]*?\n}\n/.exec(VIEWS)?.[0] ?? '';
        expect(view).toContain('WorkflowDiagramMetadata.GROUP_LABEL');
        expect(view).toContain('WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX');
        // Body, then the group's own edges, then the header and the border, then the members.
        const order = ["'group-body': true", 'isEdgeChild).map', "'group-header': true", "'group-frame': true", "'group-label': true", '!isEdgeChild(child)'];
        const positions = order.map(marker => view.indexOf(marker));
        expect(positions.every(position => position >= 0), JSON.stringify(positions)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('draws a piece of an edge that stops on a frame without an arrowhead', () => {
        const rule = /function endsAtBoundaryPort[\s\S]*?\n}\n/.exec(VIEWS)?.[0] ?? '';
        expect(rule).toContain('WorkflowDiagramTypes.PORT_GROUP_BOUNDARY');
    });

    it('styles the body as a tint the edges show through, and the header, border, label and port dot', () => {
        expect(CSS).toMatch(/\.workflow-node-group \.group-body\s*\{[^}]*fill-opacity:\s*0\.0\d/);
        expect(CSS).toMatch(/\.workflow-node-group \.group-header\s*\{[^}]*fill/);
        expect(CSS).toMatch(/\.workflow-node-group \.group-frame\s*\{[^}]*fill:\s*none/);
        expect(CSS).toMatch(/\.workflow-node-group \.group-label\s*\{[^}]*font-size/);
        expect(CSS).toMatch(/\.workflow-group-boundary-port \.group-boundary-dot\s*\{/);
    });
});
