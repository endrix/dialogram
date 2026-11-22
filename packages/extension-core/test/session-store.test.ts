import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionData } from '../src/extension/session-manager.js';
import { FileSessionStore, chatSessionRoot, dialogramDataDir } from '../src/extension/session-store.js';

function session(id: string, workflowFile = '/w/flow.py', extra: Partial<SessionData> = {}): SessionData {
    return { id, name: id, workflowFile, createdAt: 1, updatedAt: 1, mode: 'build', messages: [], ...extra };
}

describe('the folder Dialogram keeps its data in', () => {
    it("is the agent's, on the machine the extension host runs on", () => {
        expect(dialogramDataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/dialogram');
        expect(dialogramDataDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe('/data/dialogram');
        expect(dialogramDataDir({}, 'darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/dialogram');
        expect(dialogramDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(path.join('C:\\L', 'dialogram'));
    });

    it('is DIALOGRAM_DATA_DIR when set', () => {
        expect(dialogramDataDir({ DIALOGRAM_DATA_DIR: '/scratch', XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe('/scratch');
    });

    it("keeps each product's chats apart", () => {
        expect(chatSessionRoot('wfpy', '/d')).toBe(path.join('/d', 'chat', 'wfpy'));
        expect(chatSessionRoot('../x', '/d')).toBe(path.join('/d', 'chat', '__x'));
    });
});

describe('FileSessionStore', () => {
    const root = () => process.env.DIALOGRAM_DATA_DIR!;

    it("keeps a diagram's sessions, each in its own file, the user's alone", async () => {
        const store = new FileSessionStore(root());
        await store.write(session('ses_a'));
        await store.write(session('ses_b'));
        await store.write(session('ses_c', '/w/other.py'));

        expect((await store.list('/w/flow.py')).map((s) => s.id).sort()).toEqual(['ses_a', 'ses_b']);
        expect((await store.list('/w/other.py')).map((s) => s.id)).toEqual(['ses_c']);
        expect(await store.list('/w/none.py')).toEqual([]);

        const [dir] = (await fs.readdir(root())).filter((d) => d.startsWith('flow.py-'));
        expect((await fs.readdir(path.join(root(), dir))).sort()).toEqual(['ses_a.json', 'ses_b.json']);
        if (process.platform !== 'win32') {
            expect((await fs.stat(path.join(root(), dir))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(path.join(root(), dir, 'ses_a.json'))).mode & 0o777).toBe(0o600);
        }
    });

    it('lands writes and a removal in the order asked, the last one winning', async () => {
        const store = new FileSessionStore(root());
        const writes = [1, 2, 3, 4, 5].map((n) => store.write(session('ses_a', '/w/flow.py', { updatedAt: n })));
        await Promise.all(writes);
        expect((await store.read('/w/flow.py', 'ses_a'))?.updatedAt).toBe(5);

        void store.write(session('ses_a', '/w/flow.py', { updatedAt: 6 }));
        void store.remove('/w/flow.py', 'ses_a');
        await store.idle();
        expect(await store.read('/w/flow.py', 'ses_a')).toBeUndefined();
    });

    it('takes the content as it was when the write was asked', async () => {
        const store = new FileSessionStore(root());
        const s = session('ses_a');
        const pending = store.write(s);
        s.messages.push({ role: 'user', content: 'later', timestamp: 2 });
        await pending;
        expect((await store.read('/w/flow.py', 'ses_a'))?.messages).toEqual([]);
    });

    it("skips a file that isn't a session of the diagram, and leaves no temporary file", async () => {
        const store = new FileSessionStore(root());
        await store.write(session('ses_a'));
        const [dir] = await fs.readdir(root());
        await fs.writeFile(path.join(root(), dir, 'broken.json'), '{ not json');
        await fs.writeFile(path.join(root(), dir, 'other.json'), JSON.stringify(session('other', '/w/elsewhere.py')));

        expect((await store.list('/w/flow.py')).map((s) => s.id)).toEqual(['ses_a']);
        expect((await fs.readdir(path.join(root(), dir))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('names the file of an id that is no file name by its hash', async () => {
        const store = new FileSessionStore(root());
        await store.write(session('../../escape'));
        await store.write(session('a/b'));
        expect((await store.list('/w/flow.py')).map((s) => s.id).sort()).toEqual(['../../escape', 'a/b']);
        expect(await fs.readdir(root())).toHaveLength(1);
        expect(await store.read('/w/flow.py', '../../escape')).toMatchObject({ id: '../../escape' });
    });
});
