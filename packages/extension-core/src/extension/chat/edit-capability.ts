/**
 * The diagram-profile chat contribution: the data the unified ChatRuntime
 * consumes to drive chat around the edit backend — slash commands mapping to
 * real edit-backend ops (with capability
 * gating, optimistic concurrency and diagram refresh), the graph context
 * provider, the in-process MCP tool descriptors, the keyword view-ops post-turn hook
 * and the debounced auto-layout.
 *
 * Commands whose legacy implementation was a stub (validate, analyze, …) are
 * deliberately NOT carried over: they reported success without doing anything.
 */
import * as vscode from 'vscode';
import type { DiagramEditBackend } from '@dialogram/shared';
import type { DiagramProfile } from '../../api';
import type { WorkflowEditorProvider } from '../diagram/diagram-editor-provider';
import { getChatSetting } from '../legacy-settings-compat';
import type { ChatCommandContext, ChatCommandContribution, ChatCommandResult } from './slash-commands';

export interface EditChatCapabilityDeps {
    profile: DiagramProfile;
    editBackend: DiagramEditBackend;
    getEditorProvider(): WorkflowEditorProvider | undefined;
    log(message: string): void;
}

export interface EditChatCapability {
    slashCommands: ChatCommandContribution[];
    graphContextProvider(file: string): Promise<string | undefined>;
    postTurnHook(file: string, text: string): Promise<void>;
    dispose(): void;
}

/** Default node-creation commands when the chat config supplies none. */
const DEFAULT_NODE_COMMANDS: Array<{ command: string; nodeType: string; description: string }> = [
    { command: 'create-task', nodeType: 'task', description: 'Create a new task node' },
    { command: 'create-agent', nodeType: 'agent', description: 'Create a new agent node' },
    { command: 'create-viewer', nodeType: 'viewer', description: 'Create a new viewer node' },
    { command: 'create-workflow', nodeType: 'workflow', description: 'Create a new workflow node' }
];

const AUTO_LAYOUT_DEBOUNCE_MS = 400;
const VIEW_OP_SETTLE_MS = 500;

export function createEditChatCapability(deps: EditChatCapabilityDeps): EditChatCapability {
    const { profile, editBackend } = deps;

    /** Last source revision the chat saw per file (optimistic concurrency). */
    const sourceRevisionCache = new Map<string, string>();
    let autoLayoutTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleAutoLayout = (uri: vscode.Uri): void => {
        const enabled = getChatSetting<boolean>('autoLayoutAfterEdits', false);
        if (!enabled) {
            return;
        }
        if (autoLayoutTimer) {
            clearTimeout(autoLayoutTimer);
        }
        autoLayoutTimer = setTimeout(() => {
            autoLayoutTimer = undefined;
            void vscode.commands.executeCommand(profile.commands.layoutDiagramIfNeeded, uri.toString());
            deps.log('auto-layout triggered after agent edits');
        }, AUTO_LAYOUT_DEBOUNCE_MS);
    };

    /** Run one named edit against the backend, mirroring the legacy semantics. */
    const runOp = async (
        opName: string,
        extraArgs: Record<string, unknown>,
        ctx: ChatCommandContext
    ): Promise<ChatCommandResult> => {
        const uri = vscode.Uri.file(ctx.file);
        if (!(await editBackend.supportsOp(uri.toString(), opName))) {
            return {
                success: false,
                error: `'${opName}' isn't supported by the ${profile.displayName} runtime.`
            };
        }
        const network = deps.getEditorProvider()?.getRefreshContext(uri)?.networkName;
        const builtArgs = { ...editBackend.scopeArgs(uri.toString(), network), ...extraArgs };
        const enforceRevision = getChatSetting<boolean>('checkSourceRevision', false);
        const knownRevision = sourceRevisionCache.get(ctx.file);
        const expectedRevision = enforceRevision && knownRevision ? knownRevision : undefined;
        const result = await editBackend.applyNamedEdit(uri.toString(), opName, builtArgs, { expectedRevision });
        if (!result.ok) {
            if (result.conflict) {
                deps.getEditorProvider()?.refreshModelFromDisk(uri);
                sourceRevisionCache.set(ctx.file, String(result.conflict.actualRevision ?? ''));
                deps.log(`concurrent modification on ${ctx.file}; reloaded for retry`);
                return {
                    success: false,
                    error: 'The workflow file changed since the chat last read it — the diagram was reloaded. Please retry.'
                };
            }
            return { success: false, error: result.message ?? `The edit backend rejected ${opName}` };
        }
        if (result.revision) {
            sourceRevisionCache.set(ctx.file, String(result.revision));
        }
        deps.getEditorProvider()?.refreshModelFromDisk(uri);
        scheduleAutoLayout(uri);
        return { success: true };
    };

    const positional = (args: Record<string, any>, index: number): string | undefined =>
        args._positional?.[index];

    const slashCommands: ChatCommandContribution[] = [];

    for (const nc of profile.chat?.nodeCommands ?? DEFAULT_NODE_COMMANDS) {
        slashCommands.push({
            command: nc.command,
            description: nc.description,
            usage: '<name>',
            modes: ['build'],
            handler: async (args, ctx) => {
                const name = args.name || positional(args, 0);
                if (!name) {
                    return {
                        success: false,
                        error: `Please provide a name for the ${nc.nodeType}. Usage: /${nc.command} <name>`
                    };
                }
                return runOp('createNode', { type: nc.nodeType, name, params: {} }, ctx);
            }
        });
    }

    slashCommands.push({
        command: 'connect',
        description: 'Connect two nodes',
        usage: '<source> <target>',
        modes: ['build'],
        handler: async (args, ctx) => {
            const source = args.source || positional(args, 0);
            const target = args.target || positional(args, 1);
            if (!source || !target) {
                return {
                    success: false,
                    error: 'Please provide source and target nodes. Usage: /connect <source> <target>'
                };
            }
            return runOp('connect', { source, target }, ctx);
        }
    });

    slashCommands.push({
        command: 'delete',
        description: 'Delete a node',
        usage: '<name>',
        modes: ['build'],
        handler: async (args, ctx) => {
            const name = args.name || positional(args, 0);
            if (!name) {
                return { success: false, error: 'Please provide a node name to delete. Usage: /delete <name>' };
            }
            return runOp('deleteNode', { name }, ctx);
        }
    });

    slashCommands.push({
        command: 'delete-selected',
        description: 'Delete all selected nodes',
        modes: ['build'],
        handler: async (_args, ctx) => {
            if (ctx.selectedNodeIds.length === 0) {
                return { success: false, error: 'No nodes selected. Please select nodes to delete.' };
            }
            for (const id of ctx.selectedNodeIds) {
                const result = await runOp('deleteNode', { name: id }, ctx);
                if (!result.success) {
                    return result;
                }
            }
            return { success: true };
        }
    });

    slashCommands.push({
        command: 'rename',
        description: 'Rename a node',
        usage: '<oldName> <newName>',
        modes: ['build'],
        handler: async (args, ctx) => {
            const oldName = args.oldName || positional(args, 0);
            const newName = args.newName || positional(args, 1);
            if (!oldName || !newName) {
                return {
                    success: false,
                    error: 'Please provide the current and the new name. Usage: /rename <oldName> <newName>'
                };
            }
            return runOp('renameNode', { oldName, newName }, ctx);
        }
    });

    slashCommands.push({
        command: 'update',
        description: 'Update node parameters',
        usage: '<name> key=value …',
        modes: ['build'],
        handler: async (args, ctx) => {
            const name = args.name || positional(args, 0);
            if (!name) {
                return {
                    success: false,
                    error: 'Please provide a node name to update. Usage: /update <name> param=value'
                };
            }
            const params = { ...args };
            delete params.name;
            delete params._positional;
            return runOp('updateNodeParameter', { name, params }, ctx);
        }
    });

    slashCommands.push({
        command: 'layout',
        description: 'Apply automatic layout',
        handler: async () => {
            try {
                await vscode.commands.executeCommand(profile.commands.layoutDiagram);
                return { success: true };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        }
    });

    return {
        slashCommands,

        async graphContextProvider(file: string): Promise<string | undefined> {
            try {
                const uri = vscode.Uri.file(file).toString();
                void editBackend.listCapabilities(uri).then(caps => {
                    if (caps) {
                        deps.log(
                            `backend capabilities (v${caps.protocolVersion}): ${caps.ops?.length ?? 0} ops; ` +
                                `features=${JSON.stringify(caps.features)}`
                        );
                    } else {
                        deps.log('backend capabilities: unavailable (pre-v2 backend) — gating disabled');
                    }
                }).catch(() => undefined);
                const graph = await editBackend.exportGraph(uri);
                if (graph) {
                    deps.log(`workflow graph exported for context (${file})`);
                    return graph;
                }
                return undefined;
            } catch {
                return undefined;
            }
        },

        /** After a free-text turn: run diagram VIEW ops the prompt asked for. */
        async postTurnHook(_file: string, text: string): Promise<void> {
            if (typeof text !== 'string' || text.trim() === '') {
                return;
            }
            const lower = text.toLowerCase();
            const ops: Array<{ test: RegExp; command: string; label: string }> = [
                { test: /\b(?:auto-?)?lay\s?out\b/, command: profile.commands.layoutDiagram, label: 'layout' },
                { test: /\bcent(?:er|re)\b/, command: profile.commands.center, label: 'center' },
                { test: /\bfit(?:\s+to\s+screen)?\b/, command: profile.commands.fitToScreen, label: 'fit to screen' }
            ];
            const toRun = ops.filter(op => op.test.test(lower));
            if (toRun.length === 0) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, VIEW_OP_SETTLE_MS));
            for (const op of toRun) {
                try {
                    await vscode.commands.executeCommand(op.command);
                    deps.log(`diagram op from prompt: ${op.label}`);
                } catch (err) {
                    deps.log(`diagram op '${op.label}' failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        },

        dispose(): void {
            if (autoLayoutTimer) {
                clearTimeout(autoLayoutTimer);
                autoLayoutTimer = undefined;
            }
        }
    };
}
