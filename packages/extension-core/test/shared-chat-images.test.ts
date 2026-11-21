/**
 * What images a chat message may carry (`@dialogram/shared` chat-images): the
 * kinds a model reads, at most 5 MB each, at most ten; read alike by the panel
 * and the host, which leaves out the rest before anything is sent.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_IMAGE_MAX_BYTES, base64Bytes, chatImageRefusal, readChatImages } from '@dialogram/shared';

const png = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };

describe('the images a chat message carries', () => {
    it('counts the bytes base64 stands for', () => {
        expect(base64Bytes('iVBORw0KGgo=')).toBe(8);
        expect(base64Bytes('QUJD')).toBe(3);
        expect(base64Bytes('QUI=')).toBe(2);
        expect(base64Bytes('QQ==')).toBe(1);
    });

    it('takes PNG, JPEG, GIF and WebP', () => {
        for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
            expect(chatImageRefusal({ mimeType, data: png.data })).toBeUndefined();
        }
        expect(chatImageRefusal({ mimeType: 'image/svg+xml', data: png.data })).toBe('only PNG, JPEG, GIF and WebP images can be sent');
    });

    it('refuses an image over 5 MB, saying its size', () => {
        const big = { mimeType: 'image/png', data: 'A'.repeat(Math.ceil(((CHAT_IMAGE_MAX_BYTES + 1024 * 1024) * 4) / 3)) };
        expect(chatImageRefusal(big)).toBe('it is 6.0 MB, and an image is at most 5 MB');
    });

    it('reads what can be sent from what a message says, ten at most', () => {
        expect(readChatImages(undefined)).toEqual([]);
        expect(readChatImages('nope')).toEqual([]);
        expect(readChatImages([png, { mimeType: 'image/png' }, { mimeType: 'image/tiff', data: 'AA==' }, null, { ...png, extra: 1 }]))
            .toEqual([png, png]);
        expect(readChatImages(Array.from({ length: 12 }, () => png))).toHaveLength(10);
    });
});
