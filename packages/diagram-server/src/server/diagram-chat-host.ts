/**
 * The chat of the diagram a session draws, for the session to put something
 * to the person there: a card with buttons, a message of the platform's own,
 * each with pictures when it has some. The host owns the chat (its panel, its
 * sessions); a session reaches it through this, naming itself
 * ({@link DiagramChatTarget}). Absent where the product has no chat.
 */

/** A picture in the chat: a PNG, base64, and what it shows. */
export interface DiagramChatFigure {
    data: string;
    caption?: string;
}

/** A card put to the person: `choices` are its buttons. */
export interface DiagramChatCard {
    title: string;
    text: string;
    choices: string[];
    figures?: DiagramChatFigure[];
}

/**
 * The diagram whose chat is asked for. Its chat is the panel of the editor
 * showing the session, which speaks for the file the editor was opened on: a
 * view navigated in place into a workflow of another file draws that file
 * (`sourceUri`), while its chat stays the editor's.
 */
export interface DiagramChatTarget {
    /** The session's GLSP client id: the host finds the editor that shows it. */
    clientId?: string;
    /** The file the session draws: the chat's, where no editor is known for the client. */
    sourceUri: string;
}

export interface DiagramChatHost {
    /** Whether a chat panel is open on `diagram` to put a card to the person. */
    canAsk(diagram: DiagramChatTarget): boolean;
    /**
     * Put `card` to the person in the chat open on `diagram`. Resolves with
     * the button pressed, none when declined; `undefined` when no chat can ask
     * there.
     */
    confirm(diagram: DiagramChatTarget, card: DiagramChatCard): Promise<{ choice?: string } | undefined>;
    /** Post a message of the platform's own in the chat open on `diagram`; `false` when no chat can take it. */
    post(diagram: DiagramChatTarget, message: { text: string; figures?: DiagramChatFigure[] }): Promise<boolean>;
}

export const DIAGRAM_CHAT_HOST = Symbol('DiagramChatHost');
