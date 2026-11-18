/**
 * The palette's export takes the surface's image when it offers one, checks
 * it is a PNG, and sends it to the host's export path; without one it is the
 * SVG export as before. And a product's own messages to and from its host
 * go through a supported channel that never carries the platform's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
    posted: [] as any[],
    listeners: [] as Array<(message: unknown) => void>,
    postOk: true
}));

vi.mock('../src/vscode-ui', () => ({
    VscodeUi: {
        instance: {
            post: (message: unknown) => { bridge.posted.push(message); return bridge.postOk; },
            onMessage: (listener: (message: unknown) => void) => {
                bridge.listeners.push(listener);
                return () => { bridge.listeners.splice(bridge.listeners.indexOf(listener), 1); };
            }
        }
    }
}));

// The SVG path, as far as this test cares: a rendered diagram and its extraction.
vi.mock('../src/svg-export', () => ({
    renderedDiagram: () => ({ graph: {} }),
    extractSvg: () => ({ svg: '<svg/>', name: 'shapes', elementCount: 1 })
}));

import { PNG_EXTRACTED, exportDiagram } from '../src/svg-export-command';
import { isReservedMessageType, onHostMessage, postToHost } from '../src/host-messages';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function host(image: unknown, offers = true): any {
    return {
        exportsImage: () => offers,
        exportImage: async () => {
            if (image instanceof Error) {
                throw image;
            }
            return image;
        }
    };
}

beforeEach(() => {
    bridge.posted.length = 0;
    bridge.listeners.length = 0;
    (globalThis as any).diagramIdentifier = { label: 'shapes' };
});

describe('the export', () => {
    it('is the surface\'s PNG when it offers one, base64 to the host\'s save path', async () => {
        await exportDiagram(host(PNG));
        expect(bridge.posted).toHaveLength(1);
        const { type, payload } = bridge.posted[0];
        expect(type).toBe(PNG_EXTRACTED);
        expect(payload.byteLength).toBe(PNG.length);
        expect(Array.from(Buffer.from(payload.data, 'base64'))).toEqual(Array.from(PNG));
    });

    it('is the SVG, as before, without a surface or with one that offers no image', async () => {
        await exportDiagram(undefined);
        await exportDiagram(host(undefined, false));
        expect(bridge.posted.map(m => m.type)).toEqual(['dialogram.svg.extracted', 'dialogram.svg.extracted']);
    });

    it('fails aloud, as a PNG export, on what is not a PNG or on an error', async () => {
        await exportDiagram(host(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
        await exportDiagram(host(undefined));
        await exportDiagram(host(new Error('lost the context')));
        expect(bridge.posted.map(m => [m.type, m.payload.format])).toEqual([
            ['dialogram.svg.failed', 'PNG'],
            ['dialogram.svg.failed', 'PNG'],
            ['dialogram.svg.failed', 'PNG']
        ]);
        expect(bridge.posted[2].payload.reason).toBe('lost the context');
    });
});

describe('a product\'s messages', () => {
    it('reach the host, but never as one of the platform\'s', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(postToHost({ type: 'shapes.loadTile', tile: 3 })).toBe(true);
        expect(postToHost({ type: 'dialogram.png.extracted', payload: {} })).toBe(false);
        expect(postToHost({ type: 'chat.sendMessage' })).toBe(false);
        expect(postToHost({} as any)).toBe(false);
        expect(bridge.posted).toEqual([{ type: 'shapes.loadTile', tile: 3 }]);
        expect(warn).toHaveBeenCalledTimes(3);
        warn.mockRestore();
    });

    it('are heard from the host without the platform\'s own traffic, until disposed', () => {
        const heard: unknown[] = [];
        const listening = onHostMessage(message => heard.push(message));
        const send = (message: unknown) => bridge.listeners.forEach(listener => listener(message));
        send({ type: 'shapes.tile', data: new ArrayBuffer(4) });
        send({ type: 'chat.event' });
        send({ type: 'dialogram.svg.request' });
        send({ action: { kind: 'setModel' } }); // GLSP's: no type
        listening.dispose();
        send({ type: 'shapes.tile' });
        expect(heard).toHaveLength(1);
        expect((heard[0] as any).type).toBe('shapes.tile');
    });

    it('reserve exactly the platform\'s prefixes', () => {
        expect(isReservedMessageType('dialogram.x')).toBe(true);
        expect(isReservedMessageType('chat.x')).toBe(true);
        expect(isReservedMessageType('dialogramx')).toBe(false);
        expect(isReservedMessageType('product.chat.x')).toBe(false);
    });
});
