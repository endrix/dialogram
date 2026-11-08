/**
 * The shipped property panel, with only its window chrome skipped and its
 * dispatcher a recorder. Shared by the agent-UI characterization tests.
 */
import { PropertyPanel } from '../../src/property-panel';

export class TestPanel extends PropertyPanel {
    readonly dispatched: any[] = [];

    protected override initialize(): void {
        // The window chrome needs the editor's page; the content does not.
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

    /** The re-render when discovered skills arrive (the shipped `initialize` installs it). */
    listenForDiscovery(): void {
        this.initializeAsyncDiscoveryRefresh();
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
