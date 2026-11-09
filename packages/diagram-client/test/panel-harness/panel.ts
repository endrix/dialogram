/**
 * The shipped property panel with its window wiring skipped, its dispatcher a
 * recorder, and no contributions unless a test gives it some.
 *
 * `initialize` is skipped whole: the window chrome (it needs the editor's
 * page) and the document's link listener. The node sections' one-time setup,
 * which the container runs after injection, runs on demand.
 */
import { PropertyPanel } from '../../src/property-panel';
import { ui } from './harness';

/** A clean slate for each test. */
export function resetPanel(): void {
    ui.reset();
}

export class TestPanel extends PropertyPanel {
    readonly dispatched: any[] = [];

    protected override initialize(): void {
        // Skipped whole; see the file comment.
    }

    constructor() {
        super();
        (this as any).actionDispatcher = {
            dispatch: async (action: unknown) => { this.dispatched.push(action); },
            dispatchAll: async (actions: unknown[]) => { this.dispatched.push(...actions); }
        };
    }

    /** Show a node, as a selection does. */
    show(node: any, root?: any): void {
        (this as any).lastRoot = root ?? rootOf(node);
        this.updateContent(node);
    }

    /** The last operation of a kind the panel dispatched. */
    last(kind: string): any {
        return [...this.dispatched].reverse().find(action => action?.kind === kind);
    }
}

/** A model root that indexes the given nodes, as GLSP's does. */
export function rootOf(...nodes: any[]): any {
    const byId = new Map(nodes.map(node => [node.id, node]));
    return { id: 'root', type: 'graph', args: {}, children: nodes, index: { getById: (id: string) => byId.get(id) } };
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** The button with this text inside `scope`. */
export function button(scope: ParentNode, text: string): HTMLButtonElement {
    const found = [...scope.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === text);
    if (!found) {
        throw new Error(`no button "${text}"`);
    }
    return found as HTMLButtonElement;
}

/** The annotation card whose title is `@<name>`. */
export function card(name: string): HTMLElement {
    const found = [...document.querySelectorAll('.annotation-item')]
        .find(item => item.querySelector('.annotation-title')?.textContent?.trim() === `@${name}`);
    if (!found) {
        throw new Error(`no @${name} card`);
    }
    return found as HTMLElement;
}

/** The property section whose title starts with `title`. */
export function section(title: string): HTMLElement | undefined {
    return [...document.querySelectorAll('.property-section')]
        .find(s => (s.querySelector('.section-title')?.textContent ?? '').trim().startsWith(title)) as HTMLElement | undefined;
}
