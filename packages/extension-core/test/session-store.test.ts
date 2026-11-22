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

    it('reads again only what was added, and sees a delete', async () => {
        const store = new FileSessionStore(root());
        const other = new FileSessionStore(root());
        await store.create(session('ses_a'));
        expect((await store.read(FILE, 'ses_a'))?.messages).toEqual([]);
        await other.append(FILE, 'ses_a', { t: 'message', message: message('from the other') });
        expect((await store.read(FILE, 'ses_a'))?.messages.map((m) => m.content)).toEqual(['from the other']);

        await other.remove(FILE, 'ses_a');
        expect(await store.read(FILE, 'ses_a')).toBeUndefined();
    });

    it('does not make again a session deleted, by any create (an old copy moved again)', async () => {
        const store = new FileSessionStore(root());
        expect(await store.create(session('ses_a', FILE, { messages: [message('kept')] }))).toBe(true);
        await new FileSessionStore(root()).remove(FILE, 'ses_a');
        expect(await store.create(session('ses_a', FILE, { messages: [message('kept')] }))).toBe(false);
        expect(await store.has(FILE, 'ses_a')).toBe(false);
        expect(await store.list(FILE)).toEqual([]);
    });

    it("keeps a line of over 512 KiB whole beside another window's appends", async () => {
        const here = new FileSessionStore(root());
        const there = new FileSessionStore(root());
        await here.create(session('ses_a'));
        const huge = 'y'.repeat(1_500_000);
        await Promise.all([
            here.append(FILE, 'ses_a', { t: 'message', message: message(huge, 'huge') }),
            ...Array.from({ length: 20 }, (_, n) => there.append(FILE, 'ses_a', { t: 'message', message: message(String(n)) })),
        ]);
        const kept = await new FileSessionStore(root()).read(FILE, 'ses_a');
        expect(kept?.messages).toHaveLength(21);
        expect(kept?.messages.find((m) => m.key === 'huge')?.content).toBe(huge);
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

    it('leaves no file behind when a session cannot be written whole, and takes an empty one as no session', async () => {
        const store = new FileSessionStore(root());
        const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
        try {
            await expect(store.create(session('ses_a'))).rejects.toThrow(/ENOSPC/);
        } finally {
            write.mockRestore();
        }
        expect(await store.has(FILE, 'ses_a')).toBe(false);
        const { names } = await sessionFiles();
        expect(names).toEqual([]);
        await store.create(session('ses_a'));
        expect(await store.read(FILE, 'ses_a')).toMatchObject({ id: 'ses_a' });

        // One left empty by a crash: not taken as kept.
        await store.create(session('ses_b'));
        const files = await sessionFiles();
        const b = files.names.find((n) => n.startsWith('ses_b-'))!;
        await fs.writeFile(path.join(files.dir, b), '');
        await expect(new FileSessionStore(root()).create(session('ses_b'))).rejects.toThrow(/holds no chat session/);
    });

    it('reads again from the start a file made again in place (its inode reused)', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a', FILE, { messages: [message('old')] }));
        expect((await store.read(FILE, 'ses_a'))?.messages.map((m) => m.content)).toEqual(['old']);
        const { dir, names } = await sessionFiles();
        const file = path.join(dir, names[0]);
        const before = await fs.stat(file);
        // Another create's file, written over this one's inode, longer than what was read.
        const other = new FileSessionStore(path.join(root(), 'other'));
        await other.create(session('ses_a', FILE, { name: 'again', messages: [message('new one, long enough to pass what was read')] }));
        const [otherDir] = await fs.readdir(path.join(root(), 'other'));
        const [otherName] = await fs.readdir(path.join(root(), 'other', otherDir));
        await fs.writeFile(file, await fs.readFile(path.join(root(), 'other', otherDir, otherName)));
        expect((await fs.stat(file)).ino).toBe(before.ino);

        const kept = await store.read(FILE, 'ses_a');
        expect(kept).toMatchObject({ name: 'again' });
        expect(kept?.messages.map((m) => m.content)).toEqual(['new one, long enough to pass what was read']);
    });

    it('gives messages in the order they were made, not the order they were kept', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a'));
        await store.append(FILE, 'ses_a', { t: 'message', message: { ...message('second'), timestamp: 20 } });
        await store.append(FILE, 'ses_a', { t: 'message', message: { ...message('first'), timestamp: 10 } });
        await store.append(FILE, 'ses_a', { t: 'message', message: { ...message('also at 20'), timestamp: 20 } });
        expect((await store.read(FILE, 'ses_a'))?.messages.map((m) => m.content)).toEqual(['first', 'second', 'also at 20']);
    });

    it('takes its mark back when a session could not be removed, so it can be kept again', async () => {
        const store = new FileSessionStore(root());
        await store.create(session('ses_a'));
        const rm = fs.rm;
        const spy = vi.spyOn(fs, 'rm').mockImplementation(async (target: any, options?: any) => {
            if (String(target).endsWith('.jsonl')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
            return rm(target, options);
        });
        try {
            await expect(store.remove(FILE, 'ses_a')).rejects.toThrow(/EBUSY/);
        } finally {
            spy.mockRestore();
        }
        const { names } = await sessionFiles();
        expect(names.some((n) => n.endsWith('.gone'))).toBe(false);
        expect(await store.create(session('ses_a', FILE, { messages: [message('still here')] }))).toBe(true);
    });

    it('does not keep a session deleted while it was being placed', async () => {
        const store = new FileSessionStore(root());
        const other = new FileSessionStore(root());
        const link = fs.link;
        const spy = vi.spyOn(fs, 'link').mockImplementation(async (from: any, to: any) => {
            // Deleted in another window after the check, before the file is in place.
            await other.remove(FILE, 'ses_a');
            return link(from, to);
        });
        try {
            expect(await store.create(session('ses_a'))).toBe(false);
        } finally {
            spy.mockRestore();
        }
        expect(await store.has(FILE, 'ses_a')).toBe(false);
    });
});
