import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../src/extension/session-manager.js';
import { FileSessionStore, chatSessionRoot, dialogramDataDir } from '../src/extension/session-store.js';

const FILE = '/w/flow.py';

function session(id: string, workflowFile = FILE, extra: Partial<SessionData> = {}): SessionData {
    return { id, name: id, workflowFile, createdAt: 1, updatedAt: 1, mode: 'build', messages: [], ...extra };
}

const message = (content: string, key = content) => ({ role: 'user' as const, content, timestamp: 1, key });

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
    const sessionFiles = async () => {
        const [dir] = await fs.readdir(root());
        return { dir: path.join(root(), dir), names: (await fs.readdir(path.join(root(), dir))).sort() };
    };

    it("keeps a diagram's sessions, each in its own file, the user's alone", async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a'));
        await store.create(session('ses_b'));
        await store.create(session('ses_c', '/w/other.py'));

        expect((await store.list(FILE)).map((s) => s.id).sort()).toEqual(['ses_a', 'ses_b']);
        expect((await store.list('/w/other.py')).map((s) => s.id)).toEqual(['ses_c']);
        expect(await store.list('/w/none.py')).toEqual([]);

        const dir = (await fs.readdir(root())).find((d) => d.startsWith('flow.py-'))!;
        const names = (await fs.readdir(path.join(root(), dir))).sort();
        expect(names).toHaveLength(2);
        expect(names[0]).toMatch(/^ses_a-[0-9a-f]{12}\.jsonl$/);
        if (process.platform !== 'win32') {
            expect((await fs.stat(path.join(root(), dir))).mode & 0o777).toBe(0o700);
            expect((await fs.stat(path.join(root(), dir, names[0]))).mode & 0o777).toBe(0o600);
        }
    });

    it('adds each change as a line, folded back into the session, a message once', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a', FILE, { messages: [message('kept with it')] }));
        expect(await store.append(FILE, 'ses_a', { t: 'message', message: message('first') })).toBe(true);
        await store.append(FILE, 'ses_a', { t: 'message', message: message('first') });
        await store.append(FILE, 'ses_a', { t: 'name', name: 'Review' });
        await store.append(FILE, 'ses_a', { t: 'mode', mode: 'plan' });

        const kept = await store.read(FILE, 'ses_a');
        expect(kept?.messages.map((m) => m.content)).toEqual(['kept with it', 'first']);
        expect(kept).toMatchObject({ name: 'Review', mode: 'plan' });
        expect(kept!.updatedAt).toBeGreaterThan(1);
        const { dir, names } = await sessionFiles();
        expect((await fs.readFile(path.join(dir, names[0]), 'utf8')).trim().split('\n')).toHaveLength(6);
    });

    it("keeps every window's appends, from two stores at once", async () => {
        const here = new FileSessionStore(root());
        const there = new FileSessionStore(root());
        await here.create(session('ses_a'));
        // A long message too: one write each, kept whole.
        const long = 'x'.repeat(200_000);
        await Promise.all(Array.from({ length: 40 }, (_, n) =>
            (n % 2 ? there : here).append(FILE, 'ses_a', { t: 'message', message: message(n === 7 ? long : String(n), String(n)) })
        ));
        const kept = await new FileSessionStore(root()).read(FILE, 'ses_a');
        expect(kept?.messages.map((m) => m.key).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 40 }, (_, n) => String(n)));
        expect(kept?.messages.find((m) => m.key === '7')?.content).toBe(long);
    });

    it('reads again only what was added, and sees a file made again after a delete', async () => {
        const store = new FileSessionStore(root());
        const other = new FileSessionStore(root());
        await store.create(session('ses_a'));
        expect((await store.read(FILE, 'ses_a'))?.messages).toEqual([]);
        await other.append(FILE, 'ses_a', { t: 'message', message: message('from the other') });
        expect((await store.read(FILE, 'ses_a'))?.messages.map((m) => m.content)).toEqual(['from the other']);

        await other.remove(FILE, 'ses_a');
        expect(await store.read(FILE, 'ses_a')).toBeUndefined();
        await other.create(session('ses_a', FILE, { name: 'again' }));
        expect(await store.read(FILE, 'ses_a')).toMatchObject({ name: 'again', messages: [] });
    });

    it('does not make again a session deleted in another window', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a'));
        await new FileSessionStore(root()).remove(FILE, 'ses_a');
        expect(await store.append(FILE, 'ses_a', { t: 'message', message: message('late') })).toBe(false);
        expect(await store.has(FILE, 'ses_a')).toBe(false);
        expect(await store.list(FILE)).toEqual([]);
    });

    it('keeps one already kept as it is on create, adding the keyed messages it lacks', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a', FILE, { name: 'kept', messages: [message('a')] }));
        await store.create(session('ses_a', FILE, { name: 'other copy', messages: [message('a'), message('b')] }));
        expect(await store.read(FILE, 'ses_a')).toMatchObject({ name: 'kept' });
        expect((await store.read(FILE, 'ses_a'))?.messages.map((m) => m.content)).toEqual(['a', 'b']);
    });

    it('skips a line left half written, and says a file that is no session cannot be read', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a'));
        await store.create(session('ses_b'));
        const { dir, names } = await sessionFiles();
        await fs.appendFile(path.join(dir, names[0]), '{"at":2,"t":"message","mess');
        expect((await store.read(FILE, 'ses_a'))?.messages).toEqual([]);
        await fs.writeFile(path.join(dir, names[1]), 'not a session\n');
        await expect(store.read(FILE, 'ses_b')).rejects.toThrow(/does not start with a chat session/);
        expect(await store.has(FILE, 'ses_b')).toBe(true);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect((await store.list(FILE)).map((s) => s.id)).toEqual(['ses_a']);
        } finally {
            warn.mockRestore();
        }
    });

    it('gives each id its own file: one that is no file name, and ids that differ by case only', async () => {
        const store = new FileSessionStore(root());
        for (const id of ['../../escape', 'a/b', 'ses_Ab', 'ses_aB']) await store.create(session(id));
        expect((await store.list(FILE)).map((s) => s.id).sort()).toEqual(['../../escape', 'a/b', 'ses_Ab', 'ses_aB']);
        expect(await fs.readdir(root())).toHaveLength(1);
        const { names } = await sessionFiles();
        // Distinct even where the file system ignores case (macOS, Windows).
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(4);
        expect(await store.read(FILE, 'ses_Ab')).toMatchObject({ id: 'ses_Ab' });
    });
});
