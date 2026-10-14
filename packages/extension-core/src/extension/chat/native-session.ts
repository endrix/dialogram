/**
 * Opening an agent's session in the agent's own CLI.
 *
 * The ACP adapters keep the agent's session id as the ACP one, so a
 * connector's `resume` template (`claude --resume {sessionId}`,
 * `opencode -s {sessionId}`) opens the very session the chat, or a run's
 * agent, talked to. It opens in a VS Code terminal, in the session's
 * directory: Claude Code looks its sessions up by the directory they ran in.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { resumeCommandFor } from "./acp-connectors.js";

export interface NativeSession {
    /** The connector's name, for the terminal's title and messages. */
    agent: string;
    sessionId: string;
    /** The connector's `resume` template, if it has one. */
    resume?: string;
    /** The directory the session ran in. */
    cwd?: string;
}

/** Copy a session's id to the clipboard, saying so. */
export async function copySessionId(session: NativeSession): Promise<void> {
    await vscode.env.clipboard.writeText(session.sessionId);
    void vscode.window.showInformationMessage(`Copied the ${session.agent} session id: ${session.sessionId}`);
}

/**
 * Open the session in a terminal running the agent's CLI. Without a
 * `resume` command the id is copied instead, and the person told why.
 * Returns whether a terminal was opened.
 */
export async function openSessionNatively(session: NativeSession): Promise<boolean> {
    const command = resumeCommandFor(session.resume, session.sessionId);
    if (!command) {
        await vscode.env.clipboard.writeText(session.sessionId);
        void vscode.window.showInformationMessage(
            `${session.agent} has no command to open a session (no \`resume\` in its connector); its id is copied: ${session.sessionId}`
        );
        return false;
    }
    const cwd = session.cwd && isDirectory(session.cwd) ? session.cwd : undefined;
    if (session.cwd && !cwd) {
        void vscode.window.showWarningMessage(
            `The session's directory ${session.cwd} is gone; ${session.agent} may not find the session from elsewhere.`
        );
    }
    const terminal = vscode.window.createTerminal({ name: `${session.agent} ${session.sessionId.slice(0, 12)}`, ...(cwd ? { cwd } : {}) });
    terminal.show();
    terminal.sendText(command);
    return true;
}

function isDirectory(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}
