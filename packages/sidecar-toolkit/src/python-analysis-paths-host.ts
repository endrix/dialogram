/**
 * `python-analysis-paths.ts` in VS Code: the paths are considered when a
 * diagram of a source file is opened in a tab, read and written through the
 * workspace configuration, and the sidecar asked through the toolkit's
 * transport.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSidecarCapabilities } from './sidecar-capabilities.js';
import { invokeSidecarOp } from './sidecar-graph-export.js';
import {
    EXTRA_PATHS_KEY, EXTRA_PATHS_SECTION, PYTHON_ENVIRONMENT_OP, PythonAnalysisPaths, parsePythonEnvironment,
    type AnalysisFolder, type PythonAnalysisHost
} from './python-analysis-paths.js';

/** The language server that reads `python.analysis.extraPaths`, and the extension that selects its interpreter. */
const LANGUAGE_SERVER_EXTENSION = 'ms-python.vscode-pylance';
const PYTHON_EXTENSION = 'ms-python.python';

/** The sidecar imports nothing to answer: a short deadline, so a wedged one is not waited out. */
const ENVIRONMENT_TIMEOUT_MS = 15_000;

export interface PythonAnalysisPathsConfig {
    /** The product, as the notices name it. */
    displayName: string;
    /** The custom editor whose tabs are diagrams of the product's sources. */
    customEditorViewType: string;
    settingsNamespace: string;
    /** The boolean setting, under `settingsNamespace`, that turns this off. */
    settingKey: string;
    sidecarOperationPrefix: string;
    /** The sidecar command for a file, as the diagram resolves it. */
    sidecarCommand(file: string): string;
}

const folderUri = (folder: AnalysisFolder): vscode.Uri => vscode.Uri.file(folder.path);

async function readText(file: string): Promise<string | undefined> {
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
    } catch {
        return undefined;
    }
}

function vscodeHost(config: PythonAnalysisPathsConfig, log: (message: string) => void): PythonAnalysisHost {
    const options = (file: string) => ({ sidecarCommand: config.sidecarCommand(file), sidecarOperationPrefix: config.sidecarOperationPrefix });
    const setting = `${config.settingsNamespace}.${config.settingKey}`;
    return {
        folderOf(file) {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
            if (!folder || folder.uri.scheme !== 'file') {
                return undefined;
            }
            let realPath: string | undefined;
            try {
                realPath = fs.realpathSync.native(folder.uri.fsPath);
            } catch {
                realPath = undefined;
            }
            return { path: folder.uri.fsPath, name: folder.name, ...(realPath ? { realPath } : {}) };
        },
        enabled: file => vscode.workspace.getConfiguration(config.settingsNamespace, vscode.Uri.file(file)).get<boolean>(config.settingKey, true) !== false,
        languageServerInstalled: () => vscode.extensions.getExtension(LANGUAGE_SERVER_EXTENSION) !== undefined,
        async environmentOf(file) {
            // An older sidecar is not asked for an op it would answer with an error.
            const capabilities = await getSidecarCapabilities(file, options(file));
            if (!capabilities?.supportedOps.has(PYTHON_ENVIRONMENT_OP)) {
                return undefined;
            }
            const result = await invokeSidecarOp(file, { ...options(file), timeoutMs: ENVIRONMENT_TIMEOUT_MS }, PYTHON_ENVIRONMENT_OP, {});
            if (!result.ok) {
                log(`python analysis paths: ${result.message ?? 'the sidecar gave no answer'}`);
                return undefined;
            }
            return parsePythonEnvironment(result.response?.diagnostic);
        },
        async selectedPrefix(folder) {
            try {
                const extension = vscode.extensions.getExtension(PYTHON_EXTENSION);
                if (!extension) {
                    return undefined;
                }
                const api = extension.isActive ? extension.exports : await extension.activate();
                const active = api?.environments?.getActiveEnvironmentPath?.(folderUri(folder));
                const resolved = active ? await api.environments.resolveEnvironment?.(active) : undefined;
                const prefix = resolved?.executable?.sysPrefix;
                return typeof prefix === 'string' && prefix.trim() !== '' ? prefix : undefined;
            } catch {
                return undefined;
            }
        },
        async pyrightConfigPaths(folder) {
            const text = await readText(path.join(folder.path, 'pyrightconfig.json'));
            if (text === undefined) {
                return undefined;
            }
            try {
                // Without the key the file leaves the paths to the setting.
                const paths = (JSON.parse(text) as { extraPaths?: unknown })?.extraPaths;
                return Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === 'string') : undefined;
            } catch {
                // Comments or trailing commas: Pyright reads it, this does not try to.
                return 'unreadable';
            }
        },
        async pyprojectSetsExtraPaths(folder) {
            const text = await readText(path.join(folder.path, 'pyproject.toml'));
            return text !== undefined && /^\s*\[\s*tool\s*\.\s*"?pyright"?\s*[\].]/m.test(text) && /^\s*extraPaths\s*=/m.test(text);
        },
        extraPaths(folder) {
            const value = vscode.workspace.getConfiguration(EXTRA_PATHS_SECTION, folderUri(folder)).get<unknown>(EXTRA_PATHS_KEY);
            return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
        },
        async writeExtraPaths(folder, paths) {
            await vscode.workspace.getConfiguration(EXTRA_PATHS_SECTION, folderUri(folder))
                .update(EXTRA_PATHS_KEY, paths, vscode.ConfigurationTarget.WorkspaceFolder);
        },
        notifyAdded(folder, added, stop) {
            const what = added.length === 1 ? `an import path (${added[0]})` : `${added.length} import paths`;
            const off = 'Stop Adding Paths';
            void vscode.window.showInformationMessage(
                `${config.displayName} added ${what} to ${EXTRA_PATHS_SECTION}.${EXTRA_PATHS_KEY} of ${folder.name}, from the interpreter that runs its sidecar, `
                + 'so the editor resolves the imports the diagram is drawn from.',
                off
            ).then(choice => (choice === off ? stop() : undefined)).then(undefined, error => log(`python analysis paths: ${String(error)}`));
        },
        notifyLacking(folder, lacking) {
            const copy = 'Copy Paths';
            void vscode.window.showInformationMessage(
                `${config.displayName}: the pyrightconfig.json of ${folder.name} sets the editor's import paths, and lacks ${lacking.length === 1 ? 'one' : lacking.length} `
                + `the sidecar's interpreter imports from: ${lacking.join(', ')}.`,
                copy
            ).then(choice => (choice === copy ? vscode.env.clipboard.writeText(JSON.stringify(lacking, undefined, 4)) : undefined))
                .then(undefined, error => log(`python analysis paths: ${String(error)}`));
        },
        async disable(folder) {
            await vscode.workspace.getConfiguration(config.settingsNamespace, folderUri(folder))
                .update(config.settingKey, false, vscode.ConfigurationTarget.WorkspaceFolder);
            log(`python analysis paths: ${setting} turned off for ${folder.name}`);
        },
        log
    };
}

/**
 * Add what the sidecar's interpreter imports from to the language server's
 * paths, for each source file a diagram tab shows: the tabs open now, and each
 * opened later. Changing the product's settings (the sidecar command, the
 * setting that turns this off) has every file considered again.
 */
export function registerPythonAnalysisPaths(context: vscode.ExtensionContext, config: PythonAnalysisPathsConfig): vscode.Disposable {
    // To the extension host's log: what was written, and why nothing was.
    const log = (message: string): void => console.info(`[${config.settingsNamespace}] ${message}`);
    const paths = new PythonAnalysisPaths(vscodeHost(config, log));
    const considerTab = (tab: vscode.Tab): void => {
        // A custom editor's tab input is `{ viewType, uri }` (vscode.TabInputCustom).
        const input = tab.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
        if (input?.viewType === config.customEditorViewType && input.uri?.scheme === 'file') {
            void paths.consider(input.uri.fsPath);
        }
    };
    const considerAll = (): void => vscode.window.tabGroups.all.forEach(group => group.tabs.forEach(considerTab));
    const subscriptions = [
        vscode.window.tabGroups.onDidChangeTabs(event => event.opened.forEach(considerTab)),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(config.settingsNamespace)) {
                paths.forget();
                considerAll();
            }
        })
    ];
    considerAll();
    const disposable = vscode.Disposable.from(...subscriptions);
    context.subscriptions.push(disposable);
    return disposable;
}
