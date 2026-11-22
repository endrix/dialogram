import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageData, SessionData } from './session-manager.js';

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

/** One change to a kept session. */
export type SessionChange =
  | { t: 'message'; message: MessageData }
  | { t: 'name'; name: string }
  | { t: 'mode'; mode: 'plan' | 'build' };

/** Where a product's chat sessions are kept. */
export interface SessionStore {
  /** The sessions kept for one diagram file; one that cannot be read is skipped. */
  list(workflowFile: string): Promise<SessionData[]>;
  /** One session as kept now; undefined when none is. Throws when it cannot be read. */
  read(workflowFile: string, sessionId: string): Promise<SessionData | undefined>;
  /** Whether a session is kept (deleted, or never kept, when not). */
  has(workflowFile: string, sessionId: string): Promise<boolean>;
  /**
   * Keep a session whole. One already kept is kept as it is, with this
   * copy's keyed messages it lacks added.
   */
  create(session: SessionData): Promise<void>;
  /** Add a change to a kept session; false when none is kept (deleted). */
  append(workflowFile: string, sessionId: string, change: SessionChange): Promise<boolean>;
  remove(workflowFile: string, sessionId: string): Promise<void>;
}

/** A line of a session's file. */
type Line =
  | ({ t: 'session' } & Omit<SessionData, 'messages' | 'updatedAt'> & { updatedAt?: number })
  | { t: 'messages'; at: number; messages: MessageData[] }
  | ({ at: number } & SessionChange);

/** What has been read of a session's file, so a later read reads only what was added. */
interface Read {
  ino: number;
  /** Bytes read, to the end of the last whole line. */
  consumed: number;
  session: SessionData;
  keys: Set<string>;
}

/**
 * One file per session, in a folder per diagram file:
 * `<root>/<file name>-<hash of its path>/<session id, lower case>-<hash of it>.jsonl`.
 *
 * The first line is the session; every change after it (a message, a
 * rename, a mode) is one more line, added with an append. Two windows on the
 * same folder (a local one and an SSH one) run two extension hosts on the
 * same machine, both on these files: an append never rewrites what is there,
 * and the system keeps two windows' appends whole and in turn, so neither
 * loses what the other added. An append opens the file without creating it,
 * so a session deleted in one window is not made again by the other. A line
 * left half written is skipped. Folders and files are the user's alone, as
 * chats can hold anything.
 */
export class FileSessionStore implements SessionStore {
  private readonly reads = new Map<string, Read>();

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
      if (!name.endsWith('.jsonl')) continue;
      try {
        const session = await this.readFile(path.join(dir, name), workflowFile);
        if (session) sessions.push(session);
      } catch (error) {
        // One that cannot be read leaves the others listed.
        console.warn(`Skipped the chat session file ${path.join(dir, name)}:`, error);
      }
    }
    return sessions;
  }

  async read(workflowFile: string, sessionId: string): Promise<SessionData | undefined> {
    const session = await this.readFile(this.fileFor(workflowFile, sessionId), workflowFile);
    if (session && session.id !== sessionId) {
      throw new Error(`${this.fileFor(workflowFile, sessionId)} holds session ${session.id}, not ${sessionId}`);
    }
    return session;
  }

  async has(workflowFile: string, sessionId: string): Promise<boolean> {
    try {
      await fs.stat(this.fileFor(workflowFile, sessionId));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async create(session: SessionData): Promise<void> {
    const file = this.fileFor(session.workflowFile, session.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const { messages, ...head } = session;
    const lines: Line[] = [{ t: 'session', ...head }];
    if (messages.length > 0) lines.push({ t: 'messages', at: session.updatedAt, messages });
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const kept = await this.read(session.workflowFile, session.id);
      if (!kept) return;
      const have = new Set(kept.messages.map((m) => m.key).filter(Boolean));
      const lacking = messages.filter((m) => m.key && !have.has(m.key));
      if (lacking.length > 0) await this.appendLine(file, { t: 'messages', at: Date.now(), messages: lacking });
      return;
    }
    try {
      await handle.writeFile(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    } finally {
      await handle.close();
    }
  }

  append(workflowFile: string, sessionId: string, change: SessionChange): Promise<boolean> {
    return this.appendLine(this.fileFor(workflowFile, sessionId), { at: Date.now(), ...change });
  }

  async remove(workflowFile: string, sessionId: string): Promise<void> {
    const file = this.fileFor(workflowFile, sessionId);
    this.reads.delete(file);
    await fs.rm(file, { force: true });
  }

  /** Add a line to a session's file, which must be there; false when it is not. */
  private async appendLine(file: string, line: Line): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      // No O_CREAT: a file another window deleted stays deleted.
      handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    try {
      // One write: the system keeps it whole between two windows' appends.
      await handle.writeFile(Buffer.from(JSON.stringify(line) + '\n'));
    } finally {
      await handle.close();
    }
    return true;
  }

  /**
   * A session's file folded into the session, reading only what was added
   * since the last read. Undefined when there is no file, or its first line
   * is still being written; throws when the first line is not a session.
   */
  private async readFile(file: string, workflowFile: string): Promise<SessionData | undefined> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'r');
    } catch (error) {
      if (isNotFound(error)) {
        this.reads.delete(file);
        return undefined;
      }
      throw error;
    }
    try {
      const { ino, size } = await handle.stat();
      let known = this.reads.get(file);
      if (known && (known.ino !== ino || size < known.consumed)) known = undefined;
      const from = known?.consumed ?? 0;
      if (known && size === from) return structuredClone(known.session);
      const buffer = Buffer.alloc(size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0 && !known) return undefined;
      const lines = end < 0 ? [] : text.slice(0, end).split('\n');
      let read = known;
      for (const [index, raw] of lines.entries()) {
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          if (!read && index === 0) throw new Error(`${file} does not start with a chat session`);
          console.warn(`Skipped a line of ${file} that is not whole`);
          continue;
        }
        if (!read) {
          if (line.t !== 'session' || typeof line.id !== 'string' || line.workflowFile !== workflowFile) {
            throw new Error(`${file} does not start with a chat session of ${workflowFile}`);
          }
          const { t: _t, ...head } = line;
          read = {
            ino,
            consumed: 0,
            session: { ...head, updatedAt: head.updatedAt ?? head.createdAt, messages: [] },
            keys: new Set(),
          };
          continue;
        }
        apply(read, line);
      }
      if (!read) return undefined;
      read.consumed = from + Buffer.byteLength(text.slice(0, end + 1), 'utf8');
      this.reads.set(file, read);
      return structuredClone(read.session);
    } finally {
      await handle.close();
    }
  }

  private dirFor(workflowFile: string): string {
    return path.join(this.root, `${fileSafe(path.basename(workflowFile))}-${hash(workflowFile, 16)}`);
  }

  /** The id's readable part, lower case, and its hash: ids that differ by case
   *  only stay two files where the file system ignores case (macOS, Windows). */
  private fileFor(workflowFile: string, sessionId: string): string {
    return path.join(this.dirFor(workflowFile), `${fileSafe(sessionId.toLowerCase())}-${hash(sessionId, 12)}.jsonl`);
  }
}

/** Fold one change line into what has been read; a message is kept once. */
function apply(read: Read, line: Line): void {
  const session = read.session;
  const add = (message: MessageData) => {
    if (message.key) {
      if (read.keys.has(message.key)) return;
      read.keys.add(message.key);
    }
    session.messages.push(message);
  };
  switch (line.t) {
    case 'message':
      add(line.message);
      break;
    case 'messages':
      for (const message of line.messages) add(message);
      break;
    case 'name':
      session.name = line.name;
      break;
    case 'mode':
      session.mode = line.mode;
      break;
    default:
      return;
  }
  if (typeof line.at === 'number') session.updatedAt = Math.max(session.updatedAt, line.at);
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
