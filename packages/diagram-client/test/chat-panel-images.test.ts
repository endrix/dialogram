// @vitest-environment happy-dom
/**
 * Images in the chat: pasted (or dropped) on the composer, or a picture of the
 * diagram attached with the camera button; shown small above the text, each
 * with its remove button; sent with the message (`chat.sendMessage.images`)
 * and shown under it. An agent that does not read images, an image of a kind
 * a model does not read, and an eleventh image are refused, saying why.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';

const drawn = vi.hoisted(() => ({ result: undefined as undefined | { data: string; width: number; height: number } | Error }));
vi.mock('../src/diagram-picture', () => ({
    diagramPng: async () => {
        if (drawn.result instanceof Error) throw drawn.result;
        return drawn.result;
    }
}));

import { ChatPanel } from '../src/chat-panel-integrated';
import { carriesImages, imageFiles, readImageFile } from '../src/chat-images';

const PNG_BASE64 = 'iVBORw0KGgo=';

function makePanel() {
    const sent: Array<{ method: string; env: any }> = [];
    const panel = new ChatPanel();
    (panel as any).channel = { sendToHost: (method: string, env: any) => sent.push({ method, env }) };
    (panel as any).show = () => undefined;
    // A chat is open: a message sent with none waits for its session first
    // (chat-panel-first-message.test.ts).
    (panel as any).currentSessionId = 'ses_1';
    return { panel: panel as any, sent };
}

function pngFile(name = 'shot.png', type = 'image/png'): File {
    return new File([Uint8Array.from(atob(PNG_BASE64), c => c.charCodeAt(0))], name, { type });
}

/** A paste's or a drop's data: items of the files given. */
function transferOf(files: File[]): DataTransfer {
    return {
        items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        files
    } as unknown as DataTransfer;
}

function systemLines(panel: any): string[] {
    return panel.timeline.filter((t: any) => t.kind === 'message' && t.role === 'system').map((t: any) => t.content);
}

beforeEach(() => {
    // The composer's model select is a form-associated element: happy-dom has no ElementInternals.
    if (typeof (HTMLElement.prototype as any).attachInternals !== 'function') {
        (HTMLElement.prototype as any).attachInternals = () =>
            new Proxy({}, { get: (_target, key) => (key === 'form' || key === 'labels' ? null : () => undefined) });
    }
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => undefined;
    drawn.result = undefined;
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('reading an image from a paste or a drop', () => {
    it('takes the image files, and reads their kind and bytes', async () => {
        const transfer = transferOf([pngFile(), new File(['x'], 'notes.txt', { type: 'text/plain' })]);
        expect(carriesImages(transfer)).toBe(true);
        const files = imageFiles(transfer);
        expect(files.map(f => f.name)).toEqual(['shot.png']);
        expect(await readImageFile(files[0])).toEqual({ mimeType: 'image/png', data: PNG_BASE64 });
    });

    it('finds none in text', () => {
        const transfer = transferOf([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
        expect(carriesImages(transfer)).toBe(false);
        expect(imageFiles(transfer)).toEqual([]);
        expect(imageFiles(null)).toEqual([]);
    });
});

describe('images in the chat', () => {
    it('shows a pasted image above the text, and removes it on its button', async () => {
        const { panel } = makePanel();
        await panel.attachFiles([pngFile()]);
        expect(panel.pendingImages).toEqual([{ mimeType: 'image/png', data: PNG_BASE64 }]);

        const host = document.createElement('div');
        render(panel.composerTemplate(), host);
        const thumb = host.querySelector('.chat-attachment img') as HTMLImageElement;
        expect(thumb.getAttribute('src')).toBe(`data:image/png;base64,${PNG_BASE64}`);

        (host.querySelector('.chat-attachment-remove') as HTMLButtonElement).click();
        expect(panel.pendingImages).toEqual([]);
    });

    it('sends the images with the message, shows them under it, and starts the next one empty', async () => {
        const { panel, sent } = makePanel();
        await panel.attachFiles([pngFile()]);
        panel.inputValue = 'what is wrong here?';
        panel.sendMessage();

        const message = sent.find(s => s.env?.type === 'chat.sendMessage');
        expect(message!.env.data.text).toBe('what is wrong here?');
        expect(message!.env.data.images).toEqual([{ mimeType: 'image/png', data: PNG_BASE64 }]);
        expect(panel.pendingImages).toEqual([]);
        const row = panel.timeline.at(-1);
        expect(row).toMatchObject({ role: 'user', content: 'what is wrong here?', images: [{ mimeType: 'image/png' }] });

        const host = document.createElement('div');
        render(panel.itemTemplate(row), host);
        expect(host.querySelector('.chat-row-images img')).not.toBeNull();
    });

    it('sends an image with no text', async () => {
        const { panel, sent } = makePanel();
        await panel.attachFiles([pngFile()]);
        panel.sendMessage();
        const message = sent.find(s => s.env?.type === 'chat.sendMessage');
        expect(message!.env.data.text).toBe('');
        expect(message!.env.data.images).toHaveLength(1);
    });

    it('sends no images key with a message that has none', () => {
        const { panel, sent } = makePanel();
        panel.inputValue = 'hello';
        panel.sendMessage();
        expect('images' in sent.find(s => s.env?.type === 'chat.sendMessage')!.env.data).toBe(false);
    });

    it('refuses an image of a kind a model does not read', async () => {
        const { panel } = makePanel();
        await panel.attachFiles([pngFile('scan.bmp', 'image/bmp')]);
        expect(panel.pendingImages).toEqual([]);
        expect(systemLines(panel).at(-1)).toContain('only PNG, JPEG, GIF and WebP images can be sent');
    });

    it('refuses an eleventh image', async () => {
        const { panel } = makePanel();
        await panel.attachFiles(Array.from({ length: 11 }, (_, i) => pngFile(`shot${i}.png`)));
        expect(panel.pendingImages).toHaveLength(10);
        expect(systemLines(panel).at(-1)).toContain('a message carries at most 10 images');
    });

    it('refuses images when the agent does not read them, and greys the camera', async () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'text-only', images: false });
        await panel.attachFiles([pngFile()]);
        expect(panel.pendingImages).toEqual([]);
        expect(systemLines(panel).at(-1)).toBe('The image was not attached: text-only does not read images.');

        const host = document.createElement('div');
        render(panel.composerTemplate(), host);
        const camera = host.querySelector('.chat-picture') as HTMLButtonElement;
        expect(camera.disabled).toBe(true);
        expect(camera.title).toBe('text-only does not read images');
    });

    it('takes images again once the agent says it reads them', async () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'a', images: false });
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'b', images: true });
        await panel.attachFiles([pngFile()]);
        expect(panel.pendingImages).toHaveLength(1);
    });

    it('puts a message the host did not send back in the composer, and its row out of the transcript', async () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'text-only' });
        await panel.attachFiles([pngFile()]);
        panel.inputValue = 'look at this';
        panel.sendMessage();
        expect(panel.inputValue).toBe('');

        panel.handleIncomingMessage('chat.messageNotSent', { reason: 'text-only does not read images', images: false });
        expect(panel.inputValue).toBe('look at this');
        expect(panel.pendingImages).toEqual([{ mimeType: 'image/png', data: PNG_BASE64 }]);
        expect(panel.timeline.some((t: any) => t.role === 'user')).toBe(false);
        expect(systemLines(panel).at(-1)).toBe('Not sent: text-only does not read images. Remove the images and send again.');
        expect(panel.agentTakesImages).toBe(false);
    });

    it('keeps a message with images as written once the agent says it does not read them', async () => {
        const { panel, sent } = makePanel();
        await panel.attachFiles([pngFile()]);
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'text-only', images: false });
        panel.inputValue = 'look';
        panel.sendMessage();
        expect(sent.some(s => s.env?.type === 'chat.sendMessage')).toBe(false);
        expect(panel.inputValue).toBe('look');
        expect(panel.pendingImages).toHaveLength(1);
        expect(systemLines(panel).at(-1)).toBe('Not sent: text-only does not read images. Remove them and send again.');
    });

    it('forgets whether an agent reads images once it disconnects, or another connects', async () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'a', images: false });
        panel.handleIncomingMessage('chat.connectionStatus', { connected: false, reason: 'stopped' });
        expect(panel.agentTakesImages).toBeUndefined();
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'a', images: false });
        panel.handleIncomingMessage('chat.connectionStatus', { connected: true, agent: 'b' });
        expect(panel.agentTakesImages).toBeUndefined();
        await panel.attachFiles([pngFile()]);
        expect(panel.pendingImages).toHaveLength(1);
    });

    it('sends a task its own prompt alone, and leaves what the composer holds', async () => {
        const { panel, sent } = makePanel();
        await panel.attachFiles([pngFile()]);
        panel.inputValue = 'a draft';
        panel.handleIncomingMessage('chat.startTask', { prompt: 'fix the run', mode: 'build', name: 'Fix' });
        // The host names the request back.
        panel.handleIncomingMessage('chat.sessionCreated', { session: { id: 's2', name: 'Fix' }, requestId: panel.createRequest });
        const message = sent.find(s => s.env?.type === 'chat.sendMessage');
        expect(message!.env.data.text).toBe('fix the run');
        expect('images' in message!.env.data).toBe(false);
        expect(panel.inputValue).toBe('a draft');
        expect(panel.pendingImages).toHaveLength(1);
    });

    it('counts images alone as a message being written', async () => {
        const { panel } = makePanel();
        expect(panel.isComposing()).toBe(false);
        await panel.attachFiles([pngFile()]);
        expect(panel.isComposing()).toBe(true);
    });

    it('says how many images a restored message had', () => {
        const { panel } = makePanel();
        panel.handleIncomingMessage('chat.sessionHistory', {
            sessionId: 'ses_1',
            messages: [{ role: 'user', content: 'look', timestamp: 1, images: 2 }]
        });
        const row = panel.timeline.at(-1);
        expect(row.imageCount).toBe(2);
        const host = document.createElement('div');
        render(panel.messageImagesTemplate(row), host);
        expect(host.textContent).toContain('2 images');
    });
});

describe('a picture of the diagram in the chat', () => {
    it('is attached by the camera button', async () => {
        const { panel } = makePanel();
        drawn.result = { data: PNG_BASE64, width: 800, height: 400 };
        const host = document.createElement('div');
        render(panel.composerTemplate(), host);
        (host.querySelector('.chat-picture') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(panel.pendingImages).toEqual([{ mimeType: 'image/png', data: PNG_BASE64 }]));
        expect(panel.takingPicture).toBe(false);
    });

    it('says why when there is none', async () => {
        const { panel } = makePanel();
        drawn.result = new Error('The diagram is not drawn yet.');
        await panel.attachDiagramPicture();
        expect(panel.pendingImages).toEqual([]);
        expect(systemLines(panel).at(-1)).toBe('No picture of the diagram: The diagram is not drawn yet.');
    });
});
