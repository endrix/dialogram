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

/** The backend op an untangle's Apply writes port orders with: `/untangle` is offered where the backend has it. */
const UNTANGLE_WRITE_OP = 'reorderEntityPorts';

/**
 * What `/untangle` asks of the agent: the diagram's untangle MCP tools
 * (`untangle-start`, `untangle-try`, `untangle-propose`), Free Ports first, at most ten
 * tries, each kept only when it helps, and the best put to the person.
 */
export const UNTANGLE_PROMPT = [
    'Untangle the layout of this diagram, with the untangle tools of the diagram\'s MCP server. Look at the picture each tool answers with.',
    '1. Call untangle-start. It lays the diagram out with Layout Diagram, the drawing to beat, and lists the definitions that have several instances.',
    '2. Call untangle-try with layout "free-ports". Free Ports orders each node\'s ports against crossings, one order for all the instances of a definition.',
    '3. Then improve on the best try, one definition at a time: where the try says what order each instance would take on its own, give the definition one of those orders (`orders`), or swap two neighbouring ports of one side. Keep a change only when the crossings drop or, within a few crossings, when the picture reads better: shorter edges, a left-to-right flow, no edge running under a node.',
    '4. You may try layout "untangled" once: it keeps every port where it is declared.',
    '5. Make at most 10 tries in all, fewer when no change helps.',
    '6. Call untangle-propose with the best try. The person applies or discards it in the chat. Then say in one line which try you proposed and why, and stop.',
    'Do not edit any file yourself and do not run any other layout.'
].join('\n');

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

/**
 * `reader path="a b.txt" src=File(path="x")` as words: split at blanks outside quotes and
 * brackets, each kept as written.
 */
export function sourceWords(raw: string): string[] {
    const words: string[] = [];
    let current = '';
    let depth = 0;
    let quote: string | undefined;
    for (let at = 0; at < raw.length; at++) {
        const ch = raw[at];
        if (quote) {
            current += ch;
            if (ch === '\\' && at + 1 < raw.length) {
                current += raw[++at];
            } else if (ch === quote) {
                quote = undefined;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if ('([{'.includes(ch)) {
            depth += 1;
        } else if (')]}'.includes(ch)) {
            depth = Math.max(0, depth - 1);
        } else if (/\s/.test(ch) && depth === 0) {
            if (current) {
                words.push(current);
            }
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) {
        words.push(current);
    }
    return words;
}

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

    /** The GLSP-MCP session of the diagram showing this file: the one in this editor, or any; or why none. */
    const sessionFor = async (ctx: ChatCommandContext): Promise<{ sessionId?: string; error?: string }> => {
        const listed = await tools!.callTool('session-info', {});
        if (!listed.ok) {
            // The tools did not answer: that, not a diagram to open, is what to say.
            return { error: listed.text || "The diagram's tools did not answer." };
        }
        const rows = (listed.structured?.sessions as Array<{ sessionId?: string; sourceUri?: string; readOnly?: boolean }> | undefined) ?? [];
        const shown = rows.filter(row => {
            try {
                return !!row.sourceUri && vscode.Uri.parse(row.sourceUri).fsPath === vscode.Uri.file(ctx.file).fsPath;
            } catch {
                return false;
            }
        });
        const current = deps.getEditorProvider()?.getClientIdForDocumentUri?.(vscode.Uri.file(ctx.file));
        return { sessionId: (shown.find(row => row.sessionId === current) ?? shown.find(row => !row.readOnly) ?? shown[0])?.sessionId };
    };

    /** One tool call on the diagram of the chat's file; its answer is the command's. */
    const callTool = async (ctx: ChatCommandContext, tool: string, args: Record<string, unknown>): Promise<ChatCommandResult> => {
        if (!tools) {
            return {
                success: false,
                error: `Slash commands edit through the diagram's tools, which ${profile.displayName} has not turned on. Ask in a message instead.`
            };
        }
        // The per-user rollback of the diagram's tools holds for the commands as for the agent.
        if (!vscode.workspace.getConfiguration(CORE_CHAT_SECTION).get<boolean>('useGlspMcp', true)) {
            return {
                success: false,
                error: `Slash commands edit through the diagram's tools, which the setting ${CORE_CHAT_SECTION}.useGlspMcp turns off. Ask in a message instead.`
            };
        }
        const { sessionId, error } = await sessionFor(ctx);
        if (error) {
            return { success: false, error };
        }
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
        // A row that fixes its type (a document's clause of one kind) makes that type: the
        // command names only the node. Any other names the type it makes an instance of.
        const fixedType = typeof row?.args?.type === 'string' && row.args.type.trim() !== '' ? row.args.type : undefined;
        const create = (ctx: ChatCommandContext, args: Record<string, unknown>) => callTool(ctx, 'create-nodes', {
            nodes: [{ elementTypeId: row!.elementTypeId, position: { x: 0, y: 0 }, args: { ...(row!.args ?? {}), ...args } }]
        });
        slashCommands.push(fixedType
            ? {
                command: nc.command,
                description: nc.description,
                usage: '<name>',
                modes: ['build'],
                handler: async (args, ctx) => {
                    const name = args.name || positionals(args).join(' ');
                    if (!name) {
                        return { success: false, error: `Please name the ${nc.nodeType}. Usage: /${nc.command} <name>` };
                    }
                    return create(ctx, { name });
                }
            }
            : {
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
                    // `createType`: when the source has no type of that name, the diagram makes
                    // it first, as the palette's "Create new…" does, in the same undoable edit;
                    // a type imported from elsewhere is found, and left alone.
                    return create(ctx, { type, ...(name ? { name } : {}), createType: true });
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
            // From the text as typed: a value is source text, whose quotes, parentheses and `=`
            // the shared argument parser would strip or split.
            const words = sourceWords(typeof args._raw === 'string' ? args._raw : '');
            const name = words.find(word => !word.includes('='));
            const parameters = Object.fromEntries(
                words.filter(word => word.includes('=')).map(word => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)])
            );
            if (!name || Object.keys(parameters).length === 0) {
                return { success: false, error: 'Please name the node and a parameter. Usage: /update <name> param=value' };
            }
            return callTool(ctx, 'set-node-parameters', { node: name, parameters });
        }
    });

    slashCommands.push({
        command: 'untangle',
        description: 'Try layouts against edge crossings, then propose the best: its port orders written into the source',
        modes: ['build'],
        handler: async (_args, ctx) => {
            if (!tools || !vscode.workspace.getConfiguration(CORE_CHAT_SECTION).get<boolean>('useGlspMcp', true)) {
                return { success: false, error: "The agent untangles with the diagram's tools, which are turned off here." };
            }
            const caps = await editBackend.listCapabilities(ctx.uri).catch(() => undefined);
            if (!caps?.ops?.includes(UNTANGLE_WRITE_OP)) {
                return { success: false, error: "This diagram's source cannot be given a port order, so it cannot be untangled here." };
            }
            return {
                success: true,
                prompt: UNTANGLE_PROMPT,
                // A try the agent left drawn, not put to the person (it stopped
                // short, or was stopped), is drawn back as the diagram was:
                // the next node moved would save it otherwise.
                afterTurn: async () => {
                    const { sessionId } = await sessionFor(ctx);
                    if (sessionId) {
                        await tools.callTool('untangle-end', { sessionId });
                    }
                }
            };
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
