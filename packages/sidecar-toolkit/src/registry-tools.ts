/**
 * Sidecar-registry READ tools, as in-process chat tools (T7, GLSP-MCP Phase B).
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
import { summarizeValidation } from './validation-summary.js';

/**
 * Structural twin of the platform's `InProcessChatTool` (kept local so the
 * toolkit needs no `@dialogram/extension-core` dependency). `handler` receives
 * the session's absolute file path and the tool args and returns text.
 */
export interface RegistryChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(file: string, args: Record<string, unknown>): Promise<string>;
}

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

  return [
    readTool(
      'list_task_types',
      'List the task types defined/available in the workflow (the types you can instantiate as nodes).',
      'listTaskTypes'
    ),
    readTool('list_workflow_types', 'List the workflow types available in the file.', 'listWorkflowTypes'),
    readTool('list_nodes', 'List the instance (node) names currently in the workflow graph.', 'listInstanceNames'),
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
    readTool(
      'create_task_type',
      'Scaffold a NEW component type (a task or actor, per the runtime) in the file. Provide name and (optionally) input/output ports. NOTE: this edits the source file directly and is NOT undoable via the diagram undo/redo (it is a source scaffold, not a GLSP operation). After scaffolding, edit the generated class to implement its behavior, then validate.',
      'createTaskType',
      {
        name: { type: 'string', description: 'Class name of the new task type.' },
        inputs: { type: 'array', items: { type: 'string' }, description: 'Input port names.' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Output port names.' },
      },
      ['name']
    ),
  ];
}
