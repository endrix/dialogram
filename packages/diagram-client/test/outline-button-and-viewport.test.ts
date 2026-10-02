/**
 * The hierarchy button sits in the floating button stack, under the chat
 * button; and navigating back to a view returns it to where it was left
 * instead of to the default scroll, which put the graph off-center.
 */
import { describe, expect, it } from 'vitest';
import { panelPlacement, placeInButtonStack } from '../src/hierarchy-outline';
import { modelViewportKey, settleViewport } from '../src/viewport-preserving-set-model-command';

/** A minimal element tree: enough for parent/sibling bookkeeping. */
class FakeElement {
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];
    readonly classes = new Set<string>();
    constructor(readonly id = '') {}
    get nextElementSibling(): FakeElement | null {
        const siblings = this.parentElement?.children ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get classList() {
        const classes = this.classes;
        return { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) };
    }
    private detach(child: FakeElement): void {
        const from = child.parentElement;
        if (from) {
            from.children.splice(from.children.indexOf(child), 1);
        }
    }
    appendChild(child: FakeElement): void {
        this.detach(child);
        child.parentElement = this;
        this.children.push(child);
    }
    insertBefore(child: FakeElement, before: FakeElement): void {
        this.detach(child);
        child.parentElement = this;
        this.children.splice(this.children.indexOf(before), 0, child);
    }
}

function docWith(stack: FakeElement | null, chat?: FakeElement): any {
    return { querySelector: () => stack, getElementById: (id: string) => (chat && chat.id === id ? chat : null) };
}

describe('the hierarchy button', () => {
    it('goes directly under the chat button: just before it in the reversed stack', () => {
        const stack = new FakeElement();
        const runs = new FakeElement('runs');
        const chat = new FakeElement('workflow-chat-toggle-btn');
        stack.appendChild(runs);
        stack.appendChild(chat);
        const toggle = new FakeElement('hierarchy');

        placeInButtonStack(toggle as any, docWith(stack, chat));

        expect(stack.children.map(c => c.id)).toEqual(['runs', 'hierarchy', 'workflow-chat-toggle-btn']);
        expect(toggle.classes.has('floating')).toBe(false);
    });

    it('stays put when placed again', () => {
        const stack = new FakeElement();
        const chat = new FakeElement('workflow-chat-toggle-btn');
        stack.appendChild(chat);
        const toggle = new FakeElement('hierarchy');
        placeInButtonStack(toggle as any, docWith(stack, chat));
        placeInButtonStack(toggle as any, docWith(stack, chat));
        expect(stack.children.map(c => c.id)).toEqual(['hierarchy', 'workflow-chat-toggle-btn']);
    });

    it('floats on its own until there is a stack', () => {
        const toggle = new FakeElement('hierarchy');
        placeInButtonStack(toggle as any, docWith(null));
        expect(toggle.classes.has('floating')).toBe(true);
    });
});

const view = (workflow: string, instance?: string, viewport?: { zoom: number; scroll: { x: number; y: number } }) => ({
    args: {
        sourceUri: 'file:///w/top.py',
        'wf:selectedWorkflow': workflow,
        ...(instance ? { 'wf:navTrail': JSON.stringify([{ workflowName: 'top' }, { workflowName: workflow, workflowInstanceName: instance }]) } : {})
    },
    zoom: viewport?.zoom ?? 1,
    scroll: viewport?.scroll ?? { x: 0, y: 0 }
});

describe('the viewport across a model change', () => {
    it('tells two instances of one workflow apart', () => {
        expect(modelViewportKey(view('block', 'b1'))).not.toBe(modelViewportKey(view('block', 'b2')));
    });

    it('centers a view never shown', () => {
        const store = new Map();
        expect(settleViewport(view('top', undefined, { zoom: 2, scroll: { x: 50, y: 60 } }), view('block', 'b1'), store)).toBe('center');
    });

    it('returns to where a view was left when navigating back to it', () => {
        const store = new Map();
        const leftAt = { zoom: 0.8, scroll: { x: 120, y: -40 } };
        // Down from the root into b1, then back up.
        settleViewport(view('top', undefined, leftAt), view('block', 'b1'), store);
        const back = view('top');

        expect(settleViewport(view('block', 'b1', { zoom: 1.5, scroll: { x: 9, y: 9 } }), back, store)).toBeUndefined();
        expect({ zoom: back.zoom, scroll: back.scroll }).toEqual(leftAt);
    });

    it('keeps the viewport of the view refreshed', () => {
        const refreshed = view('top');
        expect(settleViewport(view('top', undefined, { zoom: 1.2, scroll: { x: 5, y: 6 } }), refreshed, new Map())).toBeUndefined();
        expect({ zoom: refreshed.zoom, scroll: refreshed.scroll }).toEqual({ zoom: 1.2, scroll: { x: 5, y: 6 } });
    });
});

describe('the hierarchy panel', () => {
    it('opens just left of its button, bottom-aligned with it, growing upward', () => {
        // A 1200x800 window; the button 32px wide, 14px from the right edge,
        // its bottom 16px above the window's.
        const place = panelPlacement({ left: 1154, bottom: 784 }, { width: 1200, height: 800 });

        expect(place.right).toBe(1200 - 1154 + 8);
        expect(place.bottom).toBe(16);
        expect(place.maxHeight).toBe(784 - 16);
    });

    it('keeps a usable height when the button sits low in a short window', () => {
        expect(panelPlacement({ left: 400, bottom: 100 }, { width: 500, height: 120 }).maxHeight).toBe(160);
    });
});
