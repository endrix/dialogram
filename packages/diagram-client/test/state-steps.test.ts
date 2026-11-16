/**
 * A state that folds a long run lists only the first steps of it and a line
 * that says how many more there are; its tooltip lists them all, as the
 * panel does. A short run lists every step.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { STATE_INITIAL_INSET_PX, StateNodeView } from '../src/automaton-views';

// The GLSP `svg` helper gives `{tag, props, children}` here, snabbdom vnodes in a browser.
const classesOf = (vnode: any): Record<string, boolean> => vnode?.data?.class ?? vnode?.props?.class ?? {};
const textOf = (vnode: any): string => (vnode?.children ?? []).map((c: any) => typeof c === 'string' ? c : c?.text ?? '').join('') || vnode?.text || '';

function withClass(vnode: any, name: string): any[] {
    const out: any[] = [];
    const visit = (each: any): void => {
        if (!each || typeof each !== 'object') {
            return;
        }
        if (classesOf(each)[name]) {
            out.push(each);
        }
        (each.children ?? []).forEach(visit);
    };
    visit(vnode);
    return out;
}

describe('a state that folds a long run', () => {
    const k = WorkflowDiagramConstants;
    const steps = Array.from({ length: 18 }, (_, i) => ({ action: `step_${i}`, count: 1 }));
    const view = (): StateNodeView => Object.assign(new StateNodeView(), { isVisible: () => true });
    const drawn = (list: Array<{ action: string; count: number }>): any => view().render({
        id: 'fold', type: WorkflowDiagramTypes.NODE_STATE, position: { x: 0, y: 0 }, size: { width: 200, height: 160 },
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'a … z', [WorkflowDiagramMetadata.STATE_STEPS]: list }
    } as any, { targetKind: 'hidden', renderChildren: () => [] } as any);

    it('draws its first steps and a line that says how many more, and all of them in its tooltip', () => {
        const state = drawn(steps);
        const lines = withClass(state, 'state-step');
        expect(lines.map(textOf)).toEqual([...steps.slice(0, k.STATE_STEPS_SHOWN).map(s => s.action), `… ${18 - k.STATE_STEPS_SHOWN} more`]);
        expect(withClass(state, 'state-steps-more').map(textOf)).toEqual([`… ${18 - k.STATE_STEPS_SHOWN} more`]);
        const title = (state.children ?? []).find((c: any) => c?.sel === 'title' || c?.tag === 'title');
        expect(textOf(title).split('\n')).toEqual(steps.map(s => s.action));
    });

    it('draws every step of a short run, and no tooltip', () => {
        const state = drawn(steps.slice(0, 3));
        expect(withClass(state, 'state-step').map(textOf)).toEqual(['step_0', 'step_1', 'step_2']);
        expect(withClass(state, 'state-steps-more')).toEqual([]);
        expect((state.children ?? []).some((c: any) => c?.sel === 'title' || c?.tag === 'title')).toBe(false);
    });
});

describe('the state an automaton starts in', () => {
    const k = WorkflowDiagramConstants;
    const view = (): StateNodeView => Object.assign(new StateNodeView(), { isVisible: () => true });
    const drawn = (args: Record<string, unknown>, size: { width: number; height: number }): any => view().render({
        id: 's', type: WorkflowDiagramTypes.NODE_STATE, position: { x: 0, y: 0 }, size, args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'idle', ...args }
    } as any, { targetKind: 'hidden', renderChildren: () => [] } as any);
    const attrsOf = (vnode: any): Record<string, number> => vnode?.data?.attrs ?? vnode?.props?.attrs ?? vnode?.attrs;

    it('is drawn with a second outline inside its own, with its corners, and no mark beside it', () => {
        const state = drawn({ [WorkflowDiagramMetadata.STATE_INITIAL]: true }, { width: 80, height: k.STATE_HEIGHT_PX });
        const [outline] = withClass(state, 'state-initial-outline');
        const inset = STATE_INITIAL_INSET_PX;
        expect(attrsOf(outline)).toEqual({
            x: inset, y: inset, width: 80 - 2 * inset, height: k.STATE_HEIGHT_PX - 2 * inset,
            rx: k.STATE_HEIGHT_PX / 2 - inset, ry: k.STATE_HEIGHT_PX / 2 - inset
        });
        expect(withClass(state, 'state-initial-mark')).toEqual([]);
    });

    it('keeps a pill of a state height\u2019s corners when it lists the steps of a run', () => {
        const state = drawn({ [WorkflowDiagramMetadata.STATE_INITIAL]: true, [WorkflowDiagramMetadata.STATE_STEPS]: [{ action: 'load', count: 1 }] }, { width: 160, height: 90 });
        const [outline] = withClass(state, 'state-initial-outline');
        expect(attrsOf(outline).rx).toBe(k.STATE_HEIGHT_PX / 2 - STATE_INITIAL_INSET_PX);
        expect(attrsOf(outline).height).toBe(90 - 2 * STATE_INITIAL_INSET_PX);
    });

    it('is the only state with one', () => {
        expect(withClass(drawn({}, { width: 80, height: k.STATE_HEIGHT_PX }), 'state-initial-outline')).toEqual([]);
    });
});
