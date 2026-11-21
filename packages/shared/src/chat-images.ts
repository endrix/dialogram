/**
 * Images in a chat message: pasted into the chat, or a picture of the diagram
 * attached to it, and sent to the agent with the text (ACP `image` blocks).
 *
 * The panel and the host read them alike: the kinds a model reads, and a size
 * a model takes; anything else is left out before it is sent.
 */

/** An image a message carries: its bytes, base64, and what they are. */
export interface ChatImage {
    mimeType: string;
    /** The bytes, base64 (no `data:` prefix). */
    data: string;
}

/** The kinds of image an agent's model reads. */
export const CHAT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The largest image sent, in bytes: what a model takes in one image. */
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The most images one message carries. */
export const CHAT_IMAGE_MAX_COUNT = 10;

/** The bytes base64 `data` stands for. */
export function base64Bytes(data: string): number {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.floor((data.length * 3) / 4) - padding;
}

/** Why `image` is not sent, or nothing when it is. */
export function chatImageRefusal(image: ChatImage): string | undefined {
    if (!CHAT_IMAGE_TYPES.includes(image.mimeType)) {
        return 'only PNG, JPEG, GIF and WebP images can be sent';
    }
    const bytes = base64Bytes(image.data);
    if (bytes > CHAT_IMAGE_MAX_BYTES) {
        return `it is ${(bytes / (1024 * 1024)).toFixed(1)} MB, and an image is at most ${CHAT_IMAGE_MAX_BYTES / (1024 * 1024)} MB`;
    }
    return undefined;
}

/** The images in what a message says it carries: those that can be sent, as many as one message carries. */
export function readChatImages(raw: unknown): ChatImage[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .filter((image): image is ChatImage => !!image && typeof image.mimeType === 'string' && typeof image.data === 'string' && image.data.length > 0)
        .map(({ mimeType, data }) => ({ mimeType, data }))
        .filter(image => chatImageRefusal(image) === undefined)
        .slice(0, CHAT_IMAGE_MAX_COUNT);
}
