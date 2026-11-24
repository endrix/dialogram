import { describe, expect, it, vi } from 'vitest';
import { chatDocumentsOf, routeDiagramChat, type DocumentChatHost } from '../src/extension/diagram/diagram-chat-routing';

const ROOT = 'file:///ws/jpeg_flow.py';
const NESTED = 'file:///ws/workflows/place.py';

/** The chat runtime with a panel open on each of `open`; what it was asked, by file. */
function runtime(open: string[]) {
    const asked: string[] = [];
    const host: DocumentChatHost = {
        canAsk: uri => open.includes(uri),
        confirm: vi.fn(async (uri: string) => {
            asked.push(`confirm ${uri}`);
            return { choice: 'Apply' };
        }),
        post: vi.fn(async (uri: string) => {
            asked.push(`post ${uri}`);
            return true;
        })
    };
    return { host, asked };
}

const editorOf = (clientId: string) => (clientId === 'client-1' ? ROOT : undefined);
const CARD = { title: 't', text: 'x', choices: ['Apply', 'Discard'] };

describe('the chat a diagram session puts a try to', () => {
    it('is the panel of the editor showing the session, in a view of another file\'s workflow', async () => {
        const { host, asked } = runtime([ROOT]);
        const chat = routeDiagramChat(() => host, editorOf);
        const nested = { clientId: 'client-1', sourceUri: NESTED };
        expect(chat.canAsk(nested)).toBe(true);
        expect(await chat.confirm(nested, CARD)).toEqual({ choice: 'Apply' });
        expect(await chat.post(nested, { text: 'applied' })).toBe(true);
        expect(asked).toEqual([`confirm ${ROOT}`, `post ${ROOT}`]);
    });

    it('is the panel of the drawn file where no editor is known for the client', async () => {
        expect(chatDocumentsOf({ clientId: 'unknown', sourceUri: NESTED }, editorOf)).toEqual([NESTED]);
        expect(chatDocumentsOf({ sourceUri: ROOT }, editorOf)).toEqual([ROOT]);
        expect(chatDocumentsOf({ clientId: 'client-1', sourceUri: ROOT }, editorOf)).toEqual([ROOT]);
        const { host, asked } = runtime([NESTED]);
        await routeDiagramChat(() => host, editorOf).post({ clientId: 'unknown', sourceUri: NESTED }, { text: 'm' });
        expect(asked).toEqual([`post ${NESTED}`]);
    });

    it('keeps a session\'s follow-ups in the chat its card went to', async () => {
        const open = [ROOT, NESTED];
        const { host, asked } = runtime(open);
        const chat = routeDiagramChat(() => host, editorOf);
        const nested = { clientId: 'client-1', sourceUri: NESTED };
        await chat.confirm(nested, CARD);
        // The editor showing the session closes while the card waits; another editor's chat is open on the drawn file.
        open.splice(open.indexOf(ROOT), 1);
        expect(await chat.post(nested, { text: 'discarded' })).toBe(false);
        expect(asked).toEqual([`confirm ${ROOT}`]);
    });

    it('is none while no panel is open, or no chat runs', async () => {
        const { host, asked } = runtime([]);
        const chat = routeDiagramChat(() => host, editorOf);
        const target = { clientId: 'client-1', sourceUri: NESTED };
        expect(chat.canAsk(target)).toBe(false);
        expect(await chat.confirm(target, CARD)).toBeUndefined();
        expect(await chat.post(target, { text: 'm' })).toBe(false);
        expect(asked).toEqual([]);
        const off = routeDiagramChat(() => undefined, editorOf);
        expect(off.canAsk(target)).toBe(false);
        expect(await off.post(target, { text: 'm' })).toBe(false);
    });
});
