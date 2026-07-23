/**
 * Thin client for opencode's HTTP API.
 *
 * The chat talks to opencode over ACP (stdio), but a few capabilities — most
 * notably session revert / unrevert and listing messages with their stable
 * opencode IDs — are only exposed over opencode's HTTP API, not ACP. Since
 * `opencode acp` also serves the full HTTP API (we spawn it with a known
 * `--port`), we drive those operations here against that same process, so they
 * share session state and file snapshots with the ACP connection.
 *
 * Routes (opencode 1.17.x, confirmed via the server's /doc OpenAPI):
 *   GET  /session/{id}/message   -> [{ info: { id, role, ... }, parts: [...] }]
 *   POST /session/{id}/revert    -> body { messageID }
 *   POST /session/{id}/unrevert
 *   GET  /session/{id}           -> { ..., revert?: { messageID, ... } }
 */

export interface OpencodeMessageInfo {
  id: string;
  role: string;
  [key: string]: unknown;
}

export interface OpencodeMessage {
  /** opencode message id (e.g. "msg_..."). */
  id: string;
  role: string;
  /** Concatenated text of the message's text parts (used to align with the UI). */
  text: string;
}

export class OpencodeHttpClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * List a session's messages with their opencode ids, in order. Returns a
   * flattened `{ id, role }[]` — enough to map a chat turn to a revert target.
   */
  async listMessages(sessionId: string): Promise<OpencodeMessage[]> {
    const data = await this.request<Array<{ info?: OpencodeMessageInfo; parts?: Array<{ type?: string; text?: string }> }>>(
      'GET',
      `/session/${encodeURIComponent(sessionId)}/message`
    );
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .filter((entry) => !!entry?.info && typeof entry.info.id === 'string')
      .map((entry) => {
        const info = entry.info as OpencodeMessageInfo;
        const text = (entry.parts ?? [])
          .filter((p) => p?.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('')
          .trim();
        return { id: info.id, role: typeof info.role === 'string' ? info.role : 'assistant', text };
      });
  }

  /**
   * Revert the session to before `messageID` — undoes that message, every later
   * message, and the file changes they made (opencode restores snapshots).
   */
  async revert(sessionId: string, messageID: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionId)}/revert`, { messageID });
  }

  /** Restore whatever the most recent revert undid. */
  async unrevert(sessionId: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionId)}/unrevert`);
  }

  /**
   * Whether the session is currently in a reverted state (drives the redo
   * affordance). opencode marks this with a `revert` object on the session.
   */
  async isReverted(sessionId: string): Promise<boolean> {
    try {
      const session = await this.request<{ revert?: { messageID?: string } }>(
        'GET',
        `/session/${encodeURIComponent(sessionId)}`
      );
      return !!session?.revert?.messageID;
    } catch {
      return false;
    }
  }

  private async request<T = unknown>(method: 'GET' | 'POST', pathName: string, body?: unknown): Promise<T> {
    // The HTTP server comes up alongside the ACP process; on the very first call
    // it may briefly not be listening yet. Retry a few times before failing.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${pathName}`, {
          method,
          headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`opencode HTTP ${method} ${pathName} -> ${response.status} ${text}`.trim());
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (error) {
        lastError = error;
        // Only the connection-not-ready case is worth retrying.
        const message = error instanceof Error ? error.message : String(error);
        if (!/ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up/i.test(message)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
