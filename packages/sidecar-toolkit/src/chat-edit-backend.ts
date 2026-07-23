/**
 * Sidecar implementation of the neutral {@link DiagramEditBackend} chat seam.
 *
 * The diagram chat (extension-core) owns revision caching, conflict-refresh and
 * auto-layout; this module owns the *transport*: resolving the sidecar command
 * from settings, invoking named edits / graph export / capability discovery, and
 * building the out-of-process MCP tool-server descriptor. It maps each seam
 * method 1:1 onto the toolkit's existing sidecar functions.
 *
 * URIs cross the seam as strings (the chat passes `vscode.Uri.toString()`); we
 * round-trip via `URI.parse().fsPath`, matching the diagram model source.
 */

import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import type { BackendCapabilities, DiagramEditBackend, EditResult, McpServerDescriptor } from '@dialogram/shared';
import { exportWorkflowGraph, invokeSidecarOp } from './sidecar-graph-export.js';
import { getSidecarCapabilities, sidecarSupportsOp } from './sidecar-capabilities.js';

export interface SidecarEditBackendConfig {
    settingsNamespace: string;
    sidecarCommandSettingKey: string;
    sidecarCommandDefault: string;
    sidecarOperationPrefix: string;
    /** Graph-export op name (without prefix); differs per runtime. */
    exportOp?: string;
    /** MCP server descriptor name (today the profile key). */
    mcpServerName: string;
    /** Absolute path to the bundled `dist/sidecar-mcp-server.cjs`, from the assets root. */
    mcpServerModulePath: (assetsPath: string) => string;
    /** Kill-switch setting for the MCP tool server. */
    mcpEnabledSetting: { section: string; key: string; default: boolean };
    /** Arg key used to scope ops to a sub-graph (today `'workflow'`). */
    scopeArgKey: string;
}

/** Marker code the sidecar returns when the source changed underneath an edit. */
const CONCURRENT_MODIFICATION_CODE = 'concurrent_source_modification';

function toFsPath(uri: string): string {
    return URI.parse(uri).fsPath;
}

function optionalString(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

/**
 * Build a sidecar-backed {@link DiagramEditBackend} for one runtime profile. All
 * product-specific values arrive through {@link SidecarEditBackendConfig}; this
 * module contains no per-runtime branching.
 */
export function createSidecarEditBackend(cfg: SidecarEditBackendConfig): DiagramEditBackend {
    const resolveSidecarCommand = (uri: string): string => {
        const scope = vscode.Uri.file(toFsPath(uri));
        return (
            vscode.workspace
                .getConfiguration(cfg.settingsNamespace, scope)
                .get<string>(cfg.sidecarCommandSettingKey, cfg.sidecarCommandDefault) ?? cfg.sidecarCommandDefault
        );
    };

    const invokeOptions = (uri: string) => ({
        sidecarCommand: resolveSidecarCommand(uri),
        sidecarOperationPrefix: cfg.sidecarOperationPrefix
    });

    return {
        async exportGraph(uri, opts) {
            const graph = await exportWorkflowGraph(toFsPath(uri), {
                sidecarCommand: resolveSidecarCommand(uri),
                sidecarOperationPrefix: cfg.sidecarOperationPrefix,
                exportOp: cfg.exportOp,
                networkName: opts?.networkName
            });
            return graph ? JSON.stringify(graph) : undefined;
        },

        async listCapabilities(uri): Promise<BackendCapabilities | undefined> {
            const caps = await getSidecarCapabilities(toFsPath(uri), invokeOptions(uri));
            if (!caps) {
                return undefined;
            }
            return {
                protocolVersion: String(caps.protocolVersion),
                ops: [...caps.supportedOps],
                features: Object.keys(caps.features).filter((key) => caps.features[key])
            };
        },

        supportsOp(uri, kind) {
            return sidecarSupportsOp(toFsPath(uri), invokeOptions(uri), kind);
        },

        async applyNamedEdit(uri, kind, args, opts): Promise<EditResult> {
            const builtArgs: Record<string, unknown> = { ...args };
            if (opts?.expectedRevision) {
                builtArgs.expectedRevision = opts.expectedRevision;
            }
            const result = await invokeSidecarOp(toFsPath(uri), invokeOptions(uri), kind, builtArgs);
            const diagnostic = (result.response as { diagnostic?: { code?: string; actualRevision?: unknown } } | undefined)
                ?.diagnostic;
            if (!result.ok) {
                if (diagnostic?.code === CONCURRENT_MODIFICATION_CODE) {
                    return {
                        ok: false,
                        conflict: { actualRevision: optionalString(diagnostic.actualRevision) },
                        message: result.message,
                        response: result.response
                    };
                }
                return { ok: false, message: result.message, response: result.response };
            }
            return {
                ok: true,
                revision: optionalString((result.response as { revision?: unknown } | undefined)?.revision),
                response: result.response
            };
        },

        mcpServers(uri, opts): McpServerDescriptor[] {
            const enabled = vscode.workspace
                .getConfiguration(cfg.mcpEnabledSetting.section)
                .get<boolean>(cfg.mcpEnabledSetting.key, cfg.mcpEnabledSetting.default);
            if (!enabled) {
                return [];
            }
            const filePath = toFsPath(uri);
            const serverPath = cfg.mcpServerModulePath(opts.assetsPath ?? '');
            return [
                {
                    name: cfg.mcpServerName,
                    command: 'node',
                    args: [serverPath],
                    env: {
                        MCP_WORKFLOW_FILE: filePath,
                        MCP_SIDECAR_CMD: resolveSidecarCommand(uri),
                        MCP_OP_PREFIX: cfg.sidecarOperationPrefix,
                        MCP_NETWORK: opts.networkName ?? '',
                        MCP_SERVER_NAME: cfg.mcpServerName,
                        MCP_EXPORT_OP: cfg.exportOp ?? 'exportWorkflowGraph'
                    }
                }
            ];
        },

        scopeArgs(_uri, networkName) {
            return networkName ? { [cfg.scopeArgKey]: networkName } : {};
        }
    };
}
