/**
 * While a read-only view is shown, the page says so, and says what the view
 * still allows; the next editable view takes the marks away. The palette
 * asks the server for the view's own items with each model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { READ_ONLY_VIEW_CLASS, ReadOnlyViewMarker, isReadOnlyView, viewEditClass } from '../src/read-only-view';
import { ViewToolPalette } from '../src/view-tool-palette';

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

    it('has the palette asked for the items of the view shown each time the model changes', async () => {
        // The server answers per view (what it still allows, and no more):
        // the palette asks again after every model, as for a dynamic one.
        const palette = new ViewToolPalette() as any;
        await palette.setPaletteItems();
        expect(palette.dynamic).toBe(true);
    });
});
