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

/** Where a product's chat sessions are kept. */
export interface SessionStore {
  /** The sessions kept for one diagram file. */
  list(workflowFile: string): Promise<SessionData[]>;
  /** One session as kept now, or undefined when none is (deleted, or never kept). */
  read(workflowFile: string, sessionId: string): Promise<SessionData | undefined>;
  write(session: SessionData): Promise<void>;
  remove(workflowFile: string, sessionId: string): Promise<void>;
}

/**
 * One JSON file per session, in a folder per diagram file:
 * `<root>/<file name>-<hash of its path>/<session id>.json`.
 *
 * A file per session lets two windows on the same folder (a local one and an
 * SSH one) each write the session they are in without overwriting the
 * other's. A file is written whole and renamed into place, so a window that
 * reads it never sees half of one. Folders are the user's alone (0700), as
 * chats can hold anything.
 */
export class FileSessionStore implements SessionStore {
  /** The last write or removal of each file, so they land in the order made. */
  private readonly tails = new Map<string, Promise<void>>();
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
      const session = await this.readFile(path.join(dir, name), workflowFile);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async read(workflowFile: string, sessionId: string): Promise<SessionData | undefined> {
    const session = await this.readFile(this.fileFor(workflowFile, sessionId), workflowFile);
    return session?.id === sessionId ? session : undefined;
  }

  write(session: SessionData): Promise<void> {
    const file = this.fileFor(session.workflowFile, session.id);
    // The content as it is now, not when the queue reaches it.
    const body = JSON.stringify(session);
    return this.enqueue(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${++this.tmpCounter}.tmp`;
      try {
        await fs.writeFile(tmp, body, { mode: 0o600 });
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  remove(workflowFile: string, sessionId: string): Promise<void> {
    const file = this.fileFor(workflowFile, sessionId);
    return this.enqueue(file, () => fs.rm(file, { force: true }));
  }

  /** Resolves once every write and removal asked for so far has landed. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.allSettled([...this.tails.values()]);
    }
  }

  private enqueue(file: string, operation: () => Promise<void>): Promise<void> {
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
    const hash = createHash('sha256').update(workflowFile).digest('hex').slice(0, 16);
    return path.join(this.root, `${fileSafe(path.basename(workflowFile))}-${hash}`);
  }

  private fileFor(workflowFile: string, sessionId: string): string {
    const name = /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && !sessionId.startsWith('.')
      ? sessionId
      : createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.dirFor(workflowFile), `${name}.json`);
  }
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 64) || '_';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
