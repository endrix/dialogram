import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { hasSourceExtension, shouldOpenDiagram, type DiagramOpenabilityConfig } from '../src/diagram-openability';

// Product-neutral openability config. The concrete per-runtime values (calpy's
// `calLang`/`calpy-sidecar`/`network`) are supplied by the extension-core adapter;
// this test only needs the fields shouldOpenDiagram reads.
const OPENABILITY_CONFIG: DiagramOpenabilityConfig = {
    settingsNamespace: 'calLang',
    sidecarCommandSettingKey: 'calpySidecarCommand',
    sidecarCommandDefault: 'calpy-sidecar',
    sidecarOperationPrefix: 'calpy',
    probeOp: 'exportNetworkGraph',
    sourceExtension: '.py',
    decoratorName: 'network'
};

describe('shouldOpenDiagram', () => {
    it('accepts a source file when the sidecar probe succeeds even if decorator scanning fails', async () => {
        const targetUri = vscode.Uri.file('/external/project/examples/python/qwen/model.py');
        const probe = vi.fn(async () => true);
        const definitionChecker = vi.fn(async () => false);

        await expect(
            shouldOpenDiagram(targetUri, OPENABILITY_CONFIG, undefined, probe, definitionChecker)
        ).resolves.toBe(true);

        expect(probe).toHaveBeenCalledWith(targetUri, OPENABILITY_CONFIG, undefined);
        expect(definitionChecker).not.toHaveBeenCalled();
    });

    it('falls back to decorator scanning when the sidecar probe is unavailable', async () => {
        const targetUri = vscode.Uri.file('/external/project/examples/python/qwen/graph.py');
        const probe = vi.fn(async () => undefined);
        const definitionChecker = vi.fn(async () => true);

        await expect(
            shouldOpenDiagram(targetUri, OPENABILITY_CONFIG, 'top_level', probe, definitionChecker)
        ).resolves.toBe(true);

        expect(definitionChecker).toHaveBeenCalledWith(targetUri.fsPath, 'network', 'top_level');
    });

    it('accepts any of several source extensions and nothing else', async () => {
        const cfg: DiagramOpenabilityConfig = { ...OPENABILITY_CONFIG, sourceExtension: '.sv', sourceExtensions: ['.sv', '.v'] };
        expect(hasSourceExtension('/rtl/top.sv', cfg)).toBe(true);
        expect(hasSourceExtension('/rtl/legacy.V', cfg)).toBe(true);
        expect(hasSourceExtension('/rtl/top.py', cfg)).toBe(false);

        const probe = vi.fn(async () => true);
        const definitionChecker = vi.fn(async () => true);
        await expect(
            shouldOpenDiagram(vscode.Uri.file('/rtl/legacy.v'), cfg, undefined, probe, definitionChecker)
        ).resolves.toBe(true);
        expect(probe).toHaveBeenCalled();
        // A file with none of the extensions is refused before any probe runs.
        await expect(
            shouldOpenDiagram(vscode.Uri.file('/rtl/notes.txt'), cfg, undefined, probe, definitionChecker)
        ).resolves.toBe(false);
        expect(probe).toHaveBeenCalledTimes(1);
    });
});
