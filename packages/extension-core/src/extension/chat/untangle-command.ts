/**
 * `/untangle`, in every diagram chat whose diagram tools are on and whose
 * diagrams the platform's own diagram module serves: the agent lays the
 * diagram out a few ways with the untangle tools of the diagram's MCP server,
 * and puts the best try to the person. Applied, its port orders are kept with
 * the diagram's layout, or written into the source where the product's
 * producer takes them (the diagram server decides which).
 */
import * as vscode from 'vscode';
import type { DiagramProfile } from '../../api';
import type { WorkflowEditorProvider } from '../diagram/diagram-editor-provider';
import { diagramToolSession } from './diagram-tool-session';
import { CORE_CHAT_SECTION } from './edit-capability';
import type { GlspMcpClient } from './glsp-mcp-client';
import type { ChatCommandContribution } from './slash-commands';

/**
 * What `/untangle` asks of the agent: the diagram's untangle MCP tools
 * (`untangle-start`, `untangle-try`, `untangle-propose`), Free Ports first, at most ten
 * tries, each kept only when it helps, and the best put to the person.
 */
export const UNTANGLE_PROMPT = [
    'Untangle the layout of this diagram, with the untangle tools of the diagram\'s MCP server. Look at the picture each tool answers with.',
    'This is a new untangle, whatever this chat did before: the diagram may have changed since (an Apply, an Undo, an edit). Go through every step below, and answer from what the tools say now, never from an earlier untangle.',
    '1. Call untangle-start. It lays the diagram out with Layout Diagram, the drawing to beat, and lists the definitions that have several instances.',
    '2. Call untangle-try with layout "free-ports". Free Ports orders each node\'s ports against crossings, one order for all the instances of a definition.',
    '3. Then improve on the best try, one definition at a time: where the try says what order each instance would take on its own, give the definition one of those orders (`orders`), or swap two neighbouring ports of one side. Keep a change only when the crossings drop or, within a few crossings, when the picture reads better: shorter edges, a left-to-right flow, no edge running under a node.',
    '4. You may try layout "untangled" once: it keeps every port where it is declared.',
    '5. Make at most 10 tries in all, fewer when no change helps.',
    '6. Call untangle-propose with the best try. The person applies or discards it in the chat. Then say in one line which try you proposed and why, and stop.',
    'Do not edit any file yourself and do not run any other layout.'
].join('\n');

export interface UntangleCommandDeps {
    /** The diagram's GLSP-MCP tools, which the agent untangles with. */
    tools: Pick<GlspMcpClient, 'callTool'>;
    getEditorProvider(): WorkflowEditorProvider | undefined;
}

/**
 * The platform's own chat commands for `profile`: `/untangle` where the
 * diagram's tools are on, unless the product serves its diagrams with a
 * diagram module of its own, which binds no untangle tools (no untangle
 * Apply, no Free Ports, no layout file to keep a try in).
 */
export function platformChatCommands(
    profile: Pick<DiagramProfile, 'serverDiagramModule'>,
    tools: UntangleCommandDeps['tools'] | undefined,
    getEditorProvider: UntangleCommandDeps['getEditorProvider']
): ChatCommandContribution[] {
    return tools && !profile.serverDiagramModule ? [createUntangleCommand({ tools, getEditorProvider })] : [];
}

export function createUntangleCommand(deps: UntangleCommandDeps): ChatCommandContribution {
    return {
        command: 'untangle',
        description: 'Try layouts against edge crossings, then propose the best: its port orders kept with the layout, or written into the source where it takes them',
        modes: ['build'],
        handler: async (_args, ctx) => {
            // The per-user rollback of the diagram's tools holds for the command as for the agent.
            if (!vscode.workspace.getConfiguration(CORE_CHAT_SECTION).get<boolean>('useGlspMcp', true)) {
                return { success: false, error: "The agent untangles with the diagram's tools, which are turned off here." };
            }
            return {
                success: true,
                prompt: UNTANGLE_PROMPT,
                // A try the agent left drawn, not put to the person (it stopped
                // short, or was stopped), is drawn back as the diagram was:
                // the next node moved would save it otherwise.
                afterTurn: async () => {
                    const shownHere = deps.getEditorProvider()?.getClientIdForDocumentUri?.(vscode.Uri.file(ctx.file));
                    const { sessionId } = await diagramToolSession(deps.tools, ctx.file, shownHere);
                    if (sessionId) {
                        await deps.tools.callTool('untangle-end', { sessionId });
                    }
                }
            };
        }
    };
}
