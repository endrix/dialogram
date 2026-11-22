import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionData } from './session-manager.js';

/**
 * The folder Dialogram keeps its own data in, on the machine its extension
 * host runs on: the machine with the files and the agent, which in a
 * Remote-SSH window is the remote one.
 *
 * It is the agent's convention (opencode keeps its sessions in
 * `$XDG_DATA_HOME/opencode`), so a local window and an SSH window on the same
 * folder, for the same user, find the same chats, as they find the same agent
 * sessions. `DIALOGRAM_DATA_DIR` overrides it (tests, a scratch profile).
 */
export function dialogramDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.DIALOGRAM_DATA_DIR) return env.DIALOGRAM_DATA_DIR;
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'dialogram');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'dialogram');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'dialogram');
}

/** The folder a product's chats are kept in. */
export function chatSessionRoot(productKey: string, dataDir: string = dialogramDataDir()): string {
  return path.join(dataDir, 'chat', fileSafe(productKey));
}

/**
 * A change to a stored session: given the copy kept now (undefined when none
 * is), the session to keep, or undefined to leave the store as it is.
 */
export type SessionChange = (stored: SessionData | undefined) => SessionData | undefined;

/** Where a product's chat sessions are kept. */
export interface SessionStore {
  /** The sessions kept for one diagram file. */
  list(workflowFile: string): Promise<SessionData[]>;
  /** One session as kept now, or undefined when none is (deleted, or never kept). */
  read(workflowFile: string, sessionId: string): Promise<SessionData | undefined>;
  /**
   * Apply a change to the copy kept now, with no other change to it, from
   * this window or another, in between. Resolves with what was kept.
   */
  update(workflowFile: string, sessionId: string, change: SessionChange): Promise<SessionData | undefined>;
  remove(workflowFile: string, sessionId: string): Promise<void>;
  /** Resolves once every change asked for so far has landed. */
  idle(): Promise<void>;
}

/** How long a change waits for another window's lock on a session. */
const LOCK_WAIT_MS = 3000;
/** A lock this old was left by a window that died holding it. */
const LOCK_STALE_MS = 10000;

/**
 * One JSON file per session, in a folder per diagram file:
 * `<root>/<file name>-<hash of its path>/<session id>-<hash of it>.json`.
 *
 * Two windows on the same folder (a local one and an SSH one) run two
 * extension hosts on the same machine, both on these files. A change is a
 * read, an edit and a write of the copy kept now, under a lock (a folder made
 * beside the file) that the other window's changes wait for, so neither
 * overwrites what the other added. A file is written whole and renamed into
 * place, so a window that reads it never sees half of one. Folders are the
 * user's alone (0700), as chats can hold anything.
 */
export class FileSessionStore implements SessionStore {
  /** The last change of each file, so this window's land in the order made. */
  private readonly tails = new Map<string, Promise<unknown>>();
  private tmpCounter = 0;

  constructor(readonly root: string) {}

  async list(workflowFile: string): Promise<SessionData[]> {
    const dir = this.dirFor(workflowFile);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const sessions: SessionData[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const session = await this.readFile(path.join(dir, name), workflowFile);
        if (session) sessions.push(session);
      } catch (error) {
        // One entry that cannot be read leaves the others listed.
        console.warn(`Skipped the chat session file ${path.join(dir, name)}:`, error);
      }
    }
    return sessions;
  }

  async read(workflowFile: string, sessionId: string): Promise<SessionData | undefined> {
    const session = await this.readFile(this.fileFor(workflowFile, sessionId), workflowFile);
    return session?.id === sessionId ? session : undefined;
  }

  update(workflowFile: string, sessionId: string, change: SessionChange): Promise<SessionData | undefined> {
    const file = this.fileFor(workflowFile, sessionId);
    return this.enqueue(file, () =>
      this.withLock(file, async () => {
        const stored = await this.read(workflowFile, sessionId);
        const next = change(stored);
        if (next) await this.writeFile(file, next);
        return next;
      }),
    );
  }

  /** Keep this session as it is now, whatever is kept. */
  write(session: SessionData): Promise<SessionData | undefined> {
    const copy = structuredClone(session);
    return this.update(session.workflowFile, session.id, () => copy);
  }

  async remove(workflowFile: string, sessionId: string): Promise<void> {
    const file = this.fileFor(workflowFile, sessionId);
    await this.enqueue(file, () => this.withLock(file, () => fs.rm(file, { force: true })));
  }

  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.allSettled([...this.tails.values()]);
    }
  }

  private enqueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(file, next);
    next
      .catch(() => undefined)
      .then(() => {
        if (this.tails.get(file) === next) this.tails.delete(file);
      });
    return next;
  }

  /** Run an operation on a session file while no other window changes it. */
  private async withLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!held) {
      try {
        await fs.mkdir(lock);
        held = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        const age = await fs.stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
        // A lock held this long is a window stuck mid-write: go on without it.
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    try {
      return await operation();
    } finally {
      if (held) await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async writeFile(file: string, session: SessionData): Promise<void> {
    const tmp = `${file}.${process.pid}.${++this.tmpCounter}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readFile(file: string, workflowFile: string): Promise<SessionData | undefined> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      const session = JSON.parse(text) as SessionData;
      // A file that isn't a session of this diagram is skipped, not shown.
      if (
        typeof session?.id !== 'string' ||
        session.workflowFile !== workflowFile ||
        !Array.isArray(session.messages)
      ) {
        return undefined;
      }
      return session;
    } catch {
      return undefined;
    }
  }

  private dirFor(workflowFile: string): string {
    return path.join(this.root, `${fileSafe(path.basename(workflowFile))}-${hash(workflowFile, 16)}`);
  }

  /** The id's readable part, lower case, and its hash: ids that differ by case
   *  only stay two files where the file system ignores case (macOS, Windows). */
  private fileFor(workflowFile: string, sessionId: string): string {
    return path.join(this.dirFor(workflowFile), `${fileSafe(sessionId.toLowerCase())}-${hash(sessionId, 12)}.json`);
  }
}

function hash(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || '_';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
