import * as vscode from 'vscode';
import type { DiagramOpenabilityCheck } from '@dialogram/shared';
import { hasRequestedDecoratedDefinition } from './python-diagram-definitions.js';
import { runChildProcess } from './run-child-process.js';

/**
 * Deadline for the openability probe.
 *
 * Shorter than a real load: this only answers "can this file be shown as a
 * diagram?", it runs before anything is on screen, and a runtime that takes this
 * long to answer is a no as far as the decision is concerned. The fallback
 * source scan still runs, so a slow probe degrades to the static answer rather
 * than to a wrong one.
 */
export const OPENABILITY_PROBE_TIMEOUT_MS = 20_000;

/**
 * Product-neutral configuration for the diagram-openability probe/fallback. The
 * consumer adapter supplies these values from its profile; this module contains
 * no per-runtime branching.
 */
export interface DiagramOpenabilityConfig {
    settingsNamespace: string;
    sidecarCommandSettingKey: string;
    sidecarCommandDefault: string;
    sidecarOperationPrefix: string;
    /** Graph-export op (without prefix) used to probe openability; probe is
     *  skipped entirely when absent. */
    probeOp?: string;
    /** Source-file extension the diagram editor handles (e.g. `.py`). */
    sourceExtension: string;
    /** Decorator name the fallback checker scans for (e.g. `network`/`workflow`). */
    decoratorName: string;
}

export type DiagramOpenabilityProbe = (
    targetUri: vscode.Uri,
    cfg: DiagramOpenabilityConfig,
    requestedName?: string
) => Promise<boolean | undefined>;

export type DecoratedDefinitionChecker = (
    filePath: string,
    decoratorName: string,
    requestedName?: string
) => Promise<boolean>;

async function probeDiagramOpenability(
    targetUri: vscode.Uri,
    cfg: DiagramOpenabilityConfig,
    requestedName?: string
): Promise<boolean | undefined> {
    if (
        !cfg.probeOp
        || targetUri.scheme !== 'file'
        || !targetUri.fsPath.toLowerCase().endsWith(cfg.sourceExtension)
    ) {
        return undefined;
    }

    const sidecarCommand = vscode.workspace
        .getConfiguration(cfg.settingsNamespace, targetUri)
        .get<string>(cfg.sidecarCommandSettingKey, cfg.sidecarCommandDefault)
        ?? cfg.sidecarCommandDefault;

    try {
        // Graph-export op is config-driven (see docs/sidecar-contract-v2.md): the
        // sidecar is asked to export the graph and the response status decides
        // whether the source can render as a diagram.
        const payload = {
            file: targetUri.fsPath,
            op: `${cfg.sidecarOperationPrefix}.${cfg.probeOp}`,
            args: requestedName && requestedName.trim() !== ''
                ? { network: requestedName.trim() }
                : {}
        };

        const result = await runChildProcess(sidecarCommand, [], {
            input: `${JSON.stringify(payload)}\n`,
            timeoutMs: OPENABILITY_PROBE_TIMEOUT_MS
        });

        const trimmedStdout = result.stdout.trim();
        if (result.code !== 0 || trimmedStdout === '') {
            return undefined;
        }

        try {
            const candidateLine = trimmedStdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1);
            if (!candidateLine) {
                return undefined;
            }
            const response = JSON.parse(candidateLine) as { status?: string };
            if (response.status === 'ok') {
                return true;
            }
            if (response.status === 'error') {
                return false;
            }
        } catch {
            return undefined;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

export async function shouldOpenDiagram(
    targetUri: vscode.Uri,
    cfg: DiagramOpenabilityConfig,
    requestedName?: string,
    probe: DiagramOpenabilityProbe = probeDiagramOpenability,
    definitionChecker: DecoratedDefinitionChecker = hasRequestedDecoratedDefinition
): Promise<boolean> {
    if (targetUri.scheme !== 'file' || !targetUri.fsPath.toLowerCase().endsWith(cfg.sourceExtension)) {
        return false;
    }

    const probeResult = await probe(targetUri, cfg, requestedName);
    if (probeResult !== undefined) {
        return probeResult;
    }

    try {
        return await definitionChecker(targetUri.fsPath, cfg.decoratorName, requestedName);
    } catch {
        return false;
    }
}

/**
 * Adapt {@link shouldOpenDiagram} into the neutral {@link DiagramOpenabilityCheck}
 * a diagram profile carries. URIs cross as strings; we round-trip via
 * `vscode.Uri.parse(uri.toString())` so `shared` stays vscode-free.
 */
export function createDiagramOpenabilityCheck(cfg: DiagramOpenabilityConfig): DiagramOpenabilityCheck {
    return async (uri, context) => {
        const targetUri = vscode.Uri.parse(uri.toString());
        return shouldOpenDiagram(targetUri, cfg, context.requestedName);
    };
}
