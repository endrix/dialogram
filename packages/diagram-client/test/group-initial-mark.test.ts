/**
 * The mark of the group a diagram's flow starts in: a filled dot and a short
 * arrow at the top left of the frame, before the title, which moves over by
 * the room the mark takes; alone when the group has no title.
 *
 * The group's view is rendered here, through the package's stub of the GLSP
 * `svg` helper (which gives `{tag, props, children}`), so what is checked is
 * what is drawn and where, not the source that draws it.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GROUP_INITIAL_MARK_ROOM_PX, GROUP_INITIAL_MARK_WIDTH_PX, groupInitialMark, isGroupInitial } from '../src/group-initial-mark';
import { GroupNodeView } from '../src/views';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');

const tagOf = (vnode: any): string => vnode?.sel ?? vnode?.tag;
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const attrsOf = (vnode: any): Record<string, any> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? {};
const textOf = (vnode: any): string => (vnode?.children ?? []).map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');

/** Everything under `vnode`, in the order it is drawn. */
function drawn(vnode: any, out: any[] = []): any[] {
    for (const child of vnode?.children ?? []) {
        if (child && typeof child === 'object') {
            out.push(child);
            drawn(child, out);
        }
    }
    return out;
}

/** The group's frame as its view draws it. */
function frame(args: Record<string, unknown>): any[] {
    // The stub's view has no notion of the viewport: everything is in sight.
    const view: any = Object.assign(new (GroupNodeView as any)(), { isVisible: () => true });
    const node = { id: 'g', position: { x: 0, y: 0 }, size: { width: 190, height: 110 }, args, children: [] };
    return drawn(view.render(node, { renderElement: () => undefined }));
}

const markOf = (elements: any[]): any => elements.find(element => classesOf(element)['group-initial-mark']);
const titleOf = (elements: any[]): any => elements.find(element => classesOf(element)['group-label']);
const INITIAL = { [WorkflowDiagramMetadata.GROUP_INITIAL]: true };
const label = (text: string) => ({ [WorkflowDiagramMetadata.GROUP_LABEL]: text });

describe('the mark of the group the flow starts in', () => {
    it('is read from the group’s argument, and only a plain true counts', () => {
        expect(isGroupInitial({ args: INITIAL })).toBe(true);
        expect(isGroupInitial({ args: { [WorkflowDiagramMetadata.GROUP_INITIAL]: 'true' } })).toBe(false);
        expect(isGroupInitial({ args: { [WorkflowDiagramMetadata.GROUP_INITIAL]: 1 } })).toBe(false);
        expect(isGroupInitial({ args: {} })).toBe(false);
        expect(isGroupInitial({})).toBe(false);
    });

    it('is a dot and a short arrow from a left edge, with a word for the pointer', () => {
        const mark = groupInitialMark(10, 12);
        const parts = drawn(mark);
        const dot = parts.find(part => classesOf(part)['group-initial-dot']);
        const arrow = parts.find(part => classesOf(part)['group-initial-arrow']);

        expect(attrsOf(dot)).toEqual({ cx: 14, cy: 12, r: 4 });
        // The shaft leaves the dot; the head's tip is the mark's right edge.
        expect(attrsOf(arrow).d.startsWith('M18,12 H')).toBe(true);
        expect(attrsOf(arrow).d).toContain(`M${10 + GROUP_INITIAL_MARK_WIDTH_PX},12 `);
        expect(textOf(parts.find(part => tagOf(part) === 'title'))).toBe('Starts here');
        expect(GROUP_INITIAL_MARK_ROOM_PX).toBeGreaterThan(GROUP_INITIAL_MARK_WIDTH_PX);
    });

    it('is drawn before the title of the group, which moves over by its room', () => {
        const plain = frame(label('idle'));
        const marked = frame({ ...label('idle'), ...INITIAL });

        expect(markOf(plain)).toBeUndefined();
        expect(attrsOf(titleOf(plain)).x).toBe(10);
        const mark = markOf(marked);
        const dot = drawn(mark).find(part => classesOf(part)['group-initial-dot']);
        // In the header band, at the place the title has without it.
        expect(attrsOf(dot).cx).toBe(10 + 4);
        expect(attrsOf(dot).cy).toBe(attrsOf(titleOf(marked)).y);
        expect(attrsOf(titleOf(marked)).x).toBe(10 + GROUP_INITIAL_MARK_ROOM_PX);
        // After the frame's border, before the title.
        const order = (name: string): number => marked.findIndex(element => classesOf(element)[name]);
        expect(order('group-frame')).toBeLessThan(order('group-initial-mark'));
        expect(order('group-initial-mark')).toBeLessThan(order('group-label'));
    });

    it('is drawn alone on a group with no title, in the room it keeps for a header', () => {
        const marked = frame({ ...label(''), ...INITIAL });

        expect(titleOf(marked)).toBeUndefined();
        expect(marked.some(element => classesOf(element)['group-header'])).toBe(false);
        const dot = drawn(markOf(marked)).find(part => classesOf(part)['group-initial-dot']);
        expect(attrsOf(dot)).toMatchObject({ cx: 14, cy: 12 });
    });

    it('is not drawn for anything but a plain true', () => {
        for (const value of ['true', 1, false, undefined]) {
            expect(markOf(frame({ ...label('idle'), [WorkflowDiagramMetadata.GROUP_INITIAL]: value })), String(value)).toBeUndefined();
        }
    });

    it('comes after the toggle of an open node’s frame, the title after both', () => {
        const open = { ...label('big'), [WorkflowDiagramMetadata.OPEN_NODE_KEY]: 'big' };
        const plainTitle = attrsOf(titleOf(frame(open))).x;
        const marked = frame({ ...open, ...INITIAL });
        const dot = drawn(markOf(marked)).find(part => classesOf(part)['group-initial-dot']);

        expect(attrsOf(dot).cx - 4).toBe(plainTitle);
        expect(attrsOf(titleOf(marked)).x).toBe(plainTitle + GROUP_INITIAL_MARK_ROOM_PX);
    });

    it('takes its colour from one place, which a product sets', () => {
        expect(CSS).toMatch(/\.workflow-node-group \.group-initial-mark\s*\{[^}]*color:/);
        expect(CSS).toMatch(/\.group-initial-mark \.group-initial-dot\s*\{[^}]*fill: currentColor/);
        expect(CSS).toMatch(/\.group-initial-mark \.group-initial-arrow\s*\{[^}]*stroke: currentColor/);
    });
});
