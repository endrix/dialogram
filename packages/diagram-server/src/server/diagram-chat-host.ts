/**
 * The chat of the diagram a session draws, for the session to put something
 * to the person there: a card with buttons, a message of the platform's own,
 * each with pictures when it has some. The host owns the chat (its panel, its
 * sessions); a session reaches it through this, keyed by the diagram's source.
 * Absent where the product has no chat.
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

export interface DiagramChatHost {
    /** Whether a chat panel is open on `sourceUri` to put a card to the person. */
    canAsk(sourceUri: string): boolean;
    /**
     * Put `card` to the person in the chat open on `sourceUri`. Resolves with
     * the button pressed, none when declined; `undefined` when no chat can ask
     * there.
     */
    confirm(sourceUri: string, card: DiagramChatCard): Promise<{ choice?: string } | undefined>;
    /** Post a message of the platform's own in the chat open on `sourceUri`; `false` when no chat can take it. */
    post(sourceUri: string, message: { text: string; figures?: DiagramChatFigure[] }): Promise<boolean>;
}

export const DIAGRAM_CHAT_HOST = Symbol('DiagramChatHost');
