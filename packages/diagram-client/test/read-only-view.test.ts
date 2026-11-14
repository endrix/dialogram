/**
 * While a read-only view is shown, the page says so, for the stylesheet to
 * hide the palette's tools; the next editable view takes the mark away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { READ_ONLY_VIEW_CLASS, ReadOnlyViewMarker, isReadOnlyView, viewEditClass } from '../src/read-only-view';
import { readFileSync } from 'node:fs';
import { TRANSITIONS_PALETTE_GROUP } from '@dialogram/shared';

const original = (globalThis as any).document;
let classes: Set<string>;

beforeEach(() => {
    classes = new Set();
    (globalThis as any).document = {
        body: {
            classList: {
                toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name), force),
                contains: (name: string) => classes.has(name)
            }
        }
    };
});

afterEach(() => {
    (globalThis as any).document = original;
});

const readOnlyRoot = { id: 'root', args: { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true } };
const editableRoot = { id: 'root', args: {} };

describe('the read-only view mark', () => {
    it('reads the root', () => {
        expect(isReadOnlyView(readOnlyRoot)).toBe(true);
        expect(isReadOnlyView(editableRoot)).toBe(false);
        expect(isReadOnlyView(undefined)).toBe(false);
    });

    it('follows the view shown, in place', () => {
        const marker = new ReadOnlyViewMarker();
        marker.modelRootChanged(readOnlyRoot);
        expect(classes.has(READ_ONLY_VIEW_CLASS)).toBe(true);
        marker.modelRootChanged(editableRoot);
        expect(classes.has(READ_ONLY_VIEW_CLASS)).toBe(false);
    });

    it('says what the view still allows, and only while it is shown', () => {
        const marker = new ReadOnlyViewMarker();
        marker.modelRootChanged({ id: 'root', args: { [WorkflowDiagramMetadata.READ_ONLY_VIEW]: true, [WorkflowDiagramMetadata.VIEW_EDITS]: ['transition'] } });
        expect([...classes].sort()).toEqual([READ_ONLY_VIEW_CLASS, viewEditClass('transition')].sort());
        marker.modelRootChanged(readOnlyRoot);
        expect([...classes]).toEqual([READ_ONLY_VIEW_CLASS]);
    });

    it('lets the stylesheet show the Transition only in a view that allows drawing one, and nothing else there', () => {
        const css = readFileSync(new URL('../src/diagram-client.css', import.meta.url), 'utf8').replace(/\s+/g, ' ');
        const group = `#${TRANSITIONS_PALETTE_GROUP}`;
        expect(css).toContain(`body:not(.${viewEditClass('transition')}) .tool-palette ${group} { display: none; }`);
        expect(css).toContain(`body.${READ_ONLY_VIEW_CLASS}.${viewEditClass('transition')} .tool-palette .palette-body .tool-group:not(${group}) { display: none; }`);
        expect(css).toContain(`body.${READ_ONLY_VIEW_CLASS}:not(.${viewEditClass('transition')}) .tool-palette .palette-body { display: none; }`);
    });
});
