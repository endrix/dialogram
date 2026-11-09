/**
 * The shipped property panel with its window wiring skipped, its dispatcher a
 * recorder, and the stock annotation editors and node sections injected.
 * Shared by the agent-UI characterization tests.
 *
 * `initialize` is skipped whole: the window chrome (it needs the editor's
 * page) and the document's link listener. So link handling in a rendered
 * reply is not exercised here. The node sections' one-time setup (the
 * discovered-skills listener), which the container runs after injection,
 * runs on demand: see `listenForDiscovery`.
 */
import { PropertyPanel } from '../../src/property-panel';
import { agentUiEditors, agentUiNodeSections } from '../../src/agent-ui';
import { WorkflowShowAgentSkillsActionHandler, WorkflowShowClaudeAgentsActionHandler } from '../../src/editing-action-handlers';
import { ui } from './harness';

/**
 * A clean slate for each test: the recorders, and the static per-element
 * caches of discovered skills and presets, so a test never sees what an
 * earlier one discovered for the same node.
 */
export function resetAgentUi(): void {
    ui.reset();
    (WorkflowShowAgentSkillsActionHandler as any).skillsByElementId.clear();
    (WorkflowShowClaudeAgentsActionHandler as any).agentsByElementId.clear();
}

export class TestPanel extends PropertyPanel {
    readonly dispatched: any[] = [];
    private readonly windowListeners: Array<[string, EventListenerOrEventListenerObject]> = [];

    protected override initialize(): void {
        // Skipped whole; see the class comment.
    }

    constructor() {
        super();
        // What `agentUiModule` binds.
        (this as any).contributedAnnotationEditors = agentUiEditors();
        (this as any).contributedNodeSections = agentUiNodeSections();
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

    /**
     * The re-render when discovered skills arrive (the shipped `initialize`
     * installs it). Removed again by `dispose`, so a later test's panel is the
     * only one drawing into the page.
     */
    listenForDiscovery(): void {
        const add = window.addEventListener.bind(window);
        (window as any).addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
            this.windowListeners.push([type, listener]);
            add(type, listener, options as never);
        };
        try {
            this.installNodeSections();
        } finally {
            (window as any).addEventListener = add;
        }
    }

    dispose(): void {
        for (const [type, listener] of this.windowListeners.splice(0)) {
            window.removeEventListener(type, listener);
        }
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
