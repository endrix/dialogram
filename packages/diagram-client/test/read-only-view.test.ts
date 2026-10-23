/**
 * While a read-only view is shown, the page says so, for the stylesheet to
 * hide the palette's tools; the next editable view takes the mark away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { READ_ONLY_VIEW_CLASS, ReadOnlyViewMarker, isReadOnlyView } from '../src/read-only-view';

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
});
