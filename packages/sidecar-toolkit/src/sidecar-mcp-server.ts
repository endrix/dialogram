/**
 * Sidecar MCP server (stdio) — profile-agnostic.
 *
 * A small, dependency-free Model Context Protocol server that exposes a
 * workflow/network sidecar's graph operations as tools to an agent (opencode).
 * It is spawned by the agent — configured via the ACP session's `mcpServers` —
 * and scoped to a single workflow file passed through the environment.
 *
 * The same binary serves every runtime profile: the sidecar
 * command and the operation prefix are supplied via the environment, so the
 * tool calls dispatch to `<prefix>.<op>` on the configured sidecar.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 *
 * Environment:
 *   MCP_WORKFLOW_FILE  absolute path of the workflow .py file (required)
 *   MCP_SIDECAR_CMD    sidecar executable (the configured sidecar command)
 *   MCP_OP_PREFIX      sidecar operation prefix (the product op prefix your extension profile supplies)
 *   MCP_NETWORK        optional default network/workflow name within the file
 *   MCP_SERVER_NAME    optional MCP server name reported on initialize
 */

import * as cp from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Read a required environment variable. The spawner (the chat runtime that
 * launches this server) always sets MCP_SIDECAR_CMD and MCP_OP_PREFIX; a
 * missing value is a misconfiguration, so
 * fail loudly rather than silently impersonating a specific runtime.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`sidecar-mcp-server: missing required environment variable ${name}\n`);
    process.exit(2);
  }
  return value;
}

const WORKFLOW_FILE = process.env.MCP_WORKFLOW_FILE ?? '';
const SIDECAR_CMD = requireEnv('MCP_SIDECAR_CMD');
const OP_PREFIX = requireEnv('MCP_OP_PREFIX');
const DEFAULT_NETWORK = process.env.MCP_NETWORK ?? '';
const SERVER_NAME = process.env.MCP_SERVER_NAME ?? OP_PREFIX;
// Graph-export op differs per runtime; the spawner supplies it via MCP_EXPORT_OP.
const EXPORT_OP = process.env.MCP_EXPORT_OP ?? 'exportWorkflowGraph';
const SERVER_PROTOCOL_VERSION = '2025-06-18';

function findPackageRoot(filePath: string): string {
  let current = path.dirname(filePath);
  for (;;) {
    if (!existsSync(path.join(current, '__init__.py'))) break;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(filePath);
    current = parent;
  }
  return current;
}

/** Invoke a single sidecar op. Returns the parsed response (never throws). */
function invokeSidecar(op: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    try {
      const packageRoot = WORKFLOW_FILE ? findPackageRoot(WORKFLOW_FILE) : process.cwd();
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.PYTHONPATH = env.PYTHONPATH ? `${packageRoot}${path.delimiter}${env.PYTHONPATH}` : packageRoot;

      const child = cp.spawn(SIDECAR_CMD, [], {
        cwd: packageRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => resolve({ status: 'error', message: e.message }));
      child.on('close', (code) => {
        if (stdout.trim() === '') {
          resolve(code === 0 ? { status: 'ok' } : { status: 'error', message: stderr.trim() || `exit ${code}` });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ status: 'error', message: stderr.trim() || 'invalid sidecar response' });
        }
      });
      child.stdin.write(JSON.stringify({ file: WORKFLOW_FILE, op: `${OP_PREFIX}.${op}`, args }) + '\n');
      child.stdin.end();
    } catch (e) {
      resolve({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Merge the default network into args unless the caller overrides it. */
function withNetwork(args: Record<string, unknown>): Record<string, unknown> {
  if (DEFAULT_NETWORK && args.workflow === undefined && args.network === undefined) {
    return { workflow: DEFAULT_NETWORK, ...args };
  }
  return args;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Maps the tool call to (sidecar-op, args). */
  run: (args: Record<string, unknown>) => Promise<any>;
}

const networkProp = {
  network: { type: 'string', description: 'Optional workflow/network name within the file.' },
};

/**
 * Locate the graph container inside an export response. Runtimes nest it
 * differently (some under `diagnostic.graph`, others at the top level or under
 * `graph`/`result`), so probe the known shapes and pick the first object that
 * actually carries a `nodes`/`edges` array.
 */
function findGraphContainer(result: any): any {
  const candidates = [
    result?.diagnostic?.graph,
    result?.graph,
    result?.result?.graph,
    result?.result,
    result,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && (Array.isArray(c.nodes) || Array.isArray(c.edges))) {
      return c;
    }
  }
  return undefined;
}

/**
 * Distill an export response into a compact validation verdict the agent can act
 * on: an overall pass/fail plus file-level errors and per-element diagnostics
 * (with source locations). Reuses the partial-graph diagnostics the sidecars
 * already emit (`graph.partial`, `graph.errors[]`, per-node/edge
 * `meta.diagnostics` / `isErrored`). Intentionally does NOT set `status:'error'`
 * so the full structured verdict reaches the model (the MCP layer collapses an
 * errored result to just its message).
 */
function summarizeValidation(result: any): Record<string, unknown> {
  const graph = findGraphContainer(result);
  const errors: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];

  if (!graph) {
    // No graph came back at all — the file could not be parsed/elaborated.
    errors.push({
      severity: 'error',
      code: result?.diagnostic?.code ?? 'export_failed',
      message: result?.message ?? result?.diagnostic?.message ?? 'Could not elaborate the file.',
      location: null,
    });
    return { ok: false, partial: true, problems: 1, summary: '1 problem found (file did not elaborate).', errors, elements };
  }

  for (const e of (Array.isArray(graph.errors) ? graph.errors : [])) {
    errors.push({
      severity: e?.severity ?? 'error',
      code: e?.code,
      message: e?.message,
      location: e?.location ?? null,
    });
  }

  const scan = (arr: any[], kind: 'node' | 'edge'): void => {
    for (const el of (Array.isArray(arr) ? arr : [])) {
      const meta = el?.meta ?? el?.metadata ?? {};
      const diagnostics = Array.isArray(meta.diagnostics) ? meta.diagnostics : [];
      const errored = meta.isErrored === true || diagnostics.some((d: any) => d?.severity === 'error');
      if (diagnostics.length > 0 || errored) {
        elements.push({
          kind,
          id: el?.id ?? el?.name,
          errored,
          diagnostics,
          location: el?.location ?? null,
        });
      }
    }
  };
  scan(graph.nodes, 'node');
  scan(graph.edges, 'edge');

  const partial = graph.partial === true;
  const erroredElements = elements.filter((e) => e.errored).length;
  const problems = errors.filter((e) => e.severity === 'error').length + erroredElements;
  const ok = !partial && problems === 0;
  return {
    ok,
    partial,
    problems,
    summary: ok
      ? 'Validation passed: the file elaborates cleanly.'
      : `${problems} problem(s) found${partial ? ' (graph is partial)' : ''}.`,
    errors,
    elements,
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_task_types',
    description: 'List the task types defined/available in the workflow (the types you can instantiate as nodes).',
    inputSchema: { type: 'object', properties: networkProp },
    run: (a) => invokeSidecar('listTaskTypes', withNetwork(a)),
  },
  {
    name: 'list_workflow_types',
    description: 'List the workflow types available in the file.',
    inputSchema: { type: 'object', properties: networkProp },
    run: (a) => invokeSidecar('listWorkflowTypes', withNetwork(a)),
  },
  {
    name: 'list_nodes',
    description: 'List the instance (node) names currently in the workflow graph.',
    inputSchema: { type: 'object', properties: networkProp },
    run: (a) => invokeSidecar('listInstanceNames', withNetwork(a)),
  },
  {
    name: 'get_graph',
    description: 'Export the resolved graph (nodes, edges, ports) as JSON. Use this to understand current structure.',
    inputSchema: { type: 'object', properties: networkProp },
    run: (a) => invokeSidecar(EXPORT_OP, withNetwork(a)),
  },
  {
    name: 'validate_workflow',
    description:
      'Parse and elaborate the current file and report problems as a compact verdict: {ok, partial, problems, errors[], elements[]}, where errors are file-level and elements are per-node/edge diagnostics with source locations. Call this AFTER editing the file (e.g. after writing a new actor/task, its actions, guards, or scheduling) to check your work, then fix what it reports and re-validate until ok is true. Prefer this over get_graph for verifying correctness.',
    inputSchema: { type: 'object', properties: networkProp },
    run: async (a) => summarizeValidation(await invokeSidecar(EXPORT_OP, withNetwork(a))),
  },
  {
    name: 'create_task_type',
    description:
      'Scaffold a NEW component type (a task or actor, per the runtime) in the file. Provide name and (optionally) input/output ports. After scaffolding, edit the generated class to implement its behavior, then validate with get_graph.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Class name of the new task type.' },
        inputs: { type: 'array', items: { type: 'string' }, description: 'Input port names.' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Output port names.' },
        ...networkProp,
      },
      required: ['name'],
    },
    run: (a) => invokeSidecar('createTaskType', withNetwork(a)),
  },
  {
    name: 'create_node',
    description: 'Instantiate an existing task type as a node in the workflow graph.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Task type to instantiate.' },
        name: { type: 'string', description: 'Instance (node) name.' },
        params: { type: 'object', description: 'Optional parameters.' },
        ...networkProp,
      },
      required: ['type', 'name'],
    },
    run: (a) => invokeSidecar('createNode', withNetwork(a)),
  },
  {
    name: 'connect',
    description: 'Connect a source node/port to a target node/port.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        ...networkProp,
      },
      required: ['source', 'target'],
    },
    run: (a) => invokeSidecar('connect', withNetwork(a)),
  },
  {
    name: 'rename_node',
    description: 'Rename an existing node.',
    inputSchema: {
      type: 'object',
      properties: { oldName: { type: 'string' }, newName: { type: 'string' }, ...networkProp },
      required: ['oldName', 'newName'],
    },
    run: (a) => invokeSidecar('renameNode', withNetwork(a)),
  },
  {
    name: 'delete_node',
    description: 'Delete a node from the workflow graph.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, ...networkProp },
      required: ['name'],
    },
    run: (a) => invokeSidecar('deleteNode', withNetwork(a)),
  },
  {
    name: 'update_node_parameter',
    description: "Update a node's parameters.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, params: { type: 'object' }, ...networkProp },
      required: ['name'],
    },
    run: (a) => invokeSidecar('updateNodeParameter', withNetwork(a)),
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};
  // Notifications have no id and need no response.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? SERVER_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    case 'tools/call': {
      const tool = toolByName.get(params?.name);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      const result = await tool.run(params?.arguments ?? {});
      const isError = result?.status === 'error';
      const text =
        isError && typeof result?.message === 'string'
          ? `Error: ${result.message}`
          : JSON.stringify(result, null, 2);
      reply(id, { content: [{ type: 'text', text }], isError });
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// Read newline-delimited JSON messages from stdin.
let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
