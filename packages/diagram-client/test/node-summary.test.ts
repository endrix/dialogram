/**
 * The drawing of what a node says: the server's lines in the body, under
 * the ports and above the node's lines, a code span in the editor's font
 * without its backticks, drawn only close in; the family's mark gives way.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { nodeSummaryHeight, nodeSummaryOf, renderNodeSummary } from '../src/node-summary';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const CSS = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const attrsOf = (vnode: any): Record<string, any> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? {};
const textOf = (vnode: any): string => typeof vnode === 'string' ? vnode : (vnode?.children ?? []).map(textOf).join('') || vnode?.text || '';

const { SUMMARY_LINE_HEIGHT_PX: LINE, SUMMARY_PADDING_PX: PAD } = WorkflowDiagramConstants;

describe('what a node says', () => {
    it('is read from its argument, and nothing else is taken for it', () => {
        expect(nodeSummaryOf({ args: { [WorkflowDiagramMetadata.NODE_SUMMARY]: ['a', 3, 'b'] } })).toEqual(['a', 'b']);
        expect(nodeSummaryOf({ args: { [WorkflowDiagramMetadata.NODE_SUMMARY]: 'a' } })).toEqual([]);
        expect(nodeSummaryOf({})).toEqual([]);
        expect(nodeSummaryHeight([])).toBe(0);
    });

    it('is a text per line, ending where the body above the lines ends', () => {
        const drawn = renderNodeSummary(['Entering `cpu_state_trap` MUST', 'stop the machine.'], 100);
        expect(drawn).toHaveLength(2);
        const ys = drawn.map(text => attrsOf(text).y);
        expect(ys[1] - ys[0]).toBe(LINE);
        expect(ys[1] + LINE / 2 + PAD).toBe(100);
        expect(attrsOf(drawn[0]).x).toBe(PAD);
        expect(classesOf(drawn[0])).toMatchObject({ 'node-summary': true, 'zoom-detail': true });
    });

    it('draws a code span in its own font, without its backticks', () => {
        const [line] = renderNodeSummary(['Entering `cpu_state_trap` MUST'], 40);
        expect(textOf(line)).toBe('Entering cpu_state_trap MUST');
        const code = (line as any).children.filter((child: any) => classesOf(child)['node-summary-code']);
        expect(code.map(textOf)).toEqual(['cpu_state_trap']);
        expect(CSS).toMatch(/tspan\.node-summary-code\s*\{[^}]*font-family:\s*var\(--vscode-editor-font-family/);
    });

    it('is set at the size the server wraps it at', () => {
        const rule = /text\.node-summary\s*\{([^}]*)\}/.exec(CSS);
        expect(rule).not.toBeNull();
        expect(rule![1]).toContain(`font-size: ${WorkflowDiagramConstants.SUMMARY_FONT_SIZE_PX}px`);
    });

    it('takes the place of the family\'s mark', () => {
        expect(VIEWS).toContain('...(marked && family?.icon');
        expect(VIEWS).toContain('...(marked && family?.image');
        expect(VIEWS).toContain('const marked = summary.length === 0;');
    });
});
