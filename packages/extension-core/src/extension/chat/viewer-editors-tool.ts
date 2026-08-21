/**
 * `list_viewer_editors` — the chat's answer to "what can open this?".
 *
 * A workflow ends in something to look at, and the node that shows it must name
 * an editor. Without this the reader has to know that
 * `imagePreview.previewEditor` is a thing, or go reading extension manifests;
 * with it the chat can offer what this VS Code actually has installed and then
 * add the one they pick.
 *
 * The rule lives in `viewer-editors.ts` and is `vscode`-free. This file is the
 * adapter: it reads the live extension host, ranks against the file the session
 * is on, and renders the result as text an agent can quote back.
 *
 * Read-only by construction — it inspects manifests and writes nothing — so it
 * is safe on the read-only MCP surface, unlike anything that edits source.
 */
import * as vscode from 'vscode';
import type { InProcessChatTool } from './chat-runtime';
import { ExtensionManifest, discoverViewerEditors, rankForFile } from './viewer-editors';

/** Read every installed extension's manifest, in host order. */
function installedManifests(): ExtensionManifest[] {
    return vscode.extensions.all.map(extension => {
        const packageJSON = (extension.packageJSON ?? {}) as Record<string, unknown>;
        const contributes = (packageJSON.contributes ?? {}) as Record<string, unknown>;
        return {
            id: extension.id,
            displayName:
                typeof packageJSON.displayName === 'string'
                    ? packageJSON.displayName
                    : typeof packageJSON.name === 'string'
                      ? packageJSON.name
                      : undefined,
            customEditors: Array.isArray(contributes.customEditors)
                ? (contributes.customEditors as ExtensionManifest['customEditors'])
                : undefined,
            commands: Array.isArray(contributes.commands)
                ? (contributes.commands as ExtensionManifest['commands'])
                : undefined
        };
    });
}

/**
 * How many to hand back by default.
 *
 * Every installed extension is searched, and a full list runs to hundreds of
 * entries — a wall of text an agent then has to summarise, at the cost of the
 * ones that matter scrolling past. The ranked head is the useful part; `limit`
 * lifts the cap for a reader who wants the rest, and the reply always says how
 * many were held back so the cap can never look like the whole answer.
 */
const DEFAULT_LIMIT = 40;

export function createViewerEditorsTool(): InProcessChatTool {
    return {
        name: 'list_viewer_editors',
        description:
            'List the editors this VS Code can open a file with — custom editors ' +
            '(addressed by viewType) and preview/open commands (addressed by command id). ' +
            'Pass `file` to put the viewers that claim that file first; every other viewer ' +
            'is still listed, because a manifest pattern is a claim and not a limit. Use it ' +
            'to offer the user a viewer to add to the workflow.',
        inputSchema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    description:
                        'Optional file name or path to rank against, e.g. "report.html". ' +
                        'Ranks; never filters.'
                },
                limit: {
                    type: 'number',
                    description: `How many to return. Defaults to ${DEFAULT_LIMIT}.`
                }
            }
        },
        async handler(_file: string, args: Record<string, unknown>): Promise<string> {
            const rankAgainst = typeof args.file === 'string' ? args.file : undefined;
            const requested = typeof args.limit === 'number' ? Math.trunc(args.limit) : DEFAULT_LIMIT;
            const limit = Math.max(1, requested);

            const all = rankForFile(discoverViewerEditors(installedManifests()), rankAgainst);
            const shown = all.slice(0, limit);

            const lines = shown.map(option => {
                const address =
                    option.kind === 'customEditor'
                        ? `viewType=${option.viewType}`
                        : `command=${option.command}`;
                const opens = option.patterns.length > 0 ? ` opens=${option.patterns.join(',')}` : '';
                return `- ${option.label} [${option.kind}] ${address}${opens} (${option.provider})`;
            });

            const held = all.length - shown.length;
            const footer =
                held > 0
                    ? `\n\n${held} more not shown; call again with a larger \`limit\`.`
                    : '';
            const header = rankAgainst
                ? `Viewers available in this VS Code, ones claiming ${rankAgainst} first:`
                : 'Viewers available in this VS Code:';

            // A custom editor DECLARES what it opens; a command does not, so the
            // agent is told which half of the list is inference before it
            // recommends one.
            const caveat =
                '\n\nA [customEditor] declares the files it opens. A [command] was ' +
                'recognised by its name and may open something else — offer it as a ' +
                'suggestion, not as a fact.';

            return shown.length === 0
                ? 'No viewer editors found in this VS Code installation.'
                : `${header}\n${lines.join('\n')}${footer}${caveat}`;
        }
    };
}
