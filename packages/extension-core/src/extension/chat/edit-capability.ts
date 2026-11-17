/**
 * The diagram-profile chat contribution: the data the unified ChatRuntime
 * consumes to drive chat around the edit backend — slash commands, each one
 * call of the diagram's GLSP-MCP tools (the agent's own, so undoable and honest
 * about what they did), the graph context provider, the keyword view-ops
 * post-turn hook and the debounced auto-layout.
 *
 * Commands whose legacy implementation was a stub (validate, analyze, …) are
 * deliberately NOT carried over: they reported success without doing anything.
 */
import * as vscode from 'vscode';
import { WorkflowDiagramTypes, type DiagramEditBackend } from '@dialogram/shared';
import type { DiagramProfile } from '../../api';
import type { WorkflowEditorProvider } from '../diagram/diagram-editor-provider';
import type { ChatCommandContext, ChatCommandContribution, ChatCommandResult } from './slash-commands';
import { GlspMcpClient } from './glsp-mcp-client';

/**
 * The platform-wide chat settings section. Shared by every reader of a core
 * chat setting so the key is spelled in one place.
 */
export const CORE_CHAT_SECTION = 'dialogram.chat';

export interface EditChatCapabilityDeps {
    profile: DiagramProfile;
    editBackend: DiagramEditBackend;
    getEditorProvider(): WorkflowEditorProvider | undefined;
    log(message: string): void;
    /** The diagram's GLSP-MCP server, which the slash commands edit through; none, and they say so. */
    mcpServerUrl?: string;
    /** A client of it (the tests stand one in); one is made from the URL otherwise. */
    mcpClient?: Pick<GlspMcpClient, 'callTool'>;
}

export interface EditChatCapability {
    slashCommands: ChatCommandContribution[];
    graphContextProvider(file: string): Promise<string | undefined>;
    postTurnHook(file: string, text: string): Promise<void>;
    dispose(): void;
}

const AUTO_LAYOUT_DEBOUNCE_MS = 400;
const VIEW_OP_SETTLE_MS = 500;

export function createEditChatCapability(deps: EditChatCapabilityDeps): EditChatCapability {
    const { profile, editBackend } = deps;

    let autoLayoutTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleAutoLayout = (uri: vscode.Uri): void => {
        const enabled = vscode.workspace.getConfiguration(CORE_CHAT_SECTION).get<boolean>('autoLayoutAfterEdits', false);
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

    /**
     * The diagram's GLSP-MCP tools, the ones the agent edits with: the same handlers a gesture
     * in the diagram reaches, the editor's undo, and an answer saying what was done or why not.
     * The commands used to send their own producer requests, whose arguments had drifted from
     * what the producer takes (`/rename` sent `oldName`, `/connect` named whole nodes), past
     * undo; now each is the person's shorthand for one tool call.
     */
    const tools = deps.mcpServerUrl ? (deps.mcpClient ?? new GlspMcpClient(deps.mcpServerUrl)) : undefined;

    /** The GLSP-MCP session of the diagram showing this file: the one in this editor, or any. */
    const sessionFor = async (ctx: ChatCommandContext): Promise<string | undefined> => {
        const listed = await tools!.callTool('session-info', {});
        const rows = (listed.structured?.sessions as Array<{ sessionId?: string; sourceUri?: string; readOnly?: boolean }> | undefined) ?? [];
        const shown = rows.filter(row => {
            try {
                return !!row.sourceUri && vscode.Uri.parse(row.sourceUri).fsPath === vscode.Uri.file(ctx.file).fsPath;
            } catch {
                return false;
            }
        });
        const current = deps.getEditorProvider()?.getClientIdForDocumentUri?.(vscode.Uri.file(ctx.file));
        return (shown.find(row => row.sessionId === current) ?? shown.find(row => !row.readOnly) ?? shown[0])?.sessionId;
    };

    /** One tool call on the diagram of the chat's file; its answer is the command's. */
    const callTool = async (ctx: ChatCommandContext, tool: string, args: Record<string, unknown>): Promise<ChatCommandResult> => {
        if (!tools) {
            return {
                success: false,
                error: `Slash commands edit through the diagram's tools, which ${profile.displayName} has not turned on. Ask in a message instead.`
            };
        }
        const sessionId = await sessionFor(ctx);
        if (!sessionId) {
            return { success: false, error: 'Open the diagram of this file: a slash command edits the diagram it shows.' };
        }
        const answer = await tools.callTool(tool, { sessionId, ...args });
        if (!answer.ok) {
            return { success: false, error: answer.text || `${tool} failed.` };
        }
        scheduleAutoLayout(vscode.Uri.file(ctx.file));
        return { success: true, info: answer.text || `Done: ${tool}.` };
    };

    const positional = (args: Record<string, any>, index: number): string | undefined =>
        args._positional?.[index];
    const positionals = (args: Record<string, any>): string[] =>
        (Array.isArray(args._positional) ? args._positional : []).map(String).filter((each: string) => each.trim() !== '');

    const slashCommands: ChatCommandContribution[] = [];

    for (const nc of profile.chat?.nodeCommands ?? []) {
        // The palette row of this kind: what a drop of it on the canvas creates.
        const row = profile.storageOptions?.entityPaletteItems?.find(
            each => each.label.trim().toLowerCase() === nc.nodeType.trim().toLowerCase()
        );
        slashCommands.push({
            command: nc.command,
            description: `${nc.description}: an instance of <Type>, which is created first when the file has none`,
            usage: '<Type> [name]',
            modes: ['build'],
            handler: async (args, ctx) => {
                const type = args.type || positional(args, 0);
                const name = args.name || positional(args, 1);
                if (!type) {
                    return { success: false, error: `Please name the ${nc.nodeType} type. Usage: /${nc.command} <Type> [name]` };
                }
                if (!row) {
                    return { success: false, error: `${profile.displayName} has no palette entry for a ${nc.nodeType}.` };
                }
                const create = () => callTool(ctx, 'create-nodes', {
                    nodes: [{
                        elementTypeId: row.elementTypeId,
                        position: { x: 0, y: 0 },
                        args: { ...(row.args ?? {}), type, ...(name ? { name } : {}) }
                    }]
                });
                const first = await create();
                if (first.success) {
                    return first;
                }
                // No such type yet, the usual reason: scaffold it, as the palette's wizard does,
                // then the node. A type that exists refuses the scaffold, and the create's own
                // reason stands.
                const scaffold = await callTool(ctx, 'create-task-type', { name: type, kind: nc.nodeType });
                if (!scaffold.success) {
                    return first;
                }
                const second = await create();
                return second.success ? { success: true, info: `${scaffold.info}\n${second.info}` } : second;
            }
        });
    }

    slashCommands.push({
        command: 'connect',
        description: "Connect a node's port to another's: node.Port, or one of the diagram's own ports by its name",
        usage: '<from> <to>',
        modes: ['build'],
        handler: async (args, ctx) => {
            const source = args.source || args.from || positional(args, 0);
            const target = args.target || args.to || positional(args, 1);
            if (!source || !target) {
                return { success: false, error: 'Please name both ends. Usage: /connect <node.Port> <node.Port>' };
            }
            return callTool(ctx, 'create-edges', {
                edges: [{ elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, args: { source, target } }]
            });
        }
    });

    slashCommands.push({
        command: 'delete',
        description: 'Delete nodes by name, with their edges',
        usage: '<name> [name…]',
        modes: ['build'],
        handler: async (args, ctx) => {
            const names = args.name ? [String(args.name)] : positionals(args);
            if (names.length === 0) {
                return { success: false, error: 'Please name a node to delete. Usage: /delete <name>' };
            }
            return callTool(ctx, 'delete-elements', { elementIds: names });
        }
    });

    slashCommands.push({
        command: 'delete-selected',
        description: 'Delete the selected nodes',
        modes: ['build'],
        handler: async (_args, ctx) => {
            if (ctx.selectedNodeIds.length === 0) {
                return { success: false, error: 'No nodes selected. Please select nodes to delete.' };
            }
            return callTool(ctx, 'delete-elements', { elementIds: ctx.selectedNodeIds });
        }
    });

    slashCommands.push({
        command: 'rename',
        description: 'Rename a node; its uses in the source follow',
        usage: '<name> <newName>',
        modes: ['build'],
        handler: async (args, ctx) => {
            const oldName = args.oldName || args.old || positional(args, 0);
            const newName = args.newName || args.new || positional(args, 1);
            if (!oldName || !newName) {
                return { success: false, error: 'Please give the current and the new name. Usage: /rename <name> <newName>' };
            }
            return callTool(ctx, 'modify-nodes', { nodes: [{ elementId: oldName, text: newName }] });
        }
    });

    slashCommands.push({
        command: 'update',
        description: "Set a node's parameters; each value is source text (5, \"a.txt\", File(path=\"x\"))",
        usage: '<name> param=value …',
        modes: ['build'],
        handler: async (args, ctx) => {
            const name = args.name || positional(args, 0);
            const parameters = Object.fromEntries(
                Object.entries(args).filter(([key]) => key !== 'name' && key !== '_positional').map(([key, value]) => [key, String(value)])
            );
            if (!name || Object.keys(parameters).length === 0) {
                return { success: false, error: 'Please name the node and a parameter. Usage: /update <name> param=value' };
            }
            return callTool(ctx, 'set-node-parameters', { node: name, parameters });
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
