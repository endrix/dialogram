/**
 * The group container on the client: registered, drawn as a frame with the
 * producer's label, and styled as a region rather than a node.
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
    it('is registered as a model element with its own view', () => {
        expect(WorkflowDiagramTypes.NODE_GROUP).toBe('node:group');
        expect(MODULE).toMatch(/configureModelElement\(context, WorkflowDiagramTypes\.NODE_GROUP, GroupNode, GroupNodeView\)/);
    });

    it('draws the producer’s label from the metadata the server writes', () => {
        const view = /export class GroupNodeView[\s\S]*?\n}\n/.exec(VIEWS)?.[0] ?? '';
        expect(view).toContain('WorkflowDiagramMetadata.GROUP_LABEL');
        expect(view).toContain("'group-frame': true");
        expect(view).toContain("'group-label': true");
        expect(view).toContain('context.renderChildren(node)');
    });

    it('has its frame and label styled', () => {
        expect(CSS).toMatch(/\.workflow-node-group \.group-frame\s*\{[^}]*stroke-dasharray/);
        expect(CSS).toMatch(/\.workflow-node-group \.group-label\s*\{[^}]*font-size/);
    });
});
