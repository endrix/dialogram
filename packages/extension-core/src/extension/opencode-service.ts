/**
 * opencode 2's HTTP API, for what the chat needs beside ACP: a session's
 * message ids, revert / unrevert, and whether it is reverted.
 *
 * opencode 1.x served the HTTP API from the `opencode acp` process itself, on
 * a `--port` the chat pinned ({@link OpencodeHttpClient}). opencode 2 runs one
 * background service per user: `opencode acp` takes no `--port` and keeps its
 * sessions there, and the service asks for its password. `opencode api`
 * finds the service and signs in, so the chat goes through it rather than
 * reading opencode's own files.
 *
 * Routes (opencode 2.4, from the service's /openapi.json):
 *   GET    /api/session/{id}/message?order=asc&type=user  -> { data: [...], cursor: { next } }
 *   GET    /api/session/{id}                              -> { data: { ..., revert?: { messageID } } }
 *   POST   /api/session/{id}/revert/stage  { messageID, files: true }  (undoes the files too; a
 *                                          new prompt over ACP commits it, as on 1.x)
 *   DELETE /api/session/{id}/revert                       (restores what the stage undid)
 */

import { execFile } from 'node:child_process';
import type { OpencodeMessage, OpencodeSessionApi } from './opencode-http.js';

/** How an `opencode acp` serves its HTTP API: on a port it is given (1.x), through the user's
 *  service (2), or not that the chat can tell ('none': it starts with no flags, undo off). */
export type OpencodeHttpFlavour = 'own-port' | 'service' | 'none';

/** Reads an `opencode acp` command line's flavour. */
export type OpencodeFlavourProbe = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<OpencodeHttpFlavour>;

/** The output of `command args`, or undefined when it cannot be run or prints nothing. */
function readOutput(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = execFile(command, args, { env, timeout: 15_000, maxBuffer: 1 << 20 }, (_error, stdout, stderr) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        resolve(text ? text : undefined);
      });
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Whether this `opencode acp` takes `--port` (1.x: an option line in its
 * `--help`) or not (2). A help that cannot be read falls back on
 * `opencode --version`; when neither tells, 'none': the chat starts without
 * the flags, which both versions accept, and leaves undo off rather than
 * running an `opencode api` that 1.x does not have.
 */
export const probeOpencodeFlavour: OpencodeFlavourProbe = async (command, args, env) => {
  const help = await readOutput(command, [...args, '--help'], env);
  if (help !== undefined && /\bacp\b|Agent Client Protocol/i.test(help)) {
    return /^\s*--port\b/m.test(help) ? 'own-port' : 'service';
  }
  const version = /(\d+)\.\d+\.\d+/.exec((await readOutput(command, ['--version'], env)) ?? '');
  if (!version) return 'none';
  return Number(version[1]) >= 2 ? 'service' : 'own-port';
};

export interface ApiResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `opencode api <args...>`. */
export type OpencodeApiRunner = (args: string[]) => Promise<ApiResult>;

const API_TIMEOUT_MS = 10_000;

/** The runner for an opencode binary: `<command> api ...`, in the chat's environment. */
export function opencodeApiRunner(command: string, env: NodeJS.ProcessEnv, cwd?: string): OpencodeApiRunner {
  return (args) =>
    new Promise((resolve) => {
      try {
        // A short bound: the chat waits on these to show a session's history.
        const child = execFile(command, ['api', ...args], { env, cwd, timeout: API_TIMEOUT_MS, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || error?.message || '') });
        });
        child.stdin?.end();
      } catch (error) {
        resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      }
    });
}

/** A page is at most this many messages; a session longer than {@link MAX_PAGES} pages lists its first ones. */
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

interface V2UserMessage {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  files?: Array<{ mime?: unknown }>;
}

export class OpencodeServiceClient implements OpencodeSessionApi {
  constructor(private readonly run: OpencodeApiRunner) {}

  /** A session's user messages with their ids, oldest first. */
  async listMessages(sessionId: string): Promise<OpencodeMessage[]> {
    const base = `/api/session/${encodeURIComponent(sessionId)}/message`;
    const out: OpencodeMessage[] = [];
    const seen = new Set<string>();
    let path = `${base}?order=asc&type=user&limit=${PAGE_SIZE}`;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.request<{ data?: V2UserMessage[]; cursor?: { next?: string | null } }>('GET', path);
      const data = Array.isArray(body?.data) ? body.data : [];
      let fresh = 0;
      for (const message of data) {
        if (message?.type !== 'user' || typeof message.id !== 'string' || seen.has(message.id)) continue;
        seen.add(message.id);
        fresh++;
        const images = (message.files ?? []).filter((f) => String(f?.mime ?? '').startsWith('image/')).length;
        out.push({ id: message.id, role: 'user', text: String(message.text ?? '').trim(), ...(images > 0 ? { images } : {}) });
      }
      const next = body?.cursor?.next;
      // The last page still names a next cursor, which leads to an empty page.
      if (fresh === 0 || !next) break;
      path = `${base}?type=user&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(next)}`;
    }
    return out;
  }

  /** Revert the session to before `messageID`: that message, the later ones, and their file changes. */
  async revert(sessionId: string, messageID: string): Promise<void> {
    // `files: true`: undo the file changes too (the route only optionally does).
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/revert/stage`, { messageID, files: true });
  }

  /** Restore what the revert undid. */
  async unrevert(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}/revert`);
  }

  /** Whether the session holds a revert (until a new prompt commits it). */
  async isReverted(sessionId: string): Promise<boolean> {
    try {
      const body = await this.request<{ data?: { revert?: { messageID?: string } | null } }>(
        'GET',
        `/api/session/${encodeURIComponent(sessionId)}`,
      );
      return !!body?.data?.revert?.messageID;
    } catch {
      return false;
    }
  }

  private async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const result = await this.run([method, path, ...(body !== undefined ? ['--data', JSON.stringify(body)] : [])]);
    if (result.code !== 0) {
      throw new Error(`opencode api ${method} ${path} -> ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const text = result.stdout.trim();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
