/**
 * The mark of the group where the diagram's flow starts: a filled dot before
 * the group's title, drawn by the group's view in its header band, the title
 * moved over by the room the dot takes.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { GROUP_START_MARK_RADIUS_PX, GROUP_START_MARK_ROOM_PX, groupStartMark, isGroupStart } from '../src/group-start-mark';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const CSS = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');
const GROUP_VIEW = /export class GroupNodeView[\s\S]*?\n}\n/.exec(VIEWS)?.[0] ?? '';

// The GLSP `svg` helper gives `{tag, props, children}` here, snabbdom vnodes in a browser.
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const attrsOf = (vnode: any): Record<string, any> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? {};

describe('the mark of the group where the flow starts', () => {
    it('is read from the group’s argument, and only a true one counts', () => {
        expect(isGroupStart({ args: { [WorkflowDiagramMetadata.GROUP_START]: true } })).toBe(true);
        expect(isGroupStart({ args: { [WorkflowDiagramMetadata.GROUP_START]: 'true' } })).toBe(false);
        expect(isGroupStart({ args: {} })).toBe(false);
        expect(isGroupStart({})).toBe(false);
    });

    it('is a filled dot whose left edge is where the title would start', () => {
        const mark = groupStartMark(10, 12);

        expect(classesOf(mark)).toEqual({ 'group-start-mark': true });
        expect(attrsOf(mark)).toEqual({ cx: 10 + GROUP_START_MARK_RADIUS_PX, cy: 12, r: GROUP_START_MARK_RADIUS_PX });
        expect(GROUP_START_MARK_ROOM_PX).toBeGreaterThan(2 * GROUP_START_MARK_RADIUS_PX);
        expect(CSS).toMatch(/\.workflow-node-group \.group-start-mark\s*\{[^}]*fill:/);
    });

    it('is drawn by the group’s view in its header band, before the title, which moves over', () => {
        // Only a titled group has a band to put it in.
        expect(GROUP_VIEW).toContain('const start = titled && isGroupStart(node as any);');
        expect(GROUP_VIEW).toContain('...(start ? [groupStartMark(titleX, header / 2)] : [])');
        expect(GROUP_VIEW).toContain('x: titleX + (start ? GROUP_START_MARK_ROOM_PX : 0)');
        // Over the header band, under nothing: after the frame, before the members.
        expect(GROUP_VIEW.indexOf('groupStartMark(titleX')).toBeGreaterThan(GROUP_VIEW.indexOf("'group-frame': true"));
        expect(GROUP_VIEW.indexOf('groupStartMark(titleX')).toBeLessThan(GROUP_VIEW.indexOf('!isEdgeChild(child)'));
    });
});
