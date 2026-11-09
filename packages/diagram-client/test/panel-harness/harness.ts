/**
 * The property panel in a real DOM (happy-dom), for the contribution-point
 * tests: the webview page the platform writes, a node as the server sends
 * it, and the VS Code bridge as a recorder, so a test reads back what the
 * panel drew and what it asked the host.
 *
 * Grew out of the agent-UI characterization (#132), which moved to wfpy-ide
 * with the code it pinned.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

export interface UiCall { method: string; args: unknown[] }

// This module must not import panel code: the VS Code bridge mock loads it,
// and panel code imports the bridge (a cycle the module loader waits on forever).
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
 * The VS Code bridge as a recorder. A test file mocks `../src/vscode-ui` with
 * `vi.mock('../src/vscode-ui', async () => (await import('./panel-harness/harness')).vscodeUiModule())`.
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
        quickPick: record('quickPick')
    };
    return { VscodeUi: { get instance() { return instance; } } };
}

/** The webview page the platform writes, with the client behaviour given. */
export function installPage(behavior: Record<string, unknown> = {}): void {
    document.body.innerHTML = '<div id="property-panel"><div id="property-content"></div></div>';
    (globalThis as any).diagramIdentifier = {
        clientId: 'test',
        settingsNamespace: 'test',
        commandIds: {},
        clientBehavior: { runDriver: true, ...behavior }
    };
}

export type AnnotationArg = { name: string; value: string };

/** A task node whose definition carries `annotations`, as the server sends it. */
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
