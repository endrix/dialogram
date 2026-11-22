import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
        const files = (await fs.readdir(path.join(root(), dir))).sort();
        expect(files).toHaveLength(2);
        expect(files[0]).toMatch(/^ses_a-[0-9a-f]{12}\.json$/);
        expect(files[1]).toMatch(/^ses_b-[0-9a-f]{12}\.json$/);
        if (process.platform !== 'win32') {
            expect((await fs.stat(path.join(root(), dir))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(path.join(root(), dir, files[0]))).mode & 0o777).toBe(0o600);
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

    it('gives each id its own file: one that is no file name, and ids that differ by case only', async () => {
        const store = new FileSessionStore(root());
        for (const id of ['../../escape', 'a/b', 'ses_Ab', 'ses_aB']) await store.write(session(id));
        expect((await store.list('/w/flow.py')).map((s) => s.id).sort()).toEqual(['../../escape', 'a/b', 'ses_Ab', 'ses_aB']);
        expect(await fs.readdir(root())).toHaveLength(1);
        const [dir] = await fs.readdir(root());
        const names = await fs.readdir(path.join(root(), dir));
        // Distinct even where the file system ignores case (macOS, Windows).
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(4);
        expect(await store.read('/w/flow.py', 'ses_Ab')).toMatchObject({ id: 'ses_Ab' });
    });

    it('applies a change to the copy kept now, and one from another window waits its turn', async () => {
        const here = new FileSessionStore(root());
        const there = new FileSessionStore(root());
        await here.write(session('ses_a'));
        const add = (store: FileSessionStore, n: number) =>
            store.update('/w/flow.py', 'ses_a', (kept) => {
                kept!.messages.push({ role: 'user', content: String(n), timestamp: n, key: String(n) });
                return kept;
            });
        await Promise.all(Array.from({ length: 20 }, (_, n) => add(n % 2 ? there : here, n)));
        const kept = await here.read('/w/flow.py', 'ses_a');
        expect(kept?.messages.map((m) => Number(m.content)).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n));
    });

    it('waits for a lock another window holds, and keeps nothing when the change says so', async () => {
        const store = new FileSessionStore(root());
        await store.write(session('ses_a'));
        const [dir] = await fs.readdir(root());
        const [file] = (await fs.readdir(path.join(root(), dir))).filter((n) => n.endsWith('.json'));
        const lock = path.join(root(), dir, `${file}.lock`);
        await fs.mkdir(lock);
        let landed = false;
        const change = store.update('/w/flow.py', 'ses_a', (kept) => ({ ...kept!, name: 'renamed' })).then(() => { landed = true; });
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(landed).toBe(false);
        await fs.rm(lock, { recursive: true });
        await change;
        expect((await store.read('/w/flow.py', 'ses_a'))?.name).toBe('renamed');

        expect(await store.update('/w/flow.py', 'ses_b', () => undefined)).toBeUndefined();
        expect(await store.read('/w/flow.py', 'ses_b')).toBeUndefined();
    });

    it('lists the others when one entry cannot be read', async () => {
        const store = new FileSessionStore(root());
        await store.write(session('ses_a'));
        const [dir] = await fs.readdir(root());
        await fs.mkdir(path.join(root(), dir, 'odd.json'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect((await store.list('/w/flow.py')).map((s) => s.id)).toEqual(['ses_a']);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});
