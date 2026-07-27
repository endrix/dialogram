/**
 * Dialogram host extension entry.
 *
 * `activate()` returns the DialogramApi; consumer extensions obtain it via
 * `vscode.extensions.getExtension(DIALOGRAM_EXTENSION_ID).activate()` and
 * call `activateDiagramProfile(theirContext, theirProfile)`.
 *
 * INSTANCE MODEL: the platform module is loaded once. All state is per-profile:
 * ChatRuntime and GlspIntegrationHandle are created fresh
 * for each profile. This gives consumers (wfpy, calpy, ...) complete isolation
 * without requiring fresh module loads per profile.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import {
    DIALOGRAM_API_VERSION,
    assertProfileCrossesPlatformApiSafely,
    type DialogramApi,
    type DiagramProfile,
    type DiagramProfileHandle
} from '@dialogram/extension-core/api';

/**
 * Structural mirror of the toolkit's `SidecarDialogramApi`, kept IMPORT-FREE on
 * purpose: this file is type-checked by the shell's strict tsconfig, which
 * excludes the decorator-heavy toolkit graph (see tsconfig.json's exclude note
 * for platform-entry.ts). The input is typed loosely here; consumers get full
 * checking by casting the activated api to `DialogramApi & SidecarDialogramApi`
 * (a type-only toolkit import on THEIR side) and authoring the literal with
 * `satisfies SidecarProfileInput`.
 */
interface SidecarAssemblyApi {
    createSidecarDiagramProfile(input: Record<string, unknown>): DiagramProfile;
}

interface PlatformModule {
    activateProfileRuntime(
        context: vscode.ExtensionContext,
        profile: DiagramProfile,
        assetsUri?: vscode.Uri
    ): Promise<DiagramProfileHandle>;
    // Assembles the sidecar-backed profile INSIDE the platform bundle so its
    // DI-decorated classes share this bundle's inversify/Symbol realm — the
    // whole point of the cross-bundle DI identity fix. See platform-entry.ts.
    createSidecarDiagramProfile(input: Record<string, unknown>): DiagramProfile;
}

export function activate(context: vscode.ExtensionContext): DialogramApi & SidecarAssemblyApi {
    const nodeRequire = createRequire(__filename);
    const platformPath = path.join(context.extensionPath, 'dist', 'platform.cjs');
    // One shared platform module: all state is per-profile instances
    // (ChatRuntime, GlspIntegrationHandle), so consumers
    // no longer need isolated module copies.
    const platform = nodeRequire(platformPath) as PlatformModule;

    return {
        apiVersion: DIALOGRAM_API_VERSION,
        // Delegate assembly to the platform bundle: the toolkit's DI classes are
        // built and later resolved in the SAME realm (platform.cjs). Consumers
        // pass only a plain data literal across the API boundary.
        createSidecarDiagramProfile: (input) => platform.createSidecarDiagramProfile(input),
        activateDiagramProfile: async (consumerContext, profile) => {
            // The cross-extension platform API must reject build-time-library-only fields:
            // a consumer's GLSP DiagramModule would resolve in this bundle's foreign realm.
            assertProfileCrossesPlatformApiSafely(profile);
            return platform.activateProfileRuntime(consumerContext, profile, context.extensionUri);
        }
    };
}

export function deactivate(): void {
    // Per-profile teardown happens through each consumer's ExtensionContext
    // subscriptions and the DiagramProfileHandle they received.
}
