/**
 * Sidecar-registry READ tools, as in-process chat tools.
 *
 * These express sidecar knowledge the GLSP GModel does not carry (the type
 * registry, the elaboration verdict), so they cannot become GModel operations —
 * they are bridged as read-only diagram-scope MCP tools by the platform adapter.
 *
 * Each tool's `handler(file, args)` receives the session's ABSOLUTE file path
 * (the platform adapter converts the GLSP `sourceUri` to an fsPath before the
 * call — see `mcp-platform-tool-adapter.ts`), maps the exposed `network` arg
 * onto the runtime's `scopeArgKey`, invokes a sidecar op through the injected
 * `invoke` seam, and renders the result as text.
 *
 * The 5 graph-mutation tools (`create_node`, `connect`, `rename_node`,
 * `delete_node`, `update_node_parameter`) are NOT assembled here — they became
 * GLSP-MCP built-ins whose GLSP operations ride our operation handlers →
 * sidecar → reversible workspace edit (free undo/redo).
 */

import type { SidecarOpResult } from './sidecar-graph-export.js';
import type { InProcessChatTool } from '@dialogram/shared';
import { summarizeValidation } from './validation-summary.js';

/**
 * Structural twin of the platform's `InProcessChatTool` (kept local so the
 * toolkit needs no `@dialogram/extension-core` dependency). `handler` receives
 * the session's absolute file path and the tool args and returns text.
 */
/** A registry tool is an in-process chat tool, the platform's own shape. */
export type RegistryChatTool = InProcessChatTool;

/** Injected sidecar transport: invoke `<prefix>.<opName>` for `file` with `args`. */
export type RegistrySidecarInvoke = (
  file: string,
  opName: string,
  args: Record<string, unknown>
) => Promise<SidecarOpResult>;

export interface RegistryToolsConfig {
  /** Sidecar transport seam (the profile binds it to `invokeSidecarOp` with a resolved command). */
  invoke: RegistrySidecarInvoke;
  /** Graph-export op name (without prefix); differs per runtime. Defaults to `exportWorkflowGraph`. */
  exportOp?: string;
  /** Arg key used to scope ops to a sub-graph (today `'workflow'`). */
  scopeArgKey: string;
  /**
   * Offer `get_graph` alone. For a transport that answers with a graph and
   * nothing else -- a read-only profile whose graph comes from the CLI -- the
   * registry listings and the validation verdict have no one to ask.
   */
  graphOnly?: boolean;
}

const networkProp = {
  network: { type: 'string', description: 'Optional workflow/network name within the file.' },
};

/** Render a sidecar op result as agent-facing text (mirrors the stdio server). */
function renderResult(result: SidecarOpResult): string {
  if (!result.ok) {
    return `Error: ${result.message ?? 'sidecar error'}`;
  }
  return JSON.stringify(result.response ?? { status: 'ok' }, null, 2);
}

export function createRegistryChatTools(cfg: RegistryToolsConfig): RegistryChatTool[] {
  const exportOp = cfg.exportOp ?? 'exportWorkflowGraph';

  /** Map the exposed `network` arg onto the runtime's scope key; pass the rest through. */
  const scope = (args: Record<string, unknown>): Record<string, unknown> => {
    const { network, ...rest } = args;
    if (network !== undefined && network !== null && String(network).trim() !== '') {
      return { [cfg.scopeArgKey]: network, ...rest };
    }
    return rest;
  };

  const readTool = (
    name: string,
    description: string,
    opName: string,
    extraProps: Record<string, unknown> = {},
    required?: string[]
  ): RegistryChatTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { ...extraProps, ...networkProp }, ...(required ? { required } : {}) },
    handler: async (file, args) => renderResult(await cfg.invoke(file, opName, scope(args))),
  });

  // Returns the RAW resolved graph as
  // JSON (the GModel `diagram-model`/`query-elements` built-ins expose the GModel, not the
  // sidecar's raw export). Non-mutating and bridgeable; mirrors `validate_workflow`'s transport
  // but renders the export payload verbatim instead of summarizing it.
  const getGraph = readTool(
    'get_graph',
    'Export the current file as a resolved graph (JSON): the workflow/network with its nodes, edges, and their resolved types and ports. Use this to inspect the full structure before or after editing.',
    exportOp
  );
  if (cfg.graphOnly) {
    return [getGraph];
  }

  return [
    readTool(
      'list_task_types',
      'List the task types defined/available in the workflow (the types you can instantiate as nodes).',
      'listTaskTypes'
    ),
    readTool('list_workflow_types', 'List the workflow types available in the file.', 'listWorkflowTypes'),
    readTool('list_nodes', 'List the instance (node) names currently in the workflow graph.', 'listInstanceNames'),
    getGraph,
    {
      name: 'validate_workflow',
      description:
        'Parse and elaborate the current file and report problems as a compact verdict: {ok, partial, problems, errors[], elements[]}, where errors are file-level and elements are per-node/edge diagnostics with source locations. Call this AFTER editing the file to check your work, then fix what it reports and re-validate until ok is true.',
      inputSchema: { type: 'object', properties: { ...networkProp } },
      handler: async (file, args) => {
        const result = await cfg.invoke(file, exportOp, scope(args));
        return JSON.stringify(summarizeValidation(result.response), null, 2);
      },
    },
    // Type creation is a reversible GLSP operation tool (`create-task-type`), undoable via the
    // editor's undo stack, so it is not assembled as an in-process chat tool here.
  ];
}
