/**
 * Which GLSP-MCP session a chat command acts on: a diagram of the chat's
 * file, the one shown in this editor first, then any that may edit, then any.
 * With `anyView`, the one shown in this editor whatever file its view draws (a
 * workflow of another file, navigated into in place): for a command on what
 * the editor shows, not on the chat's file.
 */
import * as vscode from 'vscode';
import type { GlspMcpClient } from './glsp-mcp-client';

/** The session of the diagram showing `file` (`shownHere`: the editor's own), or why none could be asked for. */
export async function diagramToolSession(
    tools: Pick<GlspMcpClient, 'callTool'>,
    file: string,
    shownHere: string | undefined,
    options: { anyView?: boolean } = {}
): Promise<{ sessionId?: string; error?: string }> {
    const listed = await tools.callTool('session-info', {});
    if (!listed.ok) {
        // The tools did not answer: that, not a diagram to open, is what to say.
        return { error: listed.text || "The diagram's tools did not answer." };
    }
    const rows = (listed.structured?.sessions as Array<{ sessionId?: string; sourceUri?: string; readOnly?: boolean }> | undefined) ?? [];
    const here = options.anyView && shownHere !== undefined ? rows.find(row => row.sessionId === shownHere) : undefined;
    if (here?.sessionId) {
        return { sessionId: here.sessionId };
    }
    const shown = rows.filter(row => {
        try {
            return !!row.sourceUri && vscode.Uri.parse(row.sourceUri).fsPath === vscode.Uri.file(file).fsPath;
        } catch {
            return false;
        }
    });
    return { sessionId: (shown.find(row => row.sessionId === shownHere) ?? shown.find(row => !row.readOnly) ?? shown[0])?.sessionId };
}
