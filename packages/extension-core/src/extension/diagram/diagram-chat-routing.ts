/**
 * Which chat a diagram's session puts something to the person in.
 *
 * A chat panel speaks for the file its editor was opened on (the webview's
 * `workflowUri`); the runtime reaches a file's panels by that file, the one
 * that spoke last. A session names itself by its GLSP client id and the file
 * it draws: the same file, unless the editor navigated in place into a
 * workflow defined in another file, whose view draws that file while its chat
 * stays the editor's. The file of the editor showing the session is asked
 * first, the drawn file after it; once a session's card went to a file, what
 * follows it goes there too, or nowhere.
 */
import type {
    DiagramChatCard,
    DiagramChatFigure,
    DiagramChatHost,
    DiagramChatTarget
} from '@dialogram/diagram-server/server/diagram-chat-host';

/** The chat runtime's side: its panels, by the file they speak for. */
export interface DocumentChatHost {
    canAsk(documentUri: string): boolean;
    confirm(documentUri: string, card: DiagramChatCard): Promise<{ choice?: string } | undefined>;
    post(documentUri: string, message: { text: string; figures?: DiagramChatFigure[] }): Promise<boolean>;
}

/** The files `diagram`'s chat may be open on, the editor's first. */
export function chatDocumentsOf(
    diagram: DiagramChatTarget,
    documentOfClient: (clientId: string) => string | undefined
): string[] {
    const editor = diagram.clientId !== undefined ? documentOfClient(diagram.clientId) : undefined;
    return [...new Set([editor, diagram.sourceUri].filter((uri): uri is string => !!uri))];
}

/** The diagram sessions' chat host over the runtime's (`host()`: unset while no chat runs). */
export function routeDiagramChat(
    host: () => DocumentChatHost | undefined,
    documentOfClient: (clientId: string) => string | undefined
): DiagramChatHost {
    // Where each session's chat was found: its follow-ups go there, not to
    // another file's chat once its editor is gone.
    const found = new Map<string, string>();
    const reachable = (diagram: DiagramChatTarget): string | undefined => {
        const chat = host();
        if (!chat) {
            return undefined;
        }
        const before = diagram.clientId !== undefined ? found.get(diagram.clientId) : undefined;
        if (before !== undefined) {
            return chat.canAsk(before) ? before : undefined;
        }
        const uri = chatDocumentsOf(diagram, documentOfClient).find(each => chat.canAsk(each));
        if (uri !== undefined && diagram.clientId !== undefined) {
            found.set(diagram.clientId, uri);
        }
        return uri;
    };
    return {
        canAsk: diagram => reachable(diagram) !== undefined,
        confirm: async (diagram, card) => {
            const uri = reachable(diagram);
            return uri !== undefined ? host()?.confirm(uri, card) : undefined;
        },
        post: async (diagram, message) => {
            const uri = reachable(diagram);
            return uri !== undefined ? (await host()?.post(uri, message)) ?? false : false;
        }
    };
}
