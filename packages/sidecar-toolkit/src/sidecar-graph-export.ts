/**
 * Workflow graph export via the language sidecar.
 *
 * Invokes the `exportNetworkGraph` sidecar op to obtain the *resolved* graph
 * (nodes, edges, ports, agents) extracted from a workflow source file. This is
 * the same data the diagram renders, and is injected into chat sessions so the
 * agent understands the workflow structure without searching the project.
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up past `__init__.py` files to find the importable package root, so the
 * sidecar can resolve intra-package imports (matches the diagram server).
 */
async function findPackageRootForFile(filePath: string): Promise<string | undefined> {
  let current = path.dirname(filePath);
  for (;;) {
    if (!(await fileExists(path.join(current, '__init__.py')))) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return current;
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (packageRoot) {
      env.PYTHONPATH =
        env.PYTHONPATH && env.PYTHONPATH.trim() !== ''
          ? `${packageRoot}${path.delimiter}${env.PYTHONPATH}`
          : packageRoot;
    }

    const child = cp.spawn(options.sidecarCommand, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: packageRoot ?? path.dirname(filePath),
      env,
    });
    const payload = {
      file: filePath,
      op: `${options.sidecarOperationPrefix}.${opName}`,
      args,
    };
    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });

    if (exitCode !== 0) {
      return { ok: false, message: stderr.trim() || `sidecar exited with ${exitCode}` };
    }
    if (stdout.trim() === '') {
      return { ok: true };
    }
    const response = JSON.parse(stdout.trim());
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (packageRoot) {
      env.PYTHONPATH =
        env.PYTHONPATH && env.PYTHONPATH.trim() !== ''
          ? `${packageRoot}${path.delimiter}${env.PYTHONPATH}`
          : packageRoot;
    }

    const child = cp.spawn(options.sidecarCommand, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: packageRoot ?? path.dirname(filePath),
      env,
    });

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
    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });

    if (exitCode !== 0 || stdout.trim() === '') {
      return undefined;
    }

    const response = JSON.parse(stdout);
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
