/**
 * Workflow graph export via the language sidecar.
 *
 * Invokes the `exportNetworkGraph` sidecar op to obtain the *resolved* graph
 * (nodes, edges, ports, agents) extracted from a workflow source file. This is
 * the same data the diagram renders, and is injected into chat sessions so the
 * agent understands the workflow structure without searching the project.
 */

import * as path from 'node:path';
import { describeChildFailure, runChildProcess } from './run-child-process.js';
import { findPackageRootForFile, withPythonPackageRoot } from './server/source-files.js';

export interface WorkflowGraphExportOptions {
  /** Sidecar executable (the configured sidecar command). */
  sidecarCommand: string;
  /** Operation namespace prefix (the product op prefix your extension profile supplies). */
  sidecarOperationPrefix: string;
  /** Optional specific network/workflow name within the file. */
  networkName?: string;
  /**
   * The graph-export op name (without prefix). Differs per runtime, so the caller
   * supplies it. Defaults to `exportWorkflowGraph` for backward compatibility.
   */
  exportOp?: string;
}


export interface SidecarOpResult {
  ok: boolean;
  message?: string;
  response?: any;
}

/**
 * Invoke an arbitrary mutating sidecar operation (createNode, connect, …) for a
 * workflow file. The sidecar validates the request and edits the source file on
 * disk; it returns `{ status: 'ok' | 'error' }`. Never throws.
 */
export async function invokeSidecarOp(
  filePath: string,
  options: { sidecarCommand: string; sidecarOperationPrefix: string },
  opName: string,
  args: Record<string, unknown>
): Promise<SidecarOpResult> {
  try {
    const packageRoot = await findPackageRootForFile(filePath);
    const env = withPythonPackageRoot(process.env, packageRoot);

    const payload = {
      file: filePath,
      op: `${options.sidecarOperationPrefix}.${opName}`,
      args,
    };

    const result = await runChildProcess(options.sidecarCommand, [], {
      cwd: packageRoot ?? path.dirname(filePath),
      env,
      input: JSON.stringify(payload) + '\n',
    });

    const failure = describeChildFailure(options.sidecarCommand, result);
    if (failure) {
      return {
        ok: false,
        message: result.spawnError || result.timedOut
          ? failure
          : result.stderr.trim() || `sidecar exited with ${result.code}`,
      };
    }
    if (result.stdout.trim() === '') {
      return { ok: true };
    }
    const response = JSON.parse(result.stdout.trim());
    if (response?.status === 'ok') {
      return { ok: true, response };
    }
    return {
      ok: false,
      response,
      message: typeof response?.message === 'string' ? response.message : `sidecar rejected ${opName}`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Export the resolved graph for a workflow file. Returns the graph object
 * (with `nodes`, `edges`, …) or undefined if the sidecar is unavailable or
 * fails. Never throws.
 */
export async function exportWorkflowGraph(
  filePath: string,
  options: WorkflowGraphExportOptions
): Promise<Record<string, unknown> | undefined> {
  try {
    const packageRoot = await findPackageRootForFile(filePath);
    const env = withPythonPackageRoot(process.env, packageRoot);

    const payload = {
      file: filePath,
      // The graph-export op name differs per runtime; the caller supplies it via
      // `options.exportOp`. Both variants return `diagnostic.graph`.
      op: `${options.sidecarOperationPrefix}.${options.exportOp ?? 'exportWorkflowGraph'}`,
      args:
        options.networkName && options.networkName.trim() !== ''
          ? { network: options.networkName.trim() }
          : {},
    };

    const result = await runChildProcess(options.sidecarCommand, [], {
      cwd: packageRoot ?? path.dirname(filePath),
      env,
      input: JSON.stringify(payload) + '\n',
    });

    if (result.code !== 0 || result.stdout.trim() === '') {
      return undefined;
    }

    const response = JSON.parse(result.stdout);
    if (response?.status !== 'ok') {
      return undefined;
    }
    const graph = response?.diagnostic?.graph;
    if (!graph || typeof graph !== 'object') {
      return undefined;
    }
    return graph as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
