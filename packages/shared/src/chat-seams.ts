/**
 * Neutral chat edit/graph/capability seam.
 *
 * The diagram chat (extension-host) owns revision caching, conflict-refresh and
 * auto-layout; the *transport* — how a named edit reaches the source file, how
 * the graph is exported, which out-of-process tool servers back the chat — is
 * supplied by a consumer-provided {@link DiagramEditBackend}.
 *
 * This module is vscode-free and browser-safe on purpose: URIs cross the seam as
 * STRINGS (core passes `vscode.Uri.toString()`; the sidecar implementation
 * round-trips via `URI.parse().fsPath`, the same pattern the diagram model
 * source already uses). That keeps the interface in `@dialogram/shared` so the
 * toolkit can implement it without any extension-core type dependency.
 */

/** Optimistic-concurrency conflict detail (source changed underneath the chat). */
export interface EditConflict {
    actualRevision?: string;
}

/** Outcome of a single named edit applied through the backend. */
export interface EditResult {
    ok: boolean;
    revision?: string;
    /** Set when the backend detected a concurrent source modification. */
    conflict?: EditConflict;
    message?: string;
    /** Raw op response for callers that need the unshaped payload. */
    response?: unknown;
}

/** Capabilities the backend's runtime advertises (contract v2). */
export interface BackendCapabilities {
    protocolVersion?: string;
    ops?: string[];
    features?: string[];
}

/** Spawn descriptor for an out-of-process MCP tool server scoped to one file. */
export interface McpServerDescriptor {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
}

/**
 * Consumer-supplied edit/graph/capability backend for the diagram chat.
 * Core owns revision caching, conflict-refresh and auto-layout; the backend
 * owns transport.
 */
export interface DiagramEditBackend {
    exportGraph(uri: string, opts?: { networkName?: string }): Promise<string | undefined>;
    listCapabilities(uri: string): Promise<BackendCapabilities | undefined>;
    supportsOp(uri: string, kind: string): Promise<boolean>;
    applyNamedEdit(
        uri: string,
        kind: string,
        args: Record<string, unknown>,
        opts?: { expectedRevision?: string }
    ): Promise<EditResult>;
    /** Spawn descriptors for out-of-process MCP tool servers scoped to this file; empty when disabled. */
    mcpServers(uri: string, opts: { networkName?: string; assetsPath?: string }): McpServerDescriptor[];
    /** The arg key + value used to scope ops to a sub-graph (today: `{ workflow: <networkName> }`). */
    scopeArgs(uri: string, networkName: string | undefined): Record<string, unknown>;
}
