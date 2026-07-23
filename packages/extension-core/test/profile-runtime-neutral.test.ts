/**
 * Step-1 (SP2c-3 Task 2): `activateProfileRuntime` accepts a fully-assembled
 * NEUTRAL `DiagramProfile` — a fake model source, `'read-only'` edits and no
 * sidecar-supplied capabilities (no editBackend / runDriver / newSourceFile) —
 * and activates without any sidecar knowledge in the path.
 *
 * The GLSP integration is stubbed so this test targets profile-runtime's
 * consumption of the neutral contract, not the heavy GLSP/diagram-server stack.
 * The assertion is twofold: (a) the profile handed to the GLSP layer is the
 * neutral one, with no product tokens in its command ids; (b) core wires the
 * optional capabilities ONLY when the profile carries them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagramProfile, DiagramModelSource } from '../src/api';

const hoisted = vi.hoisted(() => ({
    receivedProfile: undefined as DiagramProfile | undefined
}));

vi.mock('../src/extension/diagram/glsp-activation', () => ({
    activateGlspIntegration: vi.fn(async (_context: unknown, profile: DiagramProfile) => {
        hoisted.receivedProfile = profile;
        return {
            connector: {} as unknown,
            editorProvider: {} as unknown,
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

const FAKE_MODEL_SOURCE: DiagramModelSource = {
    getGraph: async () => undefined
};

/** A fully-assembled neutral profile: read-only, no sidecar capabilities. */
function neutralProfile(overrides: Partial<DiagramProfile> = {}): DiagramProfile {
    const commandKeys = [
        'openDiagram', 'openDiagramSplit', 'layoutDiagram', 'refreshDiagramModel',
        'renameEntityByName', 'undo', 'redo', 'fitToScreen', 'center', 'exportSvg',
        'toggleGrid', 'setQueueTraceVisible', 'stopWorkflow', 'runWorkflow',
        'layoutDiagramIfNeeded', 'setAgentToolConfig', 'getAgentToolConfig',
        'createAgentToolPolicyFile', 'chatAddViewerEditor', 'chatAddViewerTask',
        'sidecarEdit', 'sidecarSend', 'createNewContainer'
    ] as const;
    const commands = Object.fromEntries(
        commandKeys.map((k) => [k, `diag.${k}`])
    ) as unknown as DiagramProfile['commands'];

    return {
        key: 'diag',
        displayName: 'Diagram',
        settingsNamespace: 'diagLang',
        customEditorViewType: 'diag.networkDiagram',
        glspClientId: 'diag.client',
        glspClientName: 'diag',
        commands,
        edits: 'read-only',
        modelSource: () => FAKE_MODEL_SOURCE,
        ...overrides
    };
}

afterEach(() => {
    hoisted.receivedProfile = undefined;
    vi.clearAllMocks();
});

describe('activateProfileRuntime consumes a neutral DiagramProfile', () => {
    it('activates a read-only neutral profile and forwards it to the GLSP layer', async () => {
        const context = makeContext();
        const handle = await activateProfileRuntime(context, neutralProfile());

        expect(hoisted.receivedProfile).toBeDefined();
        expect(hoisted.receivedProfile!.edits).toBe('read-only');

        // No product/sidecar vocabulary in any registered command id.
        const ids = Object.values(hoisted.receivedProfile!.commands);
        for (const id of ids) {
            expect(id).not.toMatch(/wfpy|calpy|sidecar-|python/i);
        }

        // GLSP handle is disposable; chat degrades to a no-op with no editBackend.
        expect(typeof handle.dispose).toBe('function');
        expect(handle.chat.runDiagnostics()).toBeUndefined();
        expect(() => handle.chat.showLog()).not.toThrow();
    });

    it('does NOT wire new-source-file commands when the profile omits them', async () => {
        const context = makeContext();
        await activateProfileRuntime(context, neutralProfile());
        // Only the GLSP handle is tracked; no newSourceFile disposable pushed.
        expect(context.subscriptions.length).toBe(1);
    });

    it('wires the new-source-file capability only when the profile carries it', async () => {
        const context = makeContext();
        const newSourceFile = vi.fn(() => ({ dispose: () => undefined }));
        await activateProfileRuntime(context, neutralProfile({ newSourceFile }));

        expect(newSourceFile).toHaveBeenCalledTimes(1);
        expect(newSourceFile).toHaveBeenCalledWith(context);
        // GLSP handle + the newSourceFile disposable.
        expect(context.subscriptions.length).toBe(2);
    });
});
