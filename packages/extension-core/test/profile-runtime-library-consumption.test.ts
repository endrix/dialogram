// SP4 Task 1 (library-consumption smoke): the library entry `activateProfileRuntime`
// activates a READ-ONLY profile carrying a custom `serverDiagramModule` + `clientAssets`
// in a SINGLE realm and threads the custom module through to the GLSP layer unchanged
// (no sidecar anything in the path). The heavy GLSP/diagram-server boot is stubbed here;
// the production-topology `get(GLSPServer)` proof for a custom module lives in
// diagram-server's `custom-diagram-module.test.ts` (SP2c pattern). Together they prove the
// custom-module path threads through the library entry AND boots in one realm.
//
// Also pins the two new handle methods: `dispatchToWebview` rides the provider's ungated
// send path, `postToWebview` rides the provider's raw per-URI post.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagramProfile, DiagramModelSource } from '../src/api';

const hoisted = vi.hoisted(() => ({
    receivedProfile: undefined as DiagramProfile | undefined,
    dispatchToWebview: undefined as any,
    postToWebview: undefined as any
}));

vi.mock('../src/extension/diagram/glsp-activation', () => ({
    activateGlspIntegration: vi.fn(async (_context: unknown, profile: DiagramProfile) => {
        hoisted.receivedProfile = profile;
        hoisted.dispatchToWebview = vi.fn();
        hoisted.postToWebview = vi.fn();
        return {
            connector: { sendMessageToClient: vi.fn() } as unknown,
            editorProvider: {
                dispatchToWebview: hoisted.dispatchToWebview,
                postToWebview: hoisted.postToWebview
            } as unknown,
            executionOverlay: {} as unknown,
            dispose: () => undefined
        };
    })
}));

import { activateProfileRuntime } from '../src/extension/profile-runtime';

function makeContext() {
    return {
        subscriptions: [] as { dispose(): void }[],
        workspaceState: {
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
            update: async (): Promise<void> => undefined
        }
    } as any;
}

const FAKE_MODEL_SOURCE: DiagramModelSource = { getGraph: async () => undefined };

function libraryProfile(overrides: Partial<DiagramProfile> = {}): DiagramProfile {
    const commandKeys = [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'createNewContainer'
    ];
    const commands = Object.fromEntries(
        commandKeys.map((k) => [k, `mlir.${k}`])
    ) as unknown as DiagramProfile['commands'];

    return {
        key: 'mlir',
        displayName: 'MLIR',
        settingsNamespace: 'mlir',
        customEditorViewType: 'mlir.networkDiagram',
        glspClientId: 'mlir.client',
        glspClientName: 'mlir',
        commands,
        edits: 'read-only',
        modelSource: () => FAKE_MODEL_SOURCE,
        serverDiagramModule: () => ({ __customModule: true }),
        clientAssets: { scriptPath: '/mlir/dist/webview/client.js' },
        ...overrides
    };
}

afterEach(() => {
    hoisted.receivedProfile = undefined;
    hoisted.dispatchToWebview = undefined;
    hoisted.postToWebview = undefined;
    vi.clearAllMocks();
});

describe('activateProfileRuntime — library consumption (custom serverDiagramModule)', () => {
    it('threads a read-only profile carrying serverDiagramModule + clientAssets to the GLSP layer', async () => {
        const context = makeContext();
        await activateProfileRuntime(context, libraryProfile());

        expect(hoisted.receivedProfile).toBeDefined();
        expect(hoisted.receivedProfile!.edits).toBe('read-only');
        expect(typeof hoisted.receivedProfile!.serverDiagramModule).toBe('function');
        expect((hoisted.receivedProfile!.serverDiagramModule as () => unknown)()).toEqual({ __customModule: true });
        expect(hoisted.receivedProfile!.clientAssets).toEqual({ scriptPath: '/mlir/dist/webview/client.js' });
    });

    it('does not activate the chat backend for a read-only profile with no editBackend', async () => {
        const context = makeContext();
        const handle = await activateProfileRuntime(context, libraryProfile());
        expect(handle.chat.runDiagnostics()).toBeUndefined();
        expect(() => handle.chat.showLog()).not.toThrow();
    });

    it('handle.dispatchToWebview delegates to the provider ungated send path', async () => {
        const context = makeContext();
        const handle = await activateProfileRuntime(context, libraryProfile());

        handle.dispatchToWebview('file:///m.mlir', { kind: 'mlir.markErrors', markers: [] });

        expect(hoisted.dispatchToWebview).toHaveBeenCalledTimes(1);
        expect(hoisted.dispatchToWebview).toHaveBeenCalledWith('file:///m.mlir', { kind: 'mlir.markErrors', markers: [] });
    });

    it('handle.postToWebview delegates to the provider raw per-URI post', async () => {
        const context = makeContext();
        const handle = await activateProfileRuntime(context, libraryProfile());

        handle.postToWebview('file:///m.mlir', { type: 'mlir.syncCursor', line: 2 });

        expect(hoisted.postToWebview).toHaveBeenCalledTimes(1);
        expect(hoisted.postToWebview).toHaveBeenCalledWith('file:///m.mlir', { type: 'mlir.syncCursor', line: 2 });
    });
});
