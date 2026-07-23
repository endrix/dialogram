// SP4 Task 1: `serverDiagramModule` is a BUILD-TIME LIBRARY-only field. A GLSP
// DiagramModule constructed in a consumer bundle carries that bundle's
// inversify/Symbol identity; sending it across the cross-extension
// `DialogramApi.activateDiagramProfile` boundary would have the platform bundle
// resolve it in a FOREIGN realm with no injection metadata (the SP2c failure).
//
// `assertProfileCrossesPlatformApiSafely` is the guard the platform-API delegate
// (packages/extension/src/main.ts) calls before delegating; library consumers that
// call `activateProfileRuntime` directly never pass through it and are unaffected.
import { describe, expect, it } from 'vitest';
import { assertProfileCrossesPlatformApiSafely } from '../src/api';
import type { DiagramProfile } from '../src/api';

function profile(overrides: Partial<DiagramProfile> = {}): DiagramProfile {
    return {
        key: 'p',
        displayName: 'P',
        settingsNamespace: 'p',
        customEditorViewType: 'p.networkDiagram',
        glspClientId: 'p.client',
        glspClientName: 'p',
        commands: {} as DiagramProfile['commands'],
        edits: 'read-only',
        ...overrides
    } as DiagramProfile;
}

describe('assertProfileCrossesPlatformApiSafely', () => {
    it('throws a clear error when the profile carries serverDiagramModule', () => {
        expect(() => assertProfileCrossesPlatformApiSafely(profile({ serverDiagramModule: () => ({}) })))
            .toThrow(/serverDiagramModule/);
    });

    it('names the build-time library remedy in the error message', () => {
        expect(() => assertProfileCrossesPlatformApiSafely(profile({ serverDiagramModule: () => ({}) })))
            .toThrow(/activateProfileRuntime/);
    });

    it('does not throw for a profile without serverDiagramModule (stock path)', () => {
        expect(() => assertProfileCrossesPlatformApiSafely(profile())).not.toThrow();
    });
});

describe('assertProfileCrossesPlatformApiSafely — realm brand (SP4 T1 review follow-up)', () => {
    const base = {
        key: 'x', displayName: 'X', settingsNamespace: 'x',
        customEditorViewType: 'x.d', glspClientId: 'x', glspClientName: 'X',
        commands: {} as never, edits: 'read-only' as const
    };

    it('rejects unbranded serverModules over the API', () => {
        const profile = { ...base, serverModules: [{}] };
        expect(() => assertProfileCrossesPlatformApiSafely(profile as never)).toThrow(/serverModules/);
    });

    it('rejects unbranded edits.operationModules over the API', () => {
        const profile = { ...base, edits: { operationModules: [{ __diagramOperationModule: true }] } };
        expect(() => assertProfileCrossesPlatformApiSafely(profile as never)).toThrow(/operationModules/);
    });

    it('allows a platform-branded profile to round-trip DI fields', () => {
        const profile = { ...base, serverModules: [{}], edits: { operationModules: [{ __diagramOperationModule: true }] } };
        Object.defineProperty(profile, Symbol.for('dialogram.platformAssembledProfile'), { value: true, enumerable: false });
        expect(() => assertProfileCrossesPlatformApiSafely(profile as never)).not.toThrow();
    });

    it('rejects serverDiagramModule even when branded', () => {
        const profile = { ...base, serverDiagramModule: () => ({}) };
        Object.defineProperty(profile, Symbol.for('dialogram.platformAssembledProfile'), { value: true, enumerable: false });
        expect(() => assertProfileCrossesPlatformApiSafely(profile as never)).toThrow(/serverDiagramModule/);
    });
});
