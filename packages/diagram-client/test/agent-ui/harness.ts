/**
 * A harness for the property panel's wfpy agent UI, in a real DOM (happy-dom).
 *
 * The panel is the shipped class with only its window chrome skipped. Its
 * dispatcher and the VS Code bridge are recorders, so a test reads back what
 * the panel drew and what it sent. Everything else is the real code: lit, the
 * Markdown renderer and DOMPurify run against happy-dom's window.
 *
 * These tests characterize what the agent UI does today, before it moves to
 * wfpy-ide: they pin its output, they do not argue it is right.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

export interface UiCall { method: string; args: unknown[] }

export const ui = {
    calls: [] as UiCall[],
    /** What `executeCommand(id)` answers, by command id; any other method, by its name. */
    answers: new Map<string, unknown>(),
    /** What `quickPick` / `inputBox` answer, in order. */
    picks: [] as unknown[],
    reset(): void {
        this.calls.length = 0;
        this.answers.clear();
        this.picks.length = 0;
    }
};

/**
 * The VS Code bridge as a recorder. A test file mocks `../../src/vscode-ui` with
 * `vi.mock('../../src/vscode-ui', async () => (await import('./harness')).vscodeUiModule())`.
 */
export function vscodeUiModule(): unknown {
    const record = (method: string) => async (...args: unknown[]) => {
        ui.calls.push({ method, args });
        if (method === 'executeCommand') {
            return ui.answers.get(String(args[0]));
        }
        if (method === 'quickPick' || method === 'inputBox') {
            return ui.picks.shift();
        }
        return ui.answers.get(method);
    };
    const instance = {
        executeCommand: record('executeCommand'),
        infoMessage: record('infoMessage'),
        errorMessage: record('errorMessage'),
        inputBox: record('inputBox'),
        quickPick: record('quickPick'),
        getViewerEditors: record('getViewerEditors'),
        appendViewerEditor: record('appendViewerEditor')
    };
    return { VscodeUi: { get instance() { return instance; } } };
}

/** The commands the host registers for an agent's tool settings (the run driver's). */
export const COMMAND_IDS = {
    setAgentToolConfig: 'wfpy.glsp.setAgentToolConfig',
    getAgentToolConfig: 'wfpy.glsp.getAgentToolConfig',
    runWorkflow: 'wfpy.glsp.runWorkflow',
    stopWorkflow: 'wfpy.glsp.stopWorkflow'
};

/** The webview page the platform writes, and the behaviour wfpy-ide injects. */
export function installPage(behavior: Record<string, unknown> = {}): void {
    document.body.innerHTML = '<div id="property-panel"><div id="property-content"></div></div>';
    (globalThis as any).diagramIdentifier = {
        clientId: 'test',
        settingsNamespace: 'wfLang',
        commandIds: COMMAND_IDS,
        clientBehavior: {
            runDriver: true,
            noneSentinel: 'wfpy-none',
            acpConnectors: [
                { name: 'claude-code', available: true, source: 'discovered', command: 'claude-code-acp' },
                { name: 'opencode', available: false, source: 'discovered', command: 'opencode', httpApi: true }
            ],
            ...behavior
        }
    };
}

/** An argument as the producer writes it: a Python expression. */
export type AnnotationArg = { name: string; value: string };

/** A task node with the given definition annotations, as the server sends it. */
export function taskNode(
    name: string,
    annotations: Array<{ name: string; arguments: AnnotationArg[] }>,
    extra: Record<string, unknown> = {}
): any {
    return {
        id: `node:scope:root:${name}`,
        type: WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR,
        args: {
            [WorkflowDiagramMetadata.ENTITY_NAME]: name,
            [WorkflowDiagramMetadata.ENTITY_TYPE]: name[0].toUpperCase() + name.slice(1),
            [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true,
            [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: annotations,
            ...extra
        },
        children: []
    };
}

/** The analyst agent of `diagram-server/test/fixtures-speculation-flow.json`, prompt shortened. */
export const ANALYST_AGENT = {
    name: 'agent',
    arguments: [
        { name: 'prompt', value: '"You are the analyst of a hardware design loop.\\nSay, per program, the budget in cycles."' },
        { name: 'model', value: '"opus"' },
        { name: 'timeoutMs', value: '1800000' },
        { name: 'contextBudget', value: '50' },
        { name: 'useClaudeAgent', value: 'false' },
        { name: 'useSkill', value: 'true' },
        { name: 'usePrompt', value: 'true' },
        { name: 'stateful', value: 'false' },
        { name: 'truncationStrategy', value: '"sliding"' },
        { name: 'transport', value: '"claude-cli"' },
        { name: 'reasoningEffort', value: '"None"' },
        { name: 'askUser', value: 'true' },
        { name: 'cliToolsMode', value: '"native"' }
    ]
};

/** A `@tool` as the annotation wizard's template writes it. */
export const BASH_TOOL = {
    name: 'tool',
    arguments: [
        { name: 'cmd', value: '"bash"' },
        { name: 'args', value: '["-lc", "make all"]' },
        { name: 'inheritStdio', value: 'true' }
    ]
};

/**
 * The panel's DOM as indented text: tag, class, the attributes a person sees
 * or a control carries, and trimmed text. Lit's comment markers are dropped.
 */
export function dumpDom(root: Element): string {
    const lines: string[] = [];
    const ATTRS = ['type', 'title', 'placeholder', 'value', 'checked', 'selected', 'disabled', 'href', 'data-annotation', 'data-arg', 'aria-label', 'role'];
    const walk = (node: Node, depth: number): void => {
        if (node.nodeType === 3) {
            const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text) {
                lines.push(`${'  '.repeat(depth)}"${text}"`);
            }
            return;
        }
        if (node.nodeType !== 1) {
            return;
        }
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const parts = [tag];
        if (el.className && typeof el.className === 'string') {
            parts.push(`.${el.className.trim().split(/\s+/).join('.')}`);
        }
        for (const attr of ATTRS) {
            if (attr === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
                const value = (el as HTMLInputElement).value;
                if (value !== '') {
                    parts.push(`value=${JSON.stringify(value)}`);
                }
                continue;
            }
            if (attr === 'checked' && tag === 'input') {
                if ((el as HTMLInputElement).checked) {
                    parts.push('checked');
                }
                continue;
            }
            if (attr === 'selected' && tag === 'option') {
                if ((el as HTMLOptionElement).selected) {
                    parts.push('selected');
                }
                continue;
            }
            const value = el.getAttribute(attr);
            if (value !== null) {
                parts.push(value === '' ? attr : `${attr}=${JSON.stringify(value)}`);
            }
        }
        if (el.hidden || el.style?.display === 'none') {
            parts.push('[hidden]');
        }
        lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
        for (const child of Array.from(el.childNodes)) {
            walk(child, depth + 1);
        }
    };
    walk(root, 0);
    return lines.join('\n') + '\n';
}
